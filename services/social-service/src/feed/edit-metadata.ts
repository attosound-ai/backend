/**
 * The metadata an edit may carry to content-service, cleaned.
 *
 * content-service merges it into the post's (a value sent wins, an empty
 * string removes the key). The app sends the tagged people and, since Nov
 * 2026, the cover (`coverPublicId`). Only string values travel, and a bounded
 * number of short keys, so a malformed body cannot bloat a post.
 */
export const EDIT_METADATA_MAX_KEYS = 20;
export const EDIT_METADATA_MAX_KEY = 64;
export const EDIT_METADATA_MAX_VALUE = 4000;

export function editMetadataFrom(
  raw: unknown,
): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= EDIT_METADATA_MAX_KEYS) break;
    if (!key || key.length > EDIT_METADATA_MAX_KEY) continue;
    if (typeof value !== 'string') continue;
    if (value.length > EDIT_METADATA_MAX_VALUE) continue;
    out[key] = value;
    count += 1;
  }
  return count > 0 ? out : undefined;
}
