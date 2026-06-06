/// <reference types="jest" />
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { WebhooksService } from './webhooks.service';
import { ProcessedWebhook } from './schemas/processed-webhook.schema';
import { CollectionsService } from '../collections/collections.service';
import { PayoutsService } from '../payouts/payouts.service';

const WEBHOOK_SECRET = 'whsec_test';

function makeSignature(payload: object): string {
  return createHmac('sha512', WEBHOOK_SECRET)
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProcessedModel(savedIds: Set<string>, stored: Map<string, any> = new Map()) {
  return {
    create: jest.fn(async (doc: { eventId: string; externalPaymentId?: string | null }) => {
      if (savedIds.has(doc.eventId)) {
        const err: any = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      savedIds.add(doc.eventId);
      stored.set(doc.eventId, doc);
      return doc;
    }),
  };
}

async function buildService(overrides: {
  processedModel?: any;
  collectionsService?: Partial<CollectionsService>;
  payoutsService?: Partial<PayoutsService>;
}) {
  const { processedModel, collectionsService, payoutsService } = overrides;

  const module = await Test.createTestingModule({
    providers: [
      WebhooksService,
      {
        provide: getModelToken(ProcessedWebhook.name),
        useValue: processedModel ?? makeProcessedModel(new Set()),
      },
      {
        provide: ConfigService,
        useValue: {
          get: (key: string) => {
            if (key === 'afrikart.webhookSecret') return WEBHOOK_SECRET;
          },
        },
      },
      {
        provide: CollectionsService,
        useValue: { applyCollectionWebhook: jest.fn(), ...collectionsService },
      },
      {
        provide: PayoutsService,
        useValue: { applyPayoutWebhook: jest.fn(), ...payoutsService },
      },
    ],
  }).compile();

  return module.get<WebhooksService>(WebhooksService);
}

// ─── Test: HMAC signature verification ───────────────────────────────────────

describe('WebhooksService.verifySignature', () => {
  it('accepts a valid HMAC-SHA512 signature', async () => {
    const svc = await buildService({});
    const payload = { event: 'collection.successful', data: { reference: 'ord_1' } };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = makeSignature(payload);
    expect(svc.verifySignature(raw, sig)).toBe(true);
  });

  it('rejects a forged / tampered signature', async () => {
    const svc = await buildService({});
    const payload = { event: 'collection.successful', data: { reference: 'ord_1' } };
    const raw = Buffer.from(JSON.stringify(payload));
    const forgery = 'a'.repeat(128); // wrong hex string, same length
    expect(svc.verifySignature(raw, forgery)).toBe(false);
  });

  it('rejects a valid signature applied to a different payload (body tampering)', async () => {
    const svc = await buildService({});
    const original = { event: 'collection.successful', data: { reference: 'ord_1', amountCredited: 100 } };
    const tampered = { event: 'collection.successful', data: { reference: 'ord_1', amountCredited: 99999 } };
    const sig = makeSignature(original); // signed over original
    const raw = Buffer.from(JSON.stringify(tampered)); // body was changed
    expect(svc.verifySignature(raw, sig)).toBe(false);
  });
});

// ─── Test: externalPaymentId stored in processed_webhooks ────────────────────

describe('WebhooksService.handleEvent — externalPaymentId audit link', () => {
  it('stores data.id as externalPaymentId so processed_webhooks joins to Transaction', async () => {
    const savedIds = new Set<string>();
    const stored = new Map<string, any>();

    const svc = await buildService({
      processedModel: makeProcessedModel(savedIds, stored),
      collectionsService: { applyCollectionWebhook: jest.fn().mockResolvedValue(undefined) },
    });

    const paymentId = 'txn_abc123';
    const data = { reference: 'ord_xyz', id: paymentId };

    await svc.handleEvent(paymentId, 'collection.successful', data);

    const record = stored.get(paymentId);
    expect(record).toBeDefined();
    expect(record.externalPaymentId).toBe(paymentId);
  });

  it('stores null externalPaymentId when data.id is absent', async () => {
    const savedIds = new Set<string>();
    const stored = new Map<string, any>();

    const svc = await buildService({
      processedModel: makeProcessedModel(savedIds, stored),
      collectionsService: { applyCollectionWebhook: jest.fn().mockResolvedValue(undefined) },
    });

    const data = { reference: 'ord_no_id' };
    const eventId = 'collection.successful:ord_no_id';

    await svc.handleEvent(eventId, 'collection.successful', data);

    const record = stored.get(eventId);
    expect(record).toBeDefined();
    expect(record.externalPaymentId).toBeNull();
  });
});

// ─── Test: duplicate webhook delivery ────────────────────────────────────────

describe('WebhooksService.handleEvent — duplicate delivery', () => {
  it('processes the first delivery and skips the second (no double credit)', async () => {
    const savedIds = new Set<string>();
    const applyCollectionWebhook = jest.fn().mockResolvedValue(undefined);

    const svc = await buildService({
      processedModel: makeProcessedModel(savedIds),
      collectionsService: { applyCollectionWebhook },
    });

    const eventId = 'evt_test_001';
    const data = { reference: 'ord_abc', id: eventId };

    // First delivery
    const first = await svc.handleEvent(eventId, 'collection.successful', data);
    expect(first.processed).toBe(true);
    expect(applyCollectionWebhook).toHaveBeenCalledTimes(1);

    // Second delivery (replay)
    const second = await svc.handleEvent(eventId, 'collection.successful', data);
    expect(second.processed).toBe(false);
    expect(second.reason).toBe('duplicate');
    // applyCollectionWebhook must NOT have been called a second time
    expect(applyCollectionWebhook).toHaveBeenCalledTimes(1);
  });

  it('concurrent duplicate deliveries: exactly one wins the DB race', async () => {
    const savedIds = new Set<string>();
    const applyCollectionWebhook = jest.fn().mockResolvedValue(undefined);
    const svc = await buildService({
      processedModel: makeProcessedModel(savedIds),
      collectionsService: { applyCollectionWebhook },
    });

    const eventId = 'evt_concurrent';
    const data = { reference: 'ord_concurrent', id: eventId };

    const [r1, r2] = await Promise.all([
      svc.handleEvent(eventId, 'collection.successful', data),
      svc.handleEvent(eventId, 'collection.successful', data),
    ]);

    const processed = [r1, r2].filter((r) => r.processed).length;
    const skipped = [r1, r2].filter((r) => !r.processed).length;
    expect(processed).toBe(1);
    expect(skipped).toBe(1);
    expect(applyCollectionWebhook).toHaveBeenCalledTimes(1);
  });
});
