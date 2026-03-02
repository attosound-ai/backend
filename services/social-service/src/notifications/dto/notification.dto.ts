import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class NotificationPaginationDto {
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

export class NotificationResponseDto {
  id: string;
  recipientId: string;
  type: string;
  actorId: string;
  referenceId: string | null;
  isRead: boolean;
  createdAt: string;
  actor?: {
    id: string;
    username: string;
    displayName: string;
    avatar: string | null;
  };
}

export class UnreadCountResponseDto {
  count: number;
}
