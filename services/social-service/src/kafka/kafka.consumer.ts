import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { Kafka, Consumer, EachMessagePayload } from "kafkajs";
import { RedisService } from "../redis/redis.service";
import { PrismaService } from "../prisma/prisma.service";
import { PushService } from "../push/push.service";
import { GrpcClientsService } from "../grpc/grpc-clients.service";

@Injectable()
export class KafkaConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KafkaConsumer.name);
  private kafka: Kafka;
  private consumer: Consumer;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly pushService: PushService,
    private readonly grpcClients: GrpcClientsService,
  ) {}

  async onModuleInit(): Promise<void> {
    const brokers = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
    const useTls = process.env.KAFKA_USE_TLS === "true";
    this.kafka = new Kafka({
      clientId: "social-service",
      brokers,
      retry: {
        initialRetryTime: 300,
        retries: 5,
      },
      ...(useTls && {
        ssl: true,
        sasl: {
          mechanism: "scram-sha-256" as const,
          username: process.env.KAFKA_SASL_USERNAME || "",
          password: process.env.KAFKA_SASL_PASSWORD || "",
        },
      }),
    });

    this.consumer = this.kafka.consumer({
      groupId: "social-service-group",
    });

    await this.connect();
  }

  private async connect(): Promise<void> {
    try {
      await this.consumer.connect();
      this.logger.log("Kafka consumer connected");

      await this.consumer.subscribe({
        topics: [
          "user.created",
          "user.updated",
          "content.published",
          "content.deleted",
          "content.updated",
          "message.sent",
          "user.deleted",
        ],
        fromBeginning: false,
      });

      await this.consumer.run({
        eachMessage: async (payload: EachMessagePayload) => {
          await this.handleMessage(payload);
        },
      });

      this.logger.log(
        "Kafka consumer subscribed to: user.created, content.published, message.sent",
      );
    } catch (error) {
      this.logger.error(`Failed to connect Kafka consumer: ${error.message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.consumer) {
      await this.consumer.disconnect();
      this.logger.log("Kafka consumer disconnected");
    }
  }

  private async handleMessage(payload: EachMessagePayload): Promise<void> {
    const { topic, message } = payload;

    if (!message.value) return;

    try {
      const raw = JSON.parse(message.value.toString());
      // Events may be wrapped as { event, data, timestamp } or flat
      const data = raw.data ?? raw;
      this.logger.debug(`Received message on topic ${topic}`);

      switch (topic) {
        case "user.created":
          await this.handleUserCreated(data);
          break;
        case "user.updated":
          await this.handleUserUpdated(data);
          break;
        case "content.published":
          await this.handleContentPublished(data);
          break;
        case "content.deleted":
          await this.handleContentDeleted(data);
          break;
        case "content.updated":
          await this.handleContentUpdated(data);
          break;
        case "message.sent":
          await this.handleMessageSent(data);
          break;
        case "user.deleted":
          await this.handleUserDeleted(data);
          break;
        default:
          this.logger.warn(`Unhandled topic: ${topic}`);
      }
    } catch (error) {
      this.logger.error(
        `Error processing message from ${topic}: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * user.created -> create default notification preferences (welcome notification)
   */
  private async handleUserCreated(data: {
    id?: string;
    user_id?: string;
    username: string;
  }): Promise<void> {
    const userId = data.id ?? data.user_id;
    if (!userId) {
      this.logger.error("user.created event missing user id, skipping");
      return;
    }
    this.logger.log(`Processing user.created for user ${userId}`);

    await this.prisma.notification.create({
      data: {
        recipientId: userId,
        type: "welcome",
        actorId: "system",
        referenceId: null,
        isRead: false,
      },
    });

    this.logger.log(`Welcome notification created for user ${userId}`);
  }

  /**
   * user.updated -> invalidate cached user profile in Redis
   */
  private async handleUserUpdated(data: {
    id?: string;
    user_id?: string;
  }): Promise<void> {
    const userId = data.id ?? data.user_id;
    if (!userId) return;
    await this.grpcClients.invalidateUserCache(userId);
    this.logger.log(`Invalidated user cache for ${userId}`);
  }

  /**
   * content.deleted -> decrement posts count + clean up interactions/feed cache
   */
  private async handleContentDeleted(data: {
    content_id: string;
    author_id: string;
  }): Promise<void> {
    if (!data.content_id || !data.author_id) return;

    this.logger.log(
      `Processing content.deleted for content ${data.content_id} by ${data.author_id}`,
    );

    // Decrement post count
    await this.redis.decrementCount("posts", data.author_id);

    // Remove from author's feed cache and all followers' feeds
    const client = this.redis.getClient();
    const followerIds = await this.redis.getFollowerIds(data.author_id);
    const feedKeys = [
      `social:feed:${data.author_id}`,
      ...followerIds.map((fid) => `social:feed:${fid}`),
    ];
    if (feedKeys.length > 0) {
      const pipeline = client.pipeline();
      for (const key of feedKeys) {
        pipeline.zrem(key, data.content_id);
      }
      await pipeline.exec();
    }

    // Clean up interaction counts from Redis
    const countTypes = ["likes", "comments", "shares", "reposts"];
    const cleanPipeline = client.pipeline();
    for (const type of countTypes) {
      cleanPipeline.del(`social:count:${type}:${data.content_id}`);
    }
    await cleanPipeline.exec();

    // Clean up DB interactions for this content
    await Promise.all([
      this.prisma.interaction.deleteMany({ where: { contentId: data.content_id } }),
      this.prisma.comment.deleteMany({ where: { contentId: data.content_id } }),
      this.prisma.bookmark.deleteMany({ where: { contentId: data.content_id } }),
      this.prisma.repost.deleteMany({ where: { contentId: data.content_id } }),
      this.prisma.notification.deleteMany({ where: { referenceId: data.content_id } }),
    ]);

    this.logger.log(
      `Cleaned up content ${data.content_id}: decremented posts count, removed from feeds, deleted interactions`,
    );
  }

  /**
   * content.updated -> invalidate cached content (future: notify likers)
   */
  private async handleContentUpdated(data: {
    content_id: string;
    author_id: string;
  }): Promise<void> {
    if (!data.content_id) return;
    this.logger.log(`Processing content.updated for content ${data.content_id}`);
    // No cache to invalidate currently (content is fetched via gRPC, not cached in Redis)
    // This handler exists for future extensibility (e.g. re-index search, notify)
  }

  /**
   * content.published -> fan out to followers' feed caches
   */
  private async handleContentPublished(data: {
    content_id: string;
    author_id: string;
    created_at: string;
  }): Promise<void> {
    this.logger.log(
      `Processing content.published for content ${data.content_id} by ${data.author_id}`,
    );

    const timestamp = data.created_at
      ? new Date(data.created_at).getTime()
      : Date.now();

    // Get all followers of the author
    let followerIds = await this.redis.getFollowerIds(data.author_id);

    // If Redis cache is empty, fall back to DB
    if (followerIds.length === 0) {
      const follows = await this.prisma.follow.findMany({
        where: { followingId: data.author_id },
        select: { followerId: true },
      });
      followerIds = follows.map((f) => f.followerId);

      // Re-populate Redis cache
      for (const fid of followerIds) {
        await this.redis.addFollow(fid, data.author_id);
      }
    }

    // Also add to the author's own feed
    await this.redis.addToFeed(data.author_id, data.content_id, timestamp);

    // Fan out to all followers
    await this.redis.addToFeedBulk(followerIds, data.content_id, timestamp);

    this.logger.log(
      `Content ${data.content_id} fanned out to ${followerIds.length} followers`,
    );
  }

  /**
   * message.sent -> create notification for the recipient
   */
  private async handleMessageSent(data: {
    sender_id: string;
    recipient_id?: string;
    conversation_id?: string;
    message_id: string;
    content?: string;
  }): Promise<void> {
    if (!data.recipient_id) {
      this.logger.warn(
        `message.sent missing recipient_id (conversation: ${data.conversation_id}), skipping notification`,
      );
      return;
    }

    // Don't notify users about their own messages
    if (data.sender_id === data.recipient_id) return;

    this.logger.log(
      `Processing message.sent from ${data.sender_id} to ${data.recipient_id}`,
    );

    await this.prisma.notification.create({
      data: {
        recipientId: data.recipient_id,
        type: "message",
        actorId: data.sender_id,
        referenceId: data.conversation_id || data.message_id,
        isRead: false,
      },
    });

    this.logger.log(
      `Message notification created for user ${data.recipient_id}`,
    );

    // Send push notification (fire-and-forget)
    this.grpcClients
      .getUser(data.sender_id)
      .then((actor) => {
        const senderName = actor?.display_name || "Someone";
        const messagePreview = data.content
          ? data.content.length > 100
            ? data.content.slice(0, 100) + "…"
            : data.content
          : undefined;
        this.pushService
          .sendPush(
            data.recipient_id!,
            "message",
            data.sender_id,
            senderName,
            data.conversation_id,
            messagePreview ? `${senderName}: ${messagePreview}` : undefined,
          )
          .catch((err) => this.logger.error(`Push failed: ${err.message}`));
      })
      .catch((err) =>
        this.logger.error(`GetUser for push failed: ${err.message}`),
      );
  }

  /**
   * user.deleted -> recalculate Redis counts for all posts the user interacted
   * with, clean up follow graph, and delete feed caches.
   *
   * NOTE: Postgres rows are already deleted by user-service in a single
   * transaction BEFORE this event is emitted. This handler only fixes the
   * Redis caches that went stale because of those deletes.
   */
  private async handleUserDeleted(data: {
    userIds: string[];
  }): Promise<void> {
    const userIds = data.userIds ?? [];
    if (userIds.length === 0) return;

    this.logger.log(`Processing user.deleted for users: ${userIds.join(", ")}`);

    for (const userId of userIds) {
      // Invalidate user profile cache
      await this.grpcClients.invalidateUserCache(userId);

      // 0. Fetch content IDs BEFORE deletion (for feed cache + Cloudinary cleanup)
      let userContentIds: string[] = [];
      let userFilePaths: string[] = [];
      try {
        const { contents } = await this.grpcClients.getContentByAuthor(userId, { cursor: '', limit: 500 });
        userContentIds = contents.map((c) => c.id);
        userFilePaths = contents.flatMap((c) => c.file_paths || []);
      } catch {
        this.logger.warn(`Could not pre-fetch content for user ${userId}`);
      }

      // 1. Delete all social Postgres rows + creator logo votes (Fix #1)
      const [notifs, follows1, follows2, interactions, comments, bookmarks, reposts, reelViews, logoVotes] =
        await Promise.all([
          this.prisma.notification.deleteMany({
            where: { OR: [{ recipientId: userId }, { actorId: userId }] },
          }),
          this.prisma.follow.deleteMany({ where: { followerId: userId } }),
          this.prisma.follow.deleteMany({ where: { followingId: userId } }),
          this.prisma.interaction.deleteMany({ where: { userId } }),
          this.prisma.comment.deleteMany({ where: { userId } }),
          this.prisma.bookmark.deleteMany({ where: { userId } }),
          this.prisma.repost.deleteMany({ where: { userId } }),
          this.prisma.reelView.deleteMany({ where: { userId } }),
          this.prisma.creatorLogoVote.deleteMany({ where: { userId } }),
        ]);
      this.logger.log(
        `Deleted social DB for user ${userId}: ` +
        `${notifs.count} notifs, ${follows1.count + follows2.count} follows, ` +
        `${interactions.count} interactions, ${comments.count} comments, ` +
        `${bookmarks.count} bookmarks, ${reposts.count} reposts, ` +
        `${reelViews.count} reel views, ${logoVotes.count} logo votes`,
      );

      // 2. Delete all content (MongoDB) via gRPC
      const deletedContent = await this.grpcClients.deleteAllContentByAuthor(userId);
      this.logger.log(`Deleted ${deletedContent} content docs for user ${userId}`);

      // 3. Fix follow graph in Redis
      const followingIds = await this.redis.getFollowerIds(userId);
      const followerIds = await this.redis.getFollowingIds(userId);
      for (const fid of followingIds) {
        await this.redis.removeFollow(userId, fid);
      }
      for (const fid of followerIds) {
        await this.redis.removeFollow(fid, userId);
      }

      // 4. Delete user's own caches
      await this.redis.del(`social:feed:${userId}`);
      await this.redis.del(`social:count:posts:${userId}`);
      await this.redis.del(`social:count:following:${userId}`);
      await this.redis.del(`social:count:followers:${userId}`);

      // Fix #2: Remove deleted user's content from ALL other users' feed caches
      if (userContentIds.length > 0) {
        const client = this.redis.getClient();
        let feedCursor = '0';
        let cleanedEntries = 0;
        do {
          const [next, feedKeys] = await client.scan(feedCursor, 'MATCH', 'social:feed:*', 'COUNT', 200);
          feedCursor = next;
          if (feedKeys.length > 0) {
            const pipeline = client.pipeline();
            for (const feedKey of feedKeys) {
              for (const cid of userContentIds) {
                pipeline.zrem(feedKey, cid);
              }
            }
            const results = await pipeline.exec();
            cleanedEntries += (results || []).filter(([, r]) => r && (r as number) > 0).length;
          }
        } while (feedCursor !== '0');

        // Clean interaction count caches for deleted content
        const countPipeline = client.pipeline();
        for (const cid of userContentIds) {
          countPipeline.del(`social:count:likes:${cid}`);
          countPipeline.del(`social:count:comments:${cid}`);
          countPipeline.del(`social:count:shares:${cid}`);
          countPipeline.del(`social:count:reposts:${cid}`);
        }
        await countPipeline.exec();
        this.logger.log(`Cleaned ${cleanedEntries} orphaned entries from other feeds + ${userContentIds.length * 4} count keys`);
      }

      // Fix #3: Delete Cloudinary media (fire-and-forget)
      if (userFilePaths.length > 0) {
        this.deleteCloudinaryAssets(userFilePaths).catch((err) =>
          this.logger.warn(`Cloudinary cleanup failed for user ${userId}: ${err.message}`),
        );
      }

      this.logger.log(`Full cleanup done for user ${userId}`);
    }

    // 4. Recalculate counts for ALL posts that still exist in interactions/comments
    //    Since user rows are already deleted, the DB counts are now correct —
    //    we just need to refresh Redis to match.
    //    Scan all Redis count keys and recalculate from DB.
    const client = this.redis.getClient();
    const countTypes = ["likes", "comments", "shares", "reposts"];

    for (const type of countTypes) {
      const pattern = `social:count:${type}:*`;
      let cursor = "0";

      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          200,
        );
        cursor = nextCursor;

        for (const key of keys) {
          const contentId = key.replace(`social:count:${type}:`, "");
          let dbCount: number;

          if (type === "comments") {
            dbCount = await this.prisma.comment.count({
              where: { contentId },
            });
          } else {
            const interactionType = type === "likes"
              ? "LIKE"
              : type === "shares"
                ? "SHARE"
                : "REPOST" // type guard not needed — only known types hit here
            ;
            dbCount = await this.prisma.interaction.count({
              where: { contentId, type: interactionType as any },
            });
          }

          await this.redis.setCount(type, contentId, dbCount);
        }
      } while (cursor !== "0");
    }

    this.logger.log(
      `Redis counts recalculated after deleting users: ${userIds.join(", ")}`,
    );
  }

  /**
   * Fix #3: Delete Cloudinary assets by public IDs.
   * Uses Cloudinary Admin API (requires CLOUDINARY_* env vars).
   */
  private async deleteCloudinaryAssets(publicIds: string[]): Promise<void> {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) {
      this.logger.warn('Cloudinary env vars not set, skipping media cleanup');
      return;
    }

    // Cloudinary delete_resources accepts up to 100 public IDs at a time
    const batchSize = 100;
    for (let i = 0; i < publicIds.length; i += batchSize) {
      const batch = publicIds.slice(i, i + batchSize);
      try {
        const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
        const res = await fetch(
          `https://api.cloudinary.com/v1_1/${cloudName}/resources/image/upload`,
          {
            method: 'DELETE',
            headers: {
              Authorization: `Basic ${auth}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ public_ids: batch }),
          },
        );
        this.logger.log(`Cloudinary delete batch ${i / batchSize + 1}: ${res.status} (${batch.length} assets)`);
      } catch (err) {
        this.logger.warn(`Cloudinary delete batch failed: ${(err as Error).message}`);
      }
    }
  }
}
