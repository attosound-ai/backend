import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { RedisService } from "../redis/redis.service";
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import * as path from "path";
import * as fs from "fs";

const USER_CACHE_TTL = 600; // 10 minutes

interface UserResponse {
  id: string;
  username: string;
  display_name: string;
  avatar?: string;
  bio?: string;
  role: string;
  inmate_number?: string;
  profile_verified: boolean;
  representative_id?: string;
  followers_count: number;
  following_count: number;
  posts_count: number;
  created_at: string;
}

interface ContentResponse {
  id: string;
  author_id: string;
  content_type: string;
  text_content: string;
  file_paths: string[];
  metadata: Record<string, string>;
  tags: string[];
  created_at: string;
  updated_at: string;
}

interface PaginatedMeta {
  next_cursor: string;
  has_more: boolean;
  total: number;
}

@Injectable()
export class GrpcClientsService implements OnModuleInit {
  private readonly logger = new Logger(GrpcClientsService.name);
  private userClient: any;
  private contentClient: any;

  constructor(private readonly redis: RedisService) {}

  onModuleInit(): void {
    this.initUserClient();
    this.initContentClient();
  }

  private resolveProtoPath(filename: string): string {
    // Docker volume mount path (production/docker)
    const dockerPath = path.resolve("/proto", filename);
    if (fs.existsSync(dockerPath)) return dockerPath;

    // Relative path for local development
    return path.resolve(process.cwd(), "..", "..", "proto", filename);
  }

  private getProtoDir(): string {
    const dockerDir = "/proto";
    if (fs.existsSync(dockerDir)) return dockerDir;
    return path.resolve(process.cwd(), "..", "..", "proto");
  }

  private initUserClient(): void {
    // The Go user-service uses a JSON codec (not protobuf).
    // We must build the client with JSON serialize/deserialize.
    const jsonSerialize = (obj: any): Buffer =>
      Buffer.from(JSON.stringify(obj));
    const jsonDeserialize = (buf: Buffer): any => JSON.parse(buf.toString());

    const serviceDef: grpc.ServiceDefinition = {
      GetUser: {
        path: "/atto.user.UserService/GetUser",
        requestStream: false,
        responseStream: false,
        requestSerialize: jsonSerialize,
        requestDeserialize: jsonDeserialize,
        responseSerialize: jsonSerialize,
        responseDeserialize: jsonDeserialize,
      },
      GetUsersBatch: {
        path: "/atto.user.UserService/GetUsersBatch",
        requestStream: false,
        responseStream: false,
        requestSerialize: jsonSerialize,
        requestDeserialize: jsonDeserialize,
        responseSerialize: jsonSerialize,
        responseDeserialize: jsonDeserialize,
      },
      ValidateToken: {
        path: "/atto.user.UserService/ValidateToken",
        requestStream: false,
        responseStream: false,
        requestSerialize: jsonSerialize,
        requestDeserialize: jsonDeserialize,
        responseSerialize: jsonSerialize,
        responseDeserialize: jsonDeserialize,
      },
      GetPushTokens: {
        path: "/atto.user.UserService/GetPushTokens",
        requestStream: false,
        responseStream: false,
        requestSerialize: jsonSerialize,
        requestDeserialize: jsonDeserialize,
        responseSerialize: jsonSerialize,
        responseDeserialize: jsonDeserialize,
      },
    };

    const address = process.env.USER_SERVICE_GRPC || "localhost:50051";
    const ClientCtor = grpc.makeGenericClientConstructor(
      serviceDef,
      "UserService",
    );
    this.userClient = new ClientCtor(
      address,
      grpc.credentials.createInsecure(),
    );
    this.logger.log(`User gRPC client connected to ${address} (JSON codec)`);
  }

  private initContentClient(): void {
    const protoPath = this.resolveProtoPath("content.proto");
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [this.getProtoDir()],
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const address = process.env.CONTENT_SERVICE_GRPC || "localhost:50052";

    this.contentClient = new proto.atto.content.ContentService(
      address,
      grpc.credentials.createInsecure(),
    );
    this.logger.log(`Content gRPC client connected to ${address}`);
  }

  // ── User Service RPCs (with Redis cache) ──

  private userCacheKey(userId: string): string {
    return `social:user:${userId}`;
  }

  /** Invalidate a user's cached profile — call on user.updated / user.deleted. */
  async invalidateUserCache(userId: string): Promise<void> {
    await this.redis.del(this.userCacheKey(userId));
  }

