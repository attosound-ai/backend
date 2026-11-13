import type { DeactivatedUsersRepository } from "../redis/repositories/deactivated-users.repository";

/**
 * Drops the items whose author is in `hidden`. Pure, so the rule is tested
 * without Redis.
 */
export function withoutAuthors<T>(
  items: T[],
  authorOf: (item: T) => string | number | null | undefined,
  hidden: Set<string>,
): T[] {
  if (hidden.size === 0) return items;
  return items.filter((item) => !hidden.has(String(authorOf(item) ?? "")));
}

/**
 * Removes what accounts in deletion grace authored. Without a repository
 * (older wiring, unit tests) nothing is hidden.
 */
export async function hideDeactivatedAuthors<T>(
  items: T[],
  authorOf: (item: T) => string | number | null | undefined,
  repo?: DeactivatedUsersRepository,
): Promise<T[]> {
  if (!repo || items.length === 0) return items;
  const ids = items.map((i) => String(authorOf(i) ?? "")).filter(Boolean);
  return withoutAuthors(items, authorOf, await repo.among(ids));
}
