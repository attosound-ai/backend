import { IsInt, IsOptional, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class PaginationQueryDto {
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

export class FollowResponseDto {
  id: string;
  followerId: string;
  followingId: string;
  createdAt: string;
}

export class UserSummaryDto {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  bio: string | null;
  isFollowing?: boolean;
}

export class FollowersListResponseDto {
  users: UserSummaryDto[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
