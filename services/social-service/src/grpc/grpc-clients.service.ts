import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import * as fs from 'fs';

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

  onModuleInit(): void {
    this.initUserClient();
    this.initContentClient();
  }

  private resolveProtoPath(filename: string): string {
    // Docker volume mount path (production/docker)
    const dockerPath = path.resolve('/proto', filename);
    if (fs.existsSync(dockerPath)) return dockerPath;

    // Relative path for local development
    return path.resolve(process.cwd(), '..', '..', 'proto', filename);
  }

  private getProtoDir(): string {
    const dockerDir = '/proto';
    if (fs.existsSync(dockerDir)) return dockerDir;
    return path.resolve(process.cwd(), '..', '..', 'proto');
  }

  private initUserClient(): void {
    const protoPath = this.resolveProtoPath('user.proto');
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [this.getProtoDir()],
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const address =
      process.env.USER_SERVICE_GRPC || 'localhost:50051';

    this.userClient = new proto.atto.user.UserService(
      address,
      grpc.credentials.createInsecure(),
    );
    this.logger.log(`User gRPC client connected to ${address}`);
  }

  private initContentClient(): void {
    const protoPath = this.resolveProtoPath('content.proto');
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: false,
      longs: Number,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: [this.getProtoDir()],
    });
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    const address =
      process.env.CONTENT_SERVICE_GRPC || 'localhost:50052';

    this.contentClient = new proto.atto.content.ContentService(
      address,
      grpc.credentials.createInsecure(),
    );
    this.logger.log(`Content gRPC client connected to ${address}`);
  }

  // ── User Service RPCs ──

  async getUser(userId: string): Promise<UserResponse | null> {
    return new Promise((resolve) => {
      this.userClient.GetUser(
        { userId },
        { deadline: this.deadline() },
        (err: any, response: UserResponse) => {
          if (err) {
            this.logger.error(`GetUser failed for ${userId}: ${err.message}`);
            resolve(null);
          } else {
            resolve(response);
          }
        },
      );
    });
  }

  async getUsersBatch(userIds: string[]): Promise<UserResponse[]> {
    if (userIds.length === 0) return [];
    return new Promise((resolve) => {
      this.userClient.GetUsersBatch(
        { userIds },
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
  }

  async validateToken(
    token: string,
  ): Promise<{ valid: boolean; userId: string; role: string } | null> {
    return new Promise((resolve) => {
      this.userClient.ValidateToken(
        { token },
        { deadline: this.deadline() },
        (
          err: any,
          response: { valid: boolean; userId: string; role: string },
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
        { contentId },
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

  async getContentBatch(
    contentIds: string[],
    pagination?: { cursor: string; limit: number },
  ): Promise<{ contents: ContentResponse[]; meta: PaginatedMeta }> {
    if (contentIds.length === 0) {
      return { contents: [], meta: { next_cursor: '', has_more: false, total: 0 } };
    }
    return new Promise((resolve) => {
      this.contentClient.GetContentBatch(
        { contentIds, pagination: pagination || { cursor: '', limit: 20 } },
        { deadline: this.deadline() },
        (
          err: any,
          response: { contents: ContentResponse[]; meta: PaginatedMeta },
        ) => {
          if (err) {
            this.logger.error(`GetContentBatch failed: ${err.message}`);
            resolve({
              contents: [],
              meta: { next_cursor: '', has_more: false, total: 0 },
            });
          } else {
            resolve({
              contents: response.contents || [],
              meta: response.meta || {
                next_cursor: '',
                has_more: false,
                total: 0,
              },
            });
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
        request,
        { deadline: this.deadline() },
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
          authorId,
          pagination: pagination || { cursor: '', limit: 20 },
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
              meta: { next_cursor: '', has_more: false, total: 0 },
            });
          } else {
            resolve({
              contents: response.contents || [],
              meta: response.meta || {
                next_cursor: '',
                has_more: false,
                total: 0,
              },
            });
          }
        },
      );
    });
  }

  private deadline(): Date {
    return new Date(Date.now() + 5000); // 5 second deadline
  }
}
