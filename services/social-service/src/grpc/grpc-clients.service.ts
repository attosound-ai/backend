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
    // The Go user-service uses a JSON codec (not protobuf).
    // We must build the client with JSON serialize/deserialize.
    const jsonSerialize = (obj: any): Buffer => Buffer.from(JSON.stringify(obj));
    const jsonDeserialize = (buf: Buffer): any => JSON.parse(buf.toString());

    const serviceDef: grpc.ServiceDefinition = {
      GetUser: {
        path: '/atto.user.UserService/GetUser',
        requestStream: false,
        responseStream: false,
        requestSerialize: jsonSerialize,
        requestDeserialize: jsonDeserialize,
        responseSerialize: jsonSerialize,
        responseDeserialize: jsonDeserialize,
      },
      GetUsersBatch: {
        path: '/atto.user.UserService/GetUsersBatch',
        requestStream: false,
        responseStream: false,
        requestSerialize: jsonSerialize,
        requestDeserialize: jsonDeserialize,
        responseSerialize: jsonSerialize,
        responseDeserialize: jsonDeserialize,
      },
      ValidateToken: {
        path: '/atto.user.UserService/ValidateToken',
        requestStream: false,
        responseStream: false,
        requestSerialize: jsonSerialize,
        requestDeserialize: jsonDeserialize,
        responseSerialize: jsonSerialize,
        responseDeserialize: jsonDeserialize,
      },
    };

    const address = process.env.USER_SERVICE_GRPC || 'localhost:50051';
    const ClientCtor = grpc.makeGenericClientConstructor(serviceDef, 'UserService');
    this.userClient = new ClientCtor(address, grpc.credentials.createInsecure());
    this.logger.log(`User gRPC client connected to ${address} (JSON codec)`);
  }

  private initContentClient(): void {
    const protoPath = this.resolveProtoPath('content.proto');
    const packageDefinition = protoLoader.loadSync(protoPath, {
      keepCase: true,
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
        { user_id: userId },
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
        { user_ids: userIds },
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

  async getContentBatch(
    contentIds: string[],
    pagination?: { cursor: string; limit: number },
  ): Promise<{ contents: ContentResponse[]; meta: PaginatedMeta }> {
    if (contentIds.length === 0) {
      return { contents: [], meta: { next_cursor: '', has_more: false, total: 0 } };
    }
    return new Promise((resolve) => {
      this.contentClient.GetContentBatch(
        { content_ids: contentIds, pagination: pagination || { cursor: '', limit: 20 } },
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
        {
          author_id: request.authorId,
          content_type: request.contentType,
          text_content: request.textContent,
          file_paths: request.filePaths,
          metadata: request.metadata,
          tags: request.tags,
        },
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
          author_id: authorId,
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
