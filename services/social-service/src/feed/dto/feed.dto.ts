import {
  IsArray,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class FeedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export class CreatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  textContent?: string = '';

  @IsOptional()
  @IsString()
  contentType?: string = 'post';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  filePaths?: string[];

  @IsOptional()
  metadata?: Record<string, string>;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class UpdatePostDto {
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  textContent?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  /**
   * Merged into the post's metadata by content-service (an empty value
   * removes the key). Without this field the global whitelist stripped it,
   * so an edit's tags and cover never reached content-service (found Nov 12
   * 2026 while adding the cover edit).
   */
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;
}

export class FeedPostDto {
  id: string;
  authorId: string;
  contentType: string;
  textContent: string;
  filePaths: string[];
  metadata: Record<string, string>;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  author: {
    id: string;
    username: string;
    displayName: string;
    avatar: string | null;
    role: string | null;
  };
  interactions: {
    likesCount: number;
    commentsCount: number;
    sharesCount: number;
    repostsCount: number;
    isLiked: boolean;
    isBookmarked: boolean;
    isReposted: boolean;
  };
  /** true if the viewer follows the post author, false if suggested */
  isFollowingAuthor?: boolean;
}

export class UserPostsQueryDto {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export class FeedResponseDto {
  posts: FeedPostDto[];
  meta: {
    nextCursor: number | null;
    hasMore: boolean;
  };
}

export class ReelsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  limit?: number = 10;
}

export class ReelViewDto {
  @IsString()
  @IsNotEmpty()
  postId: string;

  @IsInt()
  @Min(0)
  watchMs: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  replays?: number;
}

export class ExploreQueryDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  cursor?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  @Type(() => Number)
  limit?: number;
}
