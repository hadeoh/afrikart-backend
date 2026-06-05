import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { PayoutsService } from './payouts.service';
import { Payout } from './schemas/payout.schema';
import { AfrikartService } from '../afrikart/afrikart.service';
import { AfrikartApiError } from '../../common/utils/retry.util';

// ─── In-memory payout store ───────────────────────────────────────────────────

function makePayoutStore() {
  const store: Map<string, any> = new Map();
  let idCounter = 0;

  const makeDoc = (data: any) => {
    const _id = `oid_${++idCounter}`;
    const doc = { _id, ...data };
    store.set(doc.customerReference, doc);

    const self = {
      ...doc,
      save: jest.fn(),
      $__: {},
    };

    Object.defineProperty(self, 'status', {
      get: () => store.get(doc.customerReference).status,
      set: (v) => { store.get(doc.customerReference).status = v; },
      enumerable: true,
    });

    return self;
  };

  return {
    store,
    model: {
      create: jest.fn(async (data: any) => {
        if (store.has(data.customerReference)) {
          const err: any = new Error('duplicate key');
          err.code = 11000;
          throw err;
        }
        return makeDoc(data);
      }),
      findOne: jest.fn(async ({ customerReference }: any) => {
        return store.get(customerReference) ?? null;
      }),
      findById: jest.fn(async (id: string) => {
        for (const v of store.values()) {
          if (v._id === id) return { ...v };
        }
        return null;
      }),
      findByIdAndUpdate: jest.fn(async (id: string, update: any, opts?: any) => {
        for (const [key, doc] of store.entries()) {
          if (doc._id === id) {
            if (update.$set) Object.assign(doc, update.$set);
            if (update.$push?.timeline) {
              doc.timeline = doc.timeline ?? [];
              doc.timeline.push(update.$push.timeline);
            }
            if (update.$inc?.attemptCount) doc.attemptCount = (doc.attemptCount ?? 0) + update.$inc.attemptCount;
            store.set(key, doc);
            return doc;
          }
        }
        return null;
      }),
      find: jest.fn(async (filter: any) => {
        const all = Array.from(store.values());
        if (!filter || Object.keys(filter).length === 0) return all;
        return all.filter((d) => {
          for (const [k, v] of Object.entries(filter)) {
            if (d[k] !== v) return false;
          }
          return true;
        });
      }),
    },
  };
}

// ─── Service factory ──────────────────────────────────────────────────────────

async function buildService(
  fincraOverrides: Partial<AfrikartService>,
  uncertaintyMs = 100_000,
) {
  const { store, model } = makePayoutStore();

  const module = await Test.createTestingModule({
    providers: [
      PayoutsService,
      { provide: getModelToken(Payout.name), useValue: model },
      {
        provide: AfrikartService,
        useValue: {
          verifyAccountNumber: jest.fn(),
          createPayout: jest.fn(),
          ...fincraOverrides,
        },
      },
      {
        provide: ConfigService,
        useValue: { get: (k: string) => k === 'payoutUncertaintyThresholdMs' ? uncertaintyMs : null },
      },
    ],
  }).compile();

  return { service: module.get<PayoutsService>(PayoutsService), store, model };
}

// ─── Test: verification failure → no payout ───────────────────────────────────

describe('PayoutsService — account verification failure', () => {
  it('fails safely when account is not found (no funds moved)', async () => {
    const { service, store } = await buildService({
      verifyAccountNumber: jest.fn().mockRejectedValue(
        new AfrikartApiError('Account not found', 404),
      ),
      createPayout: jest.fn(), // should never be called
    });

    await service.createPayout({
      customerReference: 'po-vendor-001',
      amount: 5000,
      recipient: { name: 'Bad Actor', accountNumber: '0000000009', bankCode: '058' },
    });

    const payout = store.get('po-vendor-001');
    expect(payout.status).toBe('verification_failed');
    // createPayout on FincraService should NOT have been called
  });

  it('fails when resolved account name does not match recipient name', async () => {
    const { service, store } = await buildService({
      verifyAccountNumber: jest.fn().mockResolvedValue({
        data: { resolved: true, accountName: 'COMPLETELY DIFFERENT NAME' },
      }),
      createPayout: jest.fn(),
    });

    await service.createPayout({
      customerReference: 'po-name-mismatch',
      amount: 3000,
      recipient: { name: 'Ada Lovelace', accountNumber: '0123456789', bankCode: '058' },
    });

    const payout = store.get('po-name-mismatch');
    expect(payout.status).toBe('verification_failed');
    expect(payout.timeline.some((e: any) => /mismatch/i.test(e.detail?.reason ?? ''))).toBe(true);
  });
});

// ─── Test: payout failure + fund restoration note ────────────────────────────

