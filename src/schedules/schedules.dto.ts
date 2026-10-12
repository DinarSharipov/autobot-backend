import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { MisfirePolicy, ScheduleKind, ScheduleStatus } from '../generated/prisma/client.js';

export class ScheduleCreateDto {
  @IsUUID()
  postId!: string;

  @IsEnum(ScheduleKind)
  kind!: ScheduleKind;

  @IsString()
  @MaxLength(128)
  timezone!: string;

  @IsOptional()
  @IsISO8601()
  runAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  rrule?: string;

  @IsOptional()
  @IsEnum(MisfirePolicy)
  misfirePolicy?: MisfirePolicy;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(604800)
  misfireGraceSeconds?: number;
}

export class ScheduleUpdateDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  timezone?: string;

  @IsOptional()
  @IsISO8601()
  runAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  rrule?: string;

  @IsOptional()
  @IsEnum(MisfirePolicy)
  misfirePolicy?: MisfirePolicy;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(604800)
  misfireGraceSeconds?: number;
}

export class ScheduleListQuery {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;

  @IsOptional()
  @IsEnum(ScheduleStatus)
  status?: ScheduleStatus;
}
