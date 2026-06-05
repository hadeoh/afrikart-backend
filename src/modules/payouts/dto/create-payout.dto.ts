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

class RecipientDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  accountNumber: string;

  @IsString()
  @IsNotEmpty()
  bankCode: string;

  @IsEmail()
  @IsOptional()
  email?: string;
}

export class CreatePayoutDto {
  // Caller-supplied stable key — becomes the idempotency lock.
  // Example: "vendor_settlement_order_1001" or "payout_vendor42_inv_5678"
  @IsString()
  @IsNotEmpty()
  customerReference: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsOptional()
  sourceCurrency?: string;

  @IsString()
  @IsOptional()
  destinationCurrency?: string;

  @IsString()
  @IsOptional()
  narration?: string;

  @IsString()
  @IsOptional()
  quoteReference?: string;

  // Optional link to the collection that funded this payout
  @IsString()
  @IsOptional()
  sourceTransactionRef?: string;

  @ValidateNested()
  @Type(() => RecipientDto)
  recipient: RecipientDto;
}
