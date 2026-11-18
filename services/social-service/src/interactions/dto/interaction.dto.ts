import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { SHARE_CHANNELS, ShareChannel } from '../post-shares';

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  comment: string;

  @IsOptional()
  @IsString()
  parentId?: string;
}

/**
 * Body of POST /posts/:id/share, optional: app builds before Nov 18 2026 send
 * none and count once per person. `conversationId` goes with `chat` only.
 */
export class ShareDto {
  @IsOptional()
  @IsIn(SHARE_CHANNELS as unknown as string[])
  channel?: ShareChannel;

  @IsOptional()
  @IsUUID('all')
  conversationId?: string;
}

export class InteractionPaginationDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class UpdateCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  comment: string;
}

export class CommentResponseDto {
  id: string;
  userId: string;
  contentId: string;
  comment: string;
  parentId?: string | null;
  createdAt: string;
  isEdited?: boolean;
  isDeleted?: boolean;
  author?: {
    id: string;
    username: string;
    displayName: string;
    avatar: string | null;
  };
  replies?: CommentResponseDto[];
}

export class InteractionCountsDto {
  likesCount: number;
  commentsCount: number;
  sharesCount: number;
  repostsCount: number;
}
