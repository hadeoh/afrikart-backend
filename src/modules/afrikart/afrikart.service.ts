import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosError } from 'axios';
import { AfrikartApiError, withRetry } from '../../common/utils/retry.util';

// ─── Request/response shapes mirrored from API.md ──────────────────────────

export interface CheckoutInitiateDto {
  amount: number;
  currency?: string;
  reference: string;
  feeBearer?: string;
  customer: { name: string; email: string };
  metadata?: Record<string, unknown>;
  redirectUrl?: string;
}

export interface PayoutDto {
  amount: number;
  sourceCurrency?: string;
  destinationCurrency?: string;
  customerReference: string;
  narration?: string;
  quoteReference?: string;
  recipient: {
    name: string;
    accountNumber: string;
    bankCode: string;
    email?: string;
  };
}

export interface VerifyAccountDto {
  accountNumber: string;
  bankCode: string;
}

@Injectable()
export class AfrikartService implements OnModuleInit {
  private readonly logger = new Logger(AfrikartService.name);
  private secretHttp: AxiosInstance;
  private publicHttp: AxiosInstance;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const baseURL = this.config.get<string>('afrikart.baseUrl');
    const secretKey = this.config.get<string>('afrikart.secretKey');
    const publicKey = this.config.get<string>('afrikart.publicKey');

    if (!baseURL || !secretKey || !publicKey) {
      throw new Error(
        'Configuration incomplete: AFRIKART_BASE_URL, AFRIKART_SECRET_KEY, and AFRIKART_PUBLIC_KEY are required',
      );
    }

    this.secretHttp = axios.create({
      baseURL,
      headers: { 'api-key': secretKey, 'content-type': 'application/json' },
      timeout: 30_000,
    });

    this.publicHttp = axios.create({
      baseURL,
      headers: { 'x-pub-key': publicKey, 'content-type': 'application/json' },
      timeout: 30_000,
    });
  }

  // ─── Collections ──────────────────────────────────────────────────────────

  async initiateCheckout(dto: CheckoutInitiateDto) {
    return this.callWithRetry(() => this.publicHttp.post('/checkout/initiate', dto));
  }

  // ─── Virtual accounts ─────────────────────────────────────────────────────

  async createVirtualAccount(dto: {
    reference: string;
    currency?: string;
    isPermanent?: boolean;
    expiresInMinutes?: number;
    customer: { name: string; email: string; bvn?: string };
  }) {
    return this.callWithRetry(() =>
      this.secretHttp.post('/profile/virtual-accounts/requests', dto),
    );
  }

  async getVirtualAccount(virtualAccountId: string) {
    return this.callWithRetry(() =>
      this.secretHttp.get(`/profile/virtual-accounts/${virtualAccountId}`),
    );
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  async verifyAccountNumber(dto: VerifyAccountDto) {
    return this.callWithRetry(() =>
      this.secretHttp.post('/identity/verify-account-number', dto),
    );
  }

  // ─── Payouts ──────────────────────────────────────────────────────────────

  async createPayout(dto: PayoutDto, idempotencyKey: string) {
    return this.callWithRetry(() =>
      this.secretHttp.post('/disbursements/payouts/bank', dto, {
        headers: { 'x-idempotency-key': idempotencyKey },
      }),
    );
  }

  // ─── Wallets ──────────────────────────────────────────────────────────────

  async getWalletLogs(currency?: string, type?: string, page = 1, limit = 20) {
    return this.callWithRetry(() =>
      this.secretHttp.get('/wallets/logs', {
        params: { currency, type, page, limit },
      }),
    );
  }

  // ─── Events ───────────────────────────────────────────────────────────────

  async getEvents(event?: string, limit = 50) {
    return this.callWithRetry(() =>
      this.secretHttp.get('/events', { params: { event, limit } }),
    );
  }

  // ─── Internal HTTP wrapper ─────────────────────────────────────────────────

  private async callWithRetry<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    return withRetry(async () => {
      try {
        const res = await fn();
        return res.data as T;
      } catch (err) {
        if (err instanceof AxiosError && err.response) {
          const { status, data } = err.response;
          throw new AfrikartApiError(
            data?.error ?? err.message,
            status,
            data?.errorType,
            data?.retryAfter,
          );
        }
        throw err;
      }
    });
  }
}
