export class AfrikartApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly errorType?: string,
    public readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AfrikartApiError';
  }

  get isRetryable(): boolean {
    return this.statusCode === 503 && this.errorType === 'PROVIDER_ERROR';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const jitter = (ms: number) => ms * (0.75 + Math.random() * 0.5);

export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 1_000,
  maxDelayMs = 8_000,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err instanceof AfrikartApiError && err.isRetryable;

      if (!isRetryable || attempt >= maxAttempts - 1) throw err;

      const delay = Math.min(
        jitter(baseDelayMs * Math.pow(2, attempt)),
        maxDelayMs,
      );
      attempt++;
      await sleep(delay);
    }
  }
}
