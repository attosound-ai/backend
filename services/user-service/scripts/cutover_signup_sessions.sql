-- Cutover migration for the signup-sessions refactor.
--
-- Run AFTER deploying the new user-service binary (the boot path drops
-- users.registration_status and creates the partial index on
-- signup_sessions). At that point the column is gone, so pending users
-- are no longer reachable by the app — they're orphan rows.
--
-- Behavior:
--   1. Show the rows about to be deleted (sanity check).
--   2. Cascade-delete: user_credentials has FK ON DELETE CASCADE in the
--      existing schema, so a plain DELETE on users handles credentials.
--   3. Report final counts.
--
-- Safe to re-run: the WHERE clauses match no rows on a second pass.

BEGIN;

-- 1. Audit what will be removed.
\echo '── Pending users about to be deleted ──'
SELECT id, username, email, display_name, created_at
FROM users
WHERE id IN (
  SELECT u.id
  FROM users u
  LEFT JOIN user_credentials c ON c.user_id = u.id
  WHERE
    -- after the boot-time DropColumn the next two predicates always pass,
    -- but they make this script safe to run BEFORE the new binary as well.
    -- Adjust as needed if you re-run mid-deploy.
    u.display_name IS NULL
    OR u.display_name = ''
    OR c.password_hash IS NULL
    OR c.password_hash = ''
    OR u.username LIKE '.%'              -- broken usernames like ".1234"
);

-- 2. Run the delete. user_credentials, follows, push_tokens, etc. cascade
--    via existing FKs. Anything that doesn't cascade (legacy posts in
--    social-service Postgres) is orphan-tolerant.
DELETE FROM users
WHERE id IN (
  SELECT u.id
  FROM users u
  LEFT JOIN user_credentials c ON c.user_id = u.id
  WHERE
    u.display_name IS NULL
    OR u.display_name = ''
    OR c.password_hash IS NULL
    OR c.password_hash = ''
    OR u.username LIKE '.%'
);

-- 3. Optional: also nuke any rows that were `pending` before the column
--    was dropped. This only matches if this script is run BEFORE the new
--    binary boots (i.e. you choose to do the data step first). Safe no-op
--    after the column is gone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'registration_status'
  ) THEN
    EXECUTE 'DELETE FROM users WHERE registration_status = ''pending''';
  END IF;
END $$;

\echo '── Post-delete totals ──'
SELECT count(*) AS users_remaining FROM users;
SELECT count(*) AS signup_sessions_remaining FROM signup_sessions;

COMMIT;
