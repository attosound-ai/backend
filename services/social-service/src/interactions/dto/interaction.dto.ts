import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateCommentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  comment: string;

  @IsOptional()
  @IsString()
  parentId?: string;
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

export class CommentResponseDto {
  id: string;
  userId: string;
  contentId: string;
  comment: string;
  parentId?: string | null;
  createdAt: string;
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