  async getUser(userId: string): Promise<UserResponse | null> {
    // Cache check
    const cached = await this.redis.get(this.userCacheKey(userId));
    if (cached) {
      try { return JSON.parse(cached); } catch { /* fall through */ }
    }

    return new Promise((resolve) => {
      this.userClient.GetUser(
        { user_id: userId },
        { deadline: this.deadline() },
        (err: any, response: UserResponse) => {
          if (err) {
            this.logger.error(`GetUser failed for ${userId}: ${err.message}`);
            resolve(null);
          } else {
            // Cache (fire-and-forget)
            this.redis.set(this.userCacheKey(userId), JSON.stringify(response), USER_CACHE_TTL).catch(() => {});
            resolve(response);
          }
        },
      );
    });
  }

  /**
   * Batch fetch users with Redis cache layer.
   * Reads all from cache in 1 pipeline, only calls gRPC for misses.
   */
  async getUsersBatch(userIds: string[]): Promise<UserResponse[]> {
    if (userIds.length === 0) return [];

    // 1. Pipeline read from Redis
    const client = this.redis.getClient();
    const pipeline = client.pipeline();
    for (const id of userIds) {
      pipeline.get(this.userCacheKey(id));
    }
    const results = await pipeline.exec();

    const cached: UserResponse[] = [];
    const missingIds: string[] = [];

    for (let i = 0; i < userIds.length; i++) {
      const val = results?.[i]?.[1] as string | null;
      if (val) {
        try {
          cached.push(JSON.parse(val));
          continue;
        } catch { /* fall through */ }
      }
      missingIds.push(userIds[i]);
    }

    // 2. gRPC only for cache misses
    if (missingIds.length === 0) return cached;

    const fromGrpc = await new Promise<UserResponse[]>((resolve) => {
      this.userClient.GetUsersBatch(
        { user_ids: missingIds },
        { deadline: this.deadline() },
        (err: any, response: { users: UserResponse[] }) => {
          if (err) {
            this.logger.error(`GetUsersBatch failed: ${err.message}`);
            resolve([]);
          } else {
            resolve(response.users || []);
          }
        },
      );
    });

    // 3. Cache the gRPC results (fire-and-forget pipeline)
    if (fromGrpc.length > 0) {
      const cachePipeline = client.pipeline();
      for (const user of fromGrpc) {
        cachePipeline.set(this.userCacheKey(user.id), JSON.stringify(user), 'EX', USER_CACHE_TTL);
      }
      cachePipeline.exec().catch(() => {});
    }

    return [...cached, ...fromGrpc];
  }

  async validateToken(
    token: string,
  ): Promise<{ valid: boolean; user_id: string; role: string } | null> {
    return new Promise((resolve) => {
      this.userClient.ValidateToken(
        { token },
        { deadline: this.deadline() },
        (
          err: any,
          response: { valid: boolean; user_id: string; role: string },
        ) => {
          if (err) {
            this.logger.error(`ValidateToken failed: ${err.message}`);
            resolve(null);
          } else {
            resolve(response);
          }
        },
      );
    });
  }

  // ── Content Service RPCs ──

  async getContent(contentId: string): Promise<ContentResponse | null> {
    return new Promise((resolve) => {
      this.contentClient.GetContent(
        { content_id: contentId },
        { deadline: this.deadline() },
        (err: any, response: ContentResponse) => {
          if (err) {
            this.logger.error(
              `GetContent failed for ${contentId}: ${err.message}`,
            );
            resolve(null);
          } else {
            resolve(response);
          }
        },
      );
    });
  }

  /**
   * List all content (no ID filter) — used by the explore feed.
   * Calls GetContentBatch with empty content_ids, which triggers the paginated-list
   * branch in the Rust gRPC server.
   */
  async listRecentContent(
    cursor: string,
    limit: number,
  ): Promise<{ contents: ContentResponse[]; meta: PaginatedMeta }> {
    return new Promise((resolve) => {
      this.contentClient.GetContentBatch(
        { content_ids: [], pagination: { cursor, limit } },
        { deadline: this.deadline() },
        (
          err: any,
          response: { contents: ContentResponse[]; meta: PaginatedMeta },
        ) => {
          if (err) {
            this.logger.error(`listRecentContent failed: ${err.message}`);
            resolve({
              contents: [],
              meta: { next_cursor: "", has_more: false, total: 0 },
            });
          } else {
            resolve({
              contents: response.contents || [],
              meta: response.meta || {
                next_cursor: "",
                has_more: false,
                total: 0,
              },
            });
          }
        },
      );
    });
  }

