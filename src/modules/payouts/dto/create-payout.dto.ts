import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class RecipientDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: '0123456789' })
  @IsString()
  @IsNotEmpty()
  accountNumber: string;

  @ApiProperty({ example: '058', description: 'CBN bank code' })
  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @ApiPropertyOptional({ example: 'ada@example.com' })
  @IsEmail()
  @IsOptional()
  email?: string;
}

export class CreatePayoutDto {
  @ApiProperty({ example: 'vendor_settlement_inv_1001', description: 'Caller-supplied stable key — idempotency lock for payout creation' })
  @IsString()
  @IsNotEmpty()
  customerReference: string;

  @ApiProperty({ example: 50000 })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiPropertyOptional({ example: 'NGN', default: 'NGN' })
  @IsString()
  @IsOptional()
  sourceCurrency?: string;

  @ApiPropertyOptional({ example: 'NGN', default: 'NGN' })
  @IsString()
  @IsOptional()
  destinationCurrency?: string;

  @ApiPropertyOptional({ example: 'Vendor settlement for order #1001' })
  @IsString()
  @IsOptional()
  narration?: string;

  @ApiPropertyOptional({ example: 'qr_abc123' })
  @IsString()
  @IsOptional()
  quoteReference?: string;

  @ApiPropertyOptional({ example: 'ord_17abc', description: 'Links this payout to the collection that funded it' })
  @IsString()
  @IsOptional()
  sourceTransactionRef?: string;

  @ApiProperty({ type: RecipientDto })
  @ValidateNested()
  @Type(() => RecipientDto)
  recipient: RecipientDto;

  @ApiPropertyOptional({ example: 'fincra', description: 'Payment provider — defaults to fincra' })
  @IsString()
  @IsOptional()
  provider?: string;
}
