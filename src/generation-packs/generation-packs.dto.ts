import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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

import { CreditType } from '../generated/prisma/client.js';

export class GenerationPacksListQuery {
  @ApiPropertyOptional({ enum: CreditType })
  @IsOptional()
  @IsEnum(CreditType)
  creditType?: CreditType;
}

export class WalletLedgerQuery {
  @ApiPropertyOptional({ enum: CreditType })
  @IsOptional()
  @IsEnum(CreditType)
  creditType?: CreditType;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class PurchaseOrderCreateDto {
  @ApiProperty({
    example: 'text-20',
    description: 'Server catalogue code; the client cannot supply quantity or price.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  packCode!: string;
}
