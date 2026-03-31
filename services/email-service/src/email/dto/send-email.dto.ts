import { IsString, IsEmail, IsNumber, IsOptional, Min } from "class-validator";

export class SendOtpDto {
  @IsEmail()
  to!: string;

  @IsString()
  code!: string;

  @IsNumber()
  @Min(1)
  expiresMinutes!: number;

  @IsString()
  @IsOptional()
  locale?: string;

  @IsString()
  @IsOptional()
  purpose?: string;
}

export class SendPasswordResetDto {
  @IsEmail()
  to!: string;

  @IsString()
  code!: string;

  @IsNumber()
  @Min(1)
  expiresMinutes!: number;

  @IsString()
  @IsOptional()
  locale?: string;
}

export class SendInstructionsDto {
  @IsEmail()
  to!: string;

  @IsString()
  name!: string;

  @IsString()
  @IsOptional()
  bridgeNumber?: string;
}
