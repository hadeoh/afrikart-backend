import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
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

  const applyUpdate = (doc: any, update: any) => {
    if (update.$set) Object.assign(doc, update.$set);
    if (update.$push?.timeline) {
      doc.timeline = doc.timeline ?? [];
      doc.timeline.push(update.$push.timeline);
    }
    if (update.$inc?.attemptCount !== undefined) {
      doc.attemptCount = (doc.attemptCount ?? 0) + update.$inc.attemptCount;
    }
  };

  const matchesFilter = (doc: any, filter: any): boolean => {
    for (const [k, v] of Object.entries(filter)) {
      if (k === '_id') {
        if (doc._id !== v && String(doc._id) !== String(v)) return false;
      } else if (v && typeof v === 'object' && '$in' in (v as any)) {
        if (!(v as any).$in.includes(doc[k])) return false;
      } else if (v && typeof v === 'object' && '$lt' in (v as any)) {
        if (!(doc[k] < (v as any).$lt)) return false;
      } else if (doc[k] !== v) {
        return false;
      }
    }
    return true;
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

      findOne: jest.fn(async (filter: any) => {
        for (const doc of store.values()) {
          if (matchesFilter(doc, filter)) return { ...doc };
        }
        return null;
      }),

      findById: jest.fn(async (id: string) => {
        for (const doc of store.values()) {
          if (doc._id === id) return { ...doc };
        }
        return null;
      }),

      // Used by transition() in the sequential create flow
      findByIdAndUpdate: jest.fn(async (id: string, update: any) => {
        for (const [key, doc] of store.entries()) {
          if (doc._id === id) {
            applyUpdate(doc, update);
            store.set(key, doc);
            return { ...doc };
          }
        }
        return null;
      }),

      // Used by applyPayoutWebhook and recoverUncertainPayouts — includes the
      // status filter as an atomic guard so only valid transitions win.
      findOneAndUpdate: jest.fn(async (filter: any, update: any) => {
        for (const [key, doc] of store.entries()) {
          if (!matchesFilter(doc, filter)) continue;
          applyUpdate(doc, update);
          store.set(key, doc);
          return { ...doc };
        }
        return null;
      }),

      find: jest.fn((filter: any) => {
        const results = Array.from(store.values()).filter((d) =>
          matchesFilter(d, filter ?? {}),
        );
        const promise = Promise.resolve(results);
        return {
          lean: () => promise,
          sort: () => ({ lean: () => promise }),
        };
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
        useValue: {
          get: (k: string) =>
            k === 'payoutUncertaintyThresholdMs' ? uncertaintyMs : null,
        },
      },
    ],
  }).compile();

  const service = module.get<PayoutsService>(PayoutsService);
  return { service, store, model };
}

// ─── Test: verification failure → no payout ───────────────────────────────────

