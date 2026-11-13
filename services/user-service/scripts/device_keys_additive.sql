-- Remembered accounts (device keys), Nov 12 2026. Additive only: one new
-- table, nothing else changes. AutoMigrate creates the same table at startup
-- (models.DeviceKey); this file is for review or for creating it by hand
-- before the deploy. NOT applied anywhere yet.
CREATE TABLE IF NOT EXISTS device_keys (
    id                   uuid PRIMARY KEY,
    user_id              bigint      NOT NULL,
    public_key           bytea       NOT NULL,
    key_hash             varchar(64) NOT NULL,
    installation_id      varchar(64) NOT NULL,
    platform             varchar(10) NOT NULL,
    device_name          varchar(100) NOT NULL DEFAULT '',
    biometric            boolean     NOT NULL DEFAULT false,
    hardware             varchar(20) NOT NULL DEFAULT '',
    challenge_hash       varchar(64) NOT NULL DEFAULT '',
    challenge_expires_at timestamptz,
    bad_signatures       bigint      NOT NULL DEFAULT 0,
    created_at           timestamptz,
    last_used_at         timestamptz,
    updated_at           timestamptz,
    revoked_at           timestamptz,
    revoked_reason       varchar(32) NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_keys_key_hash ON device_keys (key_hash);
CREATE INDEX IF NOT EXISTS idx_device_keys_user ON device_keys (user_id, installation_id);
CREATE INDEX IF NOT EXISTS idx_device_keys_revoked_at ON device_keys (revoked_at);
-- Rollback (only if nothing uses it yet): DROP TABLE device_keys;
