import { IsEmail, IsNotEmpty, IsNumber, IsObject, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class CustomerDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;
}

export class InitiateCheckoutDto {
  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  @IsOptional()
  currency?: string;

  // Optional: caller may supply a reference; we generate one if absent
  @IsString()
  @IsOptional()
  reference?: string;

  @IsString()
  @IsOptional()
  feeBearer?: string;

  @ValidateNested()
  @Type(() => CustomerDto)
  customer: CustomerDto;

  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  redirectUrl?: string;
}