  async getContentBatch(
    contentIds: string[],
    pagination?: { cursor: string; limit: number },
  ): Promise<{ contents: ContentResponse[]; meta: PaginatedMeta }> {
    if (contentIds.length === 0) {
      return {
        contents: [],
        meta: { next_cursor: "", has_more: false, total: 0 },
      };
    }
    return new Promise((resolve) => {
      this.contentClient.GetContentBatch(
        {
          content_ids: contentIds,
          pagination: pagination || { cursor: "", limit: 20 },
        },
        { deadline: this.deadline() },
        (
          err: any,
          response: { contents: ContentResponse[]; meta: PaginatedMeta },
        ) => {
          if (err) {
            this.logger.error(`GetContentBatch failed: ${err.message}`);
            resolve({
              contents: [],
              meta: { next_cursor: "", has_more: false, total: 0 },
            });
          } else {
            resolve({
              contents: response.contents || [],
              meta: response.meta || {
                next_cursor: "",
                has_more: false,
                total: 0,
              },
            });
          }
        },
      );
    });
  }

  async updateContent(request: {
    contentId: string;
    authorId: string;
    textContent?: string;
    tags?: string[];
    metadata?: Record<string, string>;
  }): Promise<ContentResponse | null> {
    return new Promise((resolve) => {
      this.contentClient.UpdateContent(
        {
          content_id: request.contentId,
          author_id: request.authorId,
          text_content: request.textContent ?? '',
          tags: request.tags ?? [],
          metadata: request.metadata ?? {},
        },
        { deadline: this.deadline() },
        (err: any, response: ContentResponse) => {
          if (err) {
            this.logger.error(`UpdateContent failed: ${err.message}`);
            resolve(null);
          } else {
            resolve(response);
          }
        },
      );
    });
  }

  async createContent(request: {
    authorId: string;
    contentType: string;
    textContent: string;
    filePaths: string[];
    metadata: Record<string, string>;
    tags: string[];
  }): Promise<ContentResponse | null> {
    return new Promise((resolve) => {
      this.contentClient.CreateContent(
        {
          author_id: request.authorId,
          content_type: request.contentType,
          text_content: request.textContent,
          file_paths: request.filePaths,
          metadata: request.metadata,
          tags: request.tags,
        },
        { deadline: this.longDeadline() },
        (err: any, response: ContentResponse) => {
          if (err) {
            this.logger.error(`CreateContent failed: ${err.message}`);
            resolve(null);
          } else {
            resolve(response);
          }
        },
      );
    });
  }

  async getContentByAuthor(
    authorId: string,
    pagination?: { cursor: string; limit: number },
  ): Promise<{ contents: ContentResponse[]; meta: PaginatedMeta }> {
    return new Promise((resolve) => {
      this.contentClient.GetContentByAuthor(
        {
          author_id: authorId,
          pagination: pagination || { cursor: "", limit: 20 },
        },
        { deadline: this.deadline() },
        (
          err: any,
          response: { contents: ContentResponse[]; meta: PaginatedMeta },
        ) => {
          if (err) {
            this.logger.error(
              `GetContentByAuthor failed for ${authorId}: ${err.message}`,
            );
            resolve({
              contents: [],
              meta: { next_cursor: "", has_more: false, total: 0 },
            });
          } else {
            resolve({
              contents: response.contents || [],
              meta: response.meta || {
                next_cursor: "",
                has_more: false,
                total: 0,
              },
            });
          }
        },
      );
    });
  }

  async deleteAllContentByAuthor(authorId: string): Promise<number> {
    return new Promise((resolve) => {
      this.contentClient.DeleteContentByAuthor(
        { author_id: authorId },
        { deadline: this.longDeadline() },
        (err: any, response: { deleted_count: number }) => {
          if (err) {
            this.logger.error(
              `DeleteContentByAuthor failed for ${authorId}: ${err.message}`,
            );
            resolve(0);
          } else {
            resolve(response.deleted_count ?? 0);
          }
        },
      );
    });
  }

  async getPushTokens(
    userId: string,
  ): Promise<{ token: string; platform: string }[]> {
    return new Promise((resolve) => {
      this.userClient.GetPushTokens(
        { user_id: userId },
        { deadline: this.deadline() },
        (
          err: any,
          response: { tokens: { token: string; platform: string }[] },
        ) => {
          if (err) {
            this.logger.error(
              `GetPushTokens failed for ${userId}: ${err.message}`,
            );
            resolve([]);
          } else {
            resolve(response.tokens || []);
          }
        },
      );
    });
  }

  private deadline(): Date {
    return new Date(Date.now() + 5000); // 5 second deadline
  }

  private longDeadline(): Date {
    return new Date(Date.now() + 30000); // 30 second deadline for uploads
  }
}
