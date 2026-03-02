import {
  IsString,
  IsOptional,
  MaxLength,
  IsIn,
  IsObject,
} from "class-validator";

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  @IsIn(["active", "archived", "exported"])
  status?: string;

  @IsOptional()
  @IsObject()
  lanes?: Record<string, { name: string; color: string }>;
}
