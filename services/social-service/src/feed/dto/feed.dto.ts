import {
  IsArray,
  IsInt,
  IsNotEmpty,
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
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  textContent: string;

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
