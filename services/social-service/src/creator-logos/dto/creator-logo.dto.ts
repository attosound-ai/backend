import { IsIn, IsInt } from 'class-validator';

export class VoteDto {
  @IsInt()
  @IsIn([1, 2, 3, 4, 5])
  rating: number;
}

export interface CreatorInfo {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
}

export class CreatorLogoDto {
  id: string;
  imageUrl: string;
  sortOrder: number;
  rating: number;
  ratingCount: number;
  userRating: number | null;
  creator: CreatorInfo | null;
}
