import { IsEmail, IsNotEmpty, IsNumber, IsObject, IsOptional, IsPositive, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

class CustomerDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'ada@example.com' })
  @IsEmail()
  email: string;
}

export class InitiateCheckoutDto {
  @ApiProperty({ example: 5000, description: 'Amount in smallest currency unit' })
  @IsNumber()
  @IsPositive()
  amount: number;

  @ApiPropertyOptional({ example: 'NGN', default: 'NGN' })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ example: 'ord_abc123', description: 'Your stable order reference — doubles as idempotency key' })
  @IsString()
  @IsOptional()
  reference?: string;

  @ApiPropertyOptional({ enum: ['business', 'customer'] })
  @IsString()
  @IsOptional()
  feeBearer?: string;

  @ApiProperty({ type: CustomerDto })
  @ValidateNested()
  @Type(() => CustomerDto)
  customer: CustomerDto;

  @ApiPropertyOptional({ example: { orderId: 'shop_001' } })
  @IsObject()
  @IsOptional()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 'https://myshop.com/thank-you' })
  @IsString()
  @IsOptional()
  redirectUrl?: string;

  @ApiPropertyOptional({ example: 'ORD-789', description: 'Business-level order ID — prevents opening a second collection method for the same order' })
  @IsString()
  @IsOptional()
  orderId?: string;
}