describe('PayoutsService — account verification failure', () => {
  it('fails safely when account is not found (no funds moved)', async () => {
    const { service, store } = await buildService({
      verifyAccountNumber: jest.fn().mockRejectedValue(
        new AfrikartApiError('Account not found', 404),
      ),
      createPayout: jest.fn(),
    });

    await service.createPayout({
      customerReference: 'po-vendor-001',
      amount: 5000,
      recipient: { name: 'Bad Actor', accountNumber: '0000000009', bankCode: '058' },
    });

    expect(store.get('po-vendor-001').status).toBe('verification_failed');
  });

  it('does not set walletCreditAt on verification_failed (funds were never debited)', async () => {
    const { service, store } = await buildService({
      verifyAccountNumber: jest.fn().mockRejectedValue(
        new AfrikartApiError('Account not found', 404),
      ),
      createPayout: jest.fn(),
    });

    await service.createPayout({
      customerReference: 'po-no-credit',
      amount: 1000,
      recipient: { name: 'Ghost', accountNumber: '0000000001', bankCode: '058' },
    });

    const payout = store.get('po-no-credit');
    expect(payout.status).toBe('verification_failed');
    expect(payout.walletCreditAt ?? null).toBeNull();
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
    const { service, store } = await buildService({
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

    expect(store.get('po-fail-test').status).toBe('processing');

    await service.applyPayoutWebhook('po-fail-test', 'failed', {
      customerReference: 'po-fail-test',
      reason: 'Recipient bank rejected the transfer',
      id: 'po_test',
    });

    const payout = store.get('po-fail-test');
    expect(payout.status).toBe('failed');
    expect(payout.failureReason).toMatch(/rejected/i);
    // walletCreditAt must be set — funds were submitted so Fincra credited them back
    expect(payout.walletCreditAt).toBeInstanceOf(Date);
    const failEvent = payout.timeline.find((e: any) => e.to === 'failed');
    expect(failEvent).toBeDefined();
    expect(failEvent.actor).toBe('webhook');
  });

  it('does not regress from failed → successful on a duplicate webhook', async () => {
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

    // Replay or crossed webhook must not change a terminal state
    await service.applyPayoutWebhook('po-no-regress', 'successful', { customerReference: 'po-no-regress' });
    expect(store.get('po-no-regress').status).toBe('failed');
  });
});

// ─── Test: idempotency on payout creation ─────────────────────────────────────

describe('PayoutsService — payout creation idempotency', () => {
  it('returns the existing payout and calls the provider exactly once', async () => {
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
    await service.createPayout(dto);
    await service.createPayout(dto);

    expect(createFincra).toHaveBeenCalledTimes(1);
  });
});

// ─── Test: slow payout does not re-submit ─────────────────────────────────────

describe('PayoutsService — slow payout', () => {
  it('stays in processing until webhook arrives; webhook resolves it correctly', async () => {
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
      100_000,
    );

    await service.createPayout({
      customerReference: 'po-slow-001',
      amount: 3000,
      recipient: { name: 'Chidi Timeout', accountNumber: '1111111117', bankCode: '044' },
    });

    expect(store.get('po-slow-001').status).toBe('processing');

    await service.applyPayoutWebhook('po-slow-001', 'successful', {
      customerReference: 'po-slow-001',
    });

    expect(store.get('po-slow-001').status).toBe('successful');
    expect(createFincra).toHaveBeenCalledTimes(1);
  });
});

// ─── Test: uncertainty recovery on startup ────────────────────────────────────

describe('PayoutsService — uncertainty recovery (onModuleInit)', () => {
  afterEach(() => jest.useRealTimers());

  it('marks processing payouts older than threshold as uncertain on startup', async () => {
    jest.useFakeTimers();

    const { service, store } = await buildService(
      {
        verifyAccountNumber: jest.fn().mockResolvedValue({
          data: { resolved: true, accountName: 'Recovery Test' },
        }),
        createPayout: jest.fn().mockResolvedValue({
          data: { id: 'po_rec', reference: 'payout_rec' },
        }),
      },
      60_000,
    );

    await service.createPayout({
      customerReference: 'po-recovery',
      amount: 5000,
      recipient: { name: 'Recovery Test', accountNumber: '1234567890', bankCode: '058' },
    });

    // Simulate a past submission timestamp — as if the process restarted
    // 2 minutes after submission (well beyond the 60s threshold)
    const payout = store.get('po-recovery');
    payout.submittedToProviderAt = new Date(Date.now() - 120_000);
    store.set('po-recovery', payout);

    expect(store.get('po-recovery').status).toBe('processing');

    // onModuleInit runs the recovery scan immediately on startup
    await service.onModuleInit();
    await service.onModuleDestroy(); // clean up the interval

    expect(store.get('po-recovery').status).toBe('uncertain');
  });

  it('does not mark a payout uncertain if a webhook already settled it', async () => {
    jest.useFakeTimers();

    const { service, store } = await buildService(
      {
        verifyAccountNumber: jest.fn().mockResolvedValue({
          data: { resolved: true, accountName: 'Fast Settler' },
        }),
        createPayout: jest.fn().mockResolvedValue({
          data: { id: 'po_fast', reference: 'payout_fast' },
        }),
      },
      60_000,
    );

    await service.createPayout({
      customerReference: 'po-already-settled',
      amount: 2000,
      recipient: { name: 'Fast Settler', accountNumber: '9876543210', bankCode: '033' },
    });

    // Webhook arrives and settles the payout
    await service.applyPayoutWebhook('po-already-settled', 'successful', {});
    expect(store.get('po-already-settled').status).toBe('successful');

    // Backdate as if it's stale
    const payout = store.get('po-already-settled');
    payout.submittedToProviderAt = new Date(Date.now() - 120_000);
    store.set('po-already-settled', payout);

    // Recovery scan — findOneAndUpdate filter includes status:'processing'
    // so it will NOT match a 'successful' payout
    await service.onModuleInit();
    await service.onModuleDestroy();

    expect(store.get('po-already-settled').status).toBe('successful');
  });
});
