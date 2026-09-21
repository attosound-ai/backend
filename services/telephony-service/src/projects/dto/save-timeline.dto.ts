import {
  IsArray,
  IsString,
  IsInt,
  IsOptional,
  IsNumber,
  IsObject,
  ValidateNested,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export class TimelineClipDto {
  @IsString()
  segmentId: string;

  @IsInt()
  @Min(0)
  startInSegment: number;

  @IsInt()
  @Min(0)
  endInSegment: number;

  @IsInt()
  @Min(0)
  positionInTimeline: number;

  @IsInt()
  @Min(0)
  order: number;

  @IsOptional()
  @IsNumber()
  volume?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  laneIndex?: number;

  /** Dry original when `segmentId` is an effects render (see entity). */
  @IsOptional()
  @IsString()
  sourceSegmentId?: string | null;

  /** Effect chain that produced the rendered segment (opaque client JSON). */
  @IsOptional()
  @IsObject()
  effects?: Record<string, unknown> | null;
}

export class SaveTimelineDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimelineClipDto)
  clips: TimelineClipDto[];
}
