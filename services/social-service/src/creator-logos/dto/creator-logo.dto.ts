import { IsIn, IsInt } from 'class-validator';

export class VoteDto {
  @IsInt()
  @IsIn([1, -1])
  vote: number;
}

export class CreatorLogoDto {
  id: string;
  imageUrl: string;
  sortOrder: number;
  likes: number;
  dislikes: number;
  userVote: number | null; // 1, -1, or null
}
