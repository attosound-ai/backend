import { deepLinkFor, pushDataFor } from "./push-deep-link";

const POST = "6650f1c2a9b8c7d6e5f40312";
const COMMENT = "1b2c3d4e-0000-4000-8000-000000000abc";

describe("deepLinkFor", () => {
  it("a comment notice carries the comment as a query param", () => {
    expect(deepLinkFor("comment", POST, "7", "arami", COMMENT)).toBe(
      `/post/${POST}?commentId=${COMMENT}`,
    );
  });

  it("a comment notice without a comment id opens the post as before", () => {
    expect(deepLinkFor("comment", POST, "7", "arami", null)).toBe(`/post/${POST}`);
    expect(deepLinkFor("comment", POST, "7", "arami")).toBe(`/post/${POST}`);
  });

  it("like and mention keep the plain post link", () => {
    expect(deepLinkFor("like", POST, "7", "arami", COMMENT)).toBe(`/post/${POST}`);
    expect(deepLinkFor("mention", POST, "7", "arami")).toBe(`/post/${POST}`);
  });

  it("no reference, no link", () => {
    expect(deepLinkFor("like", null, "7")).toBeNull();
    expect(deepLinkFor("comment", null, "7", "arami", COMMENT)).toBeNull();
  });

  it("follow and message links are unchanged", () => {
    expect(deepLinkFor("follow", null, "7")).toBe("/user/7");
    expect(deepLinkFor("message", "c1", "7", "arami")).toBe(
      "/chat?conversationId=c1&participantId=7&participantName=arami",
    );
  });

  it("an unknown type has no link", () => {
    expect(deepLinkFor("welcome", POST, "7")).toBeNull();
  });
});

describe("pushDataFor", () => {
  const base = {
    actorId: "7",
    actorUsername: "arami",
    recipientId: "152",
    recipientUsername: "larry",
    badge: 3,
  };

  it("keeps the fields every app in the field reads", () => {
    const data = pushDataFor({ ...base, type: "like", referenceId: POST });
    expect(data.url).toBe(`/post/${POST}`);
    expect(data.account_id).toBe("152");
    expect(data.account_username).toBe("larry");
    expect(data.badge).toBe(3);
  });

  it("a comment says which post and which comment", () => {
    const data = pushDataFor({
      ...base,
      type: "comment",
      referenceId: POST,
      commentId: COMMENT,
    });
    expect(data).toMatchObject({
      type: "comment",
      actor_id: "7",
      post_id: POST,
      comment_id: COMMENT,
      url: `/post/${POST}?commentId=${COMMENT}`,
    });
  });

  it("a like names the post and no comment", () => {
    const data = pushDataFor({ ...base, type: "like", referenceId: POST });
    expect(data.post_id).toBe(POST);
    expect(data).not.toHaveProperty("comment_id");
  });

  it("a message is not a post: no post_id even with a reference", () => {
    const data = pushDataFor({ ...base, type: "message", referenceId: "c1" });
    expect(data).not.toHaveProperty("post_id");
    expect(data.type).toBe("message");
  });

  it("a follow has no url reference problems and no post", () => {
    const data = pushDataFor({ ...base, type: "follow" });
    expect(data.url).toBe("/user/7");
    expect(data).not.toHaveProperty("post_id");
  });
});
