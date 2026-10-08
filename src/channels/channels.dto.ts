import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { ChannelStatus } from '../generated/prisma/client.js';

export class ChannelCreateDto {
  @IsString()
  @Matches(/^-?[1-9]\d*$/)
  telegramChatId!: string;
}

export class ChannelUpdateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  title!: string;
}

export class ChannelListQuery {
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
  @IsEnum(ChannelStatus)
  status?: ChannelStatus;
}
