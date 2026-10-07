import { Prisma } from "@prisma/client";

/**
 * The comments a reader can open under a post, and so the only ones the
 * number next to the bubble may count: not deleted, and a reply only while
 * the comment it hangs from is still there (the list drops a deleted comment
 * together with its replies).
 *
 * Every count of comments goes through here. On Oct 7 2026 a post showed 3
 * with one comment in the list: deleting a comment took one off the cached
 * number, but the number is counted again from the table every ten minutes
 * and that count had no filter, so the two deleted ones came back for good.
 */
export function visibleComments(
  contentId: string | { in: string[] },
): Prisma.CommentWhereInput {
  return {
    contentId,
    isDeleted: false,
    OR: [{ parentId: null }, { parent: { is: { isDeleted: false } } }],
  };
}
