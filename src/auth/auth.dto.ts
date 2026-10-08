import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class TelegramLoginStartQuery {
  @ApiProperty({ format: 'uri', example: 'https://web.example.test/app/' })
  @IsUrl({ require_protocol: true, require_tld: false, protocols: ['http', 'https'] })
  returnTo!: string;
}

export class TelegramLoginCallbackQuery {
  @ApiProperty()
  @IsString()
  @MaxLength(2048)
  state!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  error?: string;
}

export class TelegramProfileInput {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  username?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  firstName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  lastName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  languageCode?: string | null;
}