describe('PayoutsService — payout failure webhook', () => {
  it('transitions to failed and records the failure reason', async () => {
    const { service, store, model } = await buildService({
      verifyAccountNumber: jest.fn().mockResolvedValue({
        data: { resolved: true, accountName: 'Fatima Invalid' },
      }),
      createPayout: jest.fn().mockResolvedValue({
        data: { id: 'po_test', reference: 'payout_test', fee: 50, rate: 1 },
      }),
    });

    await service.createPayout({
      customerReference: 'po-fail-test',
      amount: 5000,
      recipient: { name: 'Fatima Invalid', accountNumber: '0000000009', bankCode: '058' },
    });

    // Payout should now be in PROCESSING
    expect(store.get('po-fail-test').status).toBe('processing');

    // Simulate the payout.failed webhook arriving
    await service.applyPayoutWebhook('po-fail-test', 'failed', {
      customerReference: 'po-fail-test',
      reason: 'Recipient bank rejected the transfer',
      id: 'po_test',
    });

    const payout = store.get('po-fail-test');
    expect(payout.status).toBe('failed');
    expect(payout.failureReason).toMatch(/rejected/i);
    // Fincra restores funds; the timeline records this happened
    const failEvent = payout.timeline.find((e: any) => e.to === 'failed');
    expect(failEvent).toBeDefined();
    expect(failEvent.actor).toBe('webhook');
  });

  it('does not regress from failed → processing on a duplicate webhook', async () => {
    const { service, store } = await buildService({
      verifyAccountNumber: jest.fn().mockResolvedValue({
        data: { resolved: true, accountName: 'Fatima Invalid' },
      }),
      createPayout: jest.fn().mockResolvedValue({
        data: { id: 'po_test2', reference: 'payout_test2', fee: 50, rate: 1 },
      }),
    });

    await service.createPayout({
      customerReference: 'po-no-regress',
      amount: 5000,
      recipient: { name: 'Fatima Invalid', accountNumber: '0000000009', bankCode: '058' },
    });

    await service.applyPayoutWebhook('po-no-regress', 'failed', { customerReference: 'po-no-regress' });
    expect(store.get('po-no-regress').status).toBe('failed');

    // Second webhook (e.g. replay) must not change state
    await service.applyPayoutWebhook('po-no-regress', 'successful', { customerReference: 'po-no-regress' });
    expect(store.get('po-no-regress').status).toBe('failed');
  });
});

// ─── Test: idempotency on payout creation ─────────────────────────────────────

describe('PayoutsService — payout creation idempotency', () => {
  it('returns the existing payout on a duplicate customerReference', async () => {
    const createFincra = jest.fn().mockResolvedValue({
      data: { id: 'po_idem', reference: 'payout_idem', fee: 50, rate: 1 },
    });

    const { service } = await buildService({
      verifyAccountNumber: jest.fn().mockResolvedValue({
        data: { resolved: true, accountName: 'Ada Lovelace' },
      }),
      createPayout: createFincra,
    });

    const dto = {
      customerReference: 'po-idem-001',
      amount: 10000,
      recipient: { name: 'Ada Lovelace', accountNumber: '0123456789', bankCode: '058' },
    };

    await service.createPayout(dto);
    await service.createPayout(dto); // second call — same ref
    await service.createPayout(dto); // third call

    // Fincra createPayout should have been called exactly once
    expect(createFincra).toHaveBeenCalledTimes(1);
  });
});

// ─── Test: slow payout does not trigger unsafe retry ─────────────────────────

describe('PayoutsService — slow payout (ends in 7)', () => {
  it('stays in processing until webhook arrives; does not re-submit', async () => {
    jest.useFakeTimers();

    const createFincra = jest.fn().mockResolvedValue({
      data: { id: 'po_slow', reference: 'payout_slow', fee: 50, rate: 1 },
    });

    const { service, store } = await buildService(
      {
        verifyAccountNumber: jest.fn().mockResolvedValue({
          data: { resolved: true, accountName: 'Chidi Timeout' },
        }),
        createPayout: createFincra,
      },
      100_000, // 100s threshold — well above the slow payout's ~15s
    );

    await service.createPayout({
      customerReference: 'po-slow-001',
      amount: 3000,
      recipient: { name: 'Chidi Timeout', accountNumber: '1111111117', bankCode: '044' },
    });

    // After submission it's PROCESSING
    expect(store.get('po-slow-001').status).toBe('processing');

    // Simulate webhook arriving after 15s
    jest.advanceTimersByTime(15_000);
    await service.applyPayoutWebhook('po-slow-001', 'successful', {
      customerReference: 'po-slow-001',
    });

    expect(store.get('po-slow-001').status).toBe('successful');
    // createPayout on FincraService called only once — no unsafe retry
    expect(createFincra).toHaveBeenCalledTimes(1);

    jest.useRealTimers();
  });
});
