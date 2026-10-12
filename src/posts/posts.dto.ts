import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { PostStatus, PublicationMode } from '../generated/prisma/client.js';

export class PostCreateDto {
  @IsUUID()
  channelId!: string;

  @IsOptional()
  @IsUUID()
  topicId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string | null;

  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  prompt!: string;

  @IsOptional()
  @IsBoolean()
  generateImage = false;

  @IsEnum(PublicationMode)
  publicationMode!: PublicationMode;
}

export class PostUpdateDto {
  @IsOptional()
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsUUID()
  topicId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  title?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  prompt?: string;

  @IsOptional()
  @IsBoolean()
  generateImage?: boolean;

  @IsOptional()
  @IsEnum(PublicationMode)
  publicationMode?: PublicationMode;
}

export class PostListQuery {
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
  @IsUUID()
  channelId?: string;

  @IsOptional()
  @IsEnum(PostStatus)
  status?: PostStatus;
}

export class PostVersionListQuery {
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
}
