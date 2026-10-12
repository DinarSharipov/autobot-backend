import { Type } from 'class-transformer';
import { IsEnum, IsOptional, IsString, IsUUID, MaxLength, Min, IsInt } from 'class-validator';

import { PublicationStatus } from '../generated/prisma/client.js';

export class PublicationListQuery {
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit = 25;

  @IsOptional()
  @IsEnum(PublicationStatus)
  status?: PublicationStatus;

  @IsOptional()
  @IsUUID()
  postId?: string;
}
