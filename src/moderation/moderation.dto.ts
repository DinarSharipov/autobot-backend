import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ModerationStatus } from '../generated/prisma/client.js';

export class ModerationListQuery {
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
  @IsEnum(ModerationStatus)
  status?: ModerationStatus;
}

export class ModerationRevisionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  feedback!: string;
}
