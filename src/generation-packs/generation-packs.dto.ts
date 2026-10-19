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
  @IsOptional()
  @IsEnum(CreditType)
  creditType?: CreditType;
}

export class WalletLedgerQuery {
  @IsOptional()
  @IsEnum(CreditType)
  creditType?: CreditType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class PurchaseOrderCreateDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  packCode!: string;
}
