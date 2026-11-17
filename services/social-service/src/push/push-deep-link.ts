/**
 * Where a tap on a push lands, and the data the push carries. Kept free of
 * expo-server-sdk so jest can load it (that package ships ES modules).
 */

type DeepLinkFn = (
  referenceId: string | null,
  actorId: string,
  actorUsername?: string,
  commentId?: string | null,
) => string | null;

const DEEP_LINK: Record<string, DeepLinkFn> = {
  follow: (_ref, actorId) => `/user/${actorId}`,
  like: (ref) => (ref ? `/post/${ref}` : null),
  // The comment rides along as a query param: an app that does not know it
  // opens the post as before, a newer one opens the comments on it.
  comment: (ref, _actorId, _username, commentId) =>
    ref
      ? commentId
        ? `/post/${ref}?${new URLSearchParams({ commentId }).toString()}`
        : `/post/${ref}`
      : null,
  repost: (ref) => (ref ? `/post/${ref}` : null),
  share: (ref) => (ref ? `/post/${ref}` : null),
  message: (ref, actorId, actorUsername) => {
    if (!ref) return null;
    // `participantName` here is the @username — the front uses this URL
    // param as the chat header label. Renaming the key would require a
    // coordinated frontend change (see chat.tsx / messages.tsx).
    const params = new URLSearchParams({
      conversationId: ref,
      participantId: actorId,
      participantName: actorUsername || "",
    });
    return `/chat?${params.toString()}`;
  },
  new_post: (ref) => (ref ? `/post/${ref}` : null),
  mention: (ref) => (ref ? `/post/${ref}` : null),
};

/** Notice types whose reference is a post id. */
const POST_TYPES = new Set([
  "like",
  "comment",
  "repost",
  "share",
  "new_post",
  "mention",
]);

export function deepLinkFor(
  type: string,
  referenceId: string | null,
  actorId: string,
  actorUsername?: string,
  commentId?: string | null,
): string | null {
  return DEEP_LINK[type]?.(referenceId, actorId, actorUsername, commentId) ?? null;
}

/**
 * The `data` of a push. `url` and `account_id` are what every app in the
 * field reads. `type`, `actor_id`, `post_id` and `comment_id` (Nov 12 2026)
 * let a newer app open the comment a notice is about and say in its
 * telemetry what kind of notice was tapped; older apps ignore them.
 */
export function pushDataFor(args: {
  type: string;
  actorId: string;
  actorUsername?: string;
  referenceId?: string | null;
  commentId?: string | null;
  recipientId: string;
  recipientUsername?: string;
  badge: number;
}): Record<string, unknown> {
  const url = deepLinkFor(
    args.type,
    args.referenceId ?? null,
    args.actorId,
    args.actorUsername,
    args.commentId,
  );
  const isPost = POST_TYPES.has(args.type) && !!args.referenceId;
  return {
    ...(url ? { url } : {}),
    account_id: args.recipientId,
    account_username: args.recipientUsername || undefined,
    badge: args.badge,
    type: args.type,
    actor_id: args.actorId,
    ...(isPost ? { post_id: args.referenceId } : {}),
    ...(isPost && args.commentId ? { comment_id: args.commentId } : {}),
  };
}
