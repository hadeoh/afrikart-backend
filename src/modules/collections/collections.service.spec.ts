import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { CollectionsService } from './collections.service';
import { Transaction } from './schemas/transaction.schema';
import { AfrikartService } from '../afrikart/afrikart.service';

// ─── In-memory transaction store ─────────────────────────────────────────────

function makeTransactionStore() {
  const store = new Map<string, any>();
  let idCounter = 0;

  const makeDoc = (data: any) => {
    const doc = { _id: `tid_${++idCounter}`, ...data };
    store.set(doc.internalRef, doc);
    return doc;
  };

  const findOneSync = (filter: any): any => {
    if (filter.internalRef !== undefined) return store.get(filter.internalRef) ?? null;
    if (filter.orderId !== undefined) {
      for (const doc of store.values()) {
        if (doc.orderId === filter.orderId) return doc;
      }
      return null;
    }
    return null;
  };

  return {
    store,
    model: {
      create: jest.fn(async (data: any) => makeDoc(data)),

      findOne: jest.fn((filter: any) => {
        const result = findOneSync(filter);
        const copy = result ? { ...result } : null;
        const p = Promise.resolve(copy);
        return { lean: () => p, then: p.then.bind(p), catch: p.catch.bind(p) };
      }),

      findOneAndUpdate: jest.fn(async (filter: any, update: any) => {
        const doc = findOneSync(filter);
        if (!doc) return null;
        if (filter.status !== undefined && doc.status !== filter.status) return null;
        if (update.$set) {
          for (const [key, val] of Object.entries(update.$set)) {
            if (key.includes('.')) {
              const parts = key.split('.');
              let obj = doc;
              for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
              obj[parts[parts.length - 1]] = val;
            } else {
              doc[key] = val;
            }
          }
        }
        if (update.$push?.timeline) {
          doc.timeline = doc.timeline ?? [];
          doc.timeline.push(update.$push.timeline);
        }
        store.set(doc.internalRef, doc);
        return { ...doc };
      }),
    },
  };
}

// ─── Service factory ──────────────────────────────────────────────────────────

async function buildService(afrikartOverrides: Partial<AfrikartService> = {}) {
  const { store, model } = makeTransactionStore();

  const module = await Test.createTestingModule({
    providers: [
      CollectionsService,
      { provide: getModelToken(Transaction.name), useValue: model },
      {
        provide: AfrikartService,
        useValue: {
          initiateCheckout: jest.fn().mockResolvedValue({
            data: { payment: { id: 'txn_test' }, checkoutUrl: 'https://pay.example.com/checkout' },
          }),
          ...afrikartOverrides,
        },
      },
    ],
  }).compile();

  return { service: module.get<CollectionsService>(CollectionsService), store, model };
}

// ─── Checkout ─────────────────────────────────────────────────────────────────

describe('CollectionsService — checkout', () => {
  it('creates a new checkout and marks idempotent:false', async () => {
    const { service, store } = await buildService();

    const result = await service.initiateCheckout({
      amount: 5000,
      customer: { name: 'Ada', email: 'ada@test.com' },
    });

    expect(result.idempotent).toBe(false);
    expect(result.collectionMethod).toBe('checkout');
    expect(result.checkoutUrl).toBe('https://pay.example.com/checkout');
    expect(store.size).toBe(1);
  });

  it('returns idempotent:true and current status on repeated reference', async () => {
    const initiateCheckout = jest.fn().mockResolvedValue({
      data: { payment: { id: 'txn_idem' }, checkoutUrl: 'https://pay.example.com/idem' },
    });
    const { service, store } = await buildService({ initiateCheckout });

    const dto = { amount: 1000, reference: 'ord_idem', customer: { name: 'Ada', email: 'ada@test.com' } };

    const first = await service.initiateCheckout(dto);
    expect(first.idempotent).toBe(false);

    store.get('ord_idem').status = 'successful';

    const second = await service.initiateCheckout(dto);
    expect(second.idempotent).toBe(true);
    expect(second.status).toBe('successful');
    expect(initiateCheckout).toHaveBeenCalledTimes(1);
  });

  it('throws 409 when orderId already has an active collection', async () => {
    const { service } = await buildService();

    await service.initiateCheckout({
      amount: 5000,
      orderId: 'ORD-001',
      customer: { name: 'Ada', email: 'ada@test.com' },
    });

    await expect(
      service.initiateCheckout({
        amount: 5000,
        orderId: 'ORD-001',
        customer: { name: 'Ada', email: 'ada@test.com' },
        reference: 'ord_different_ref',
      }),
    ).rejects.toThrow(ConflictException);
  });
});

// ─── Collection webhook ───────────────────────────────────────────────────────

describe('CollectionsService — applyCollectionWebhook', () => {
  it('advances status from pending → successful', async () => {
    const { service, store } = await buildService();

    await service.initiateCheckout({ amount: 3000, customer: { name: 'Bob', email: 'bob@test.com' }, reference: 'ord_wh1' });
    expect(store.get('ord_wh1').status).toBe('pending');

    await service.applyCollectionWebhook('ord_wh1', 'successful', { id: 'txn_wh1', paymentSource: 'bank_transfer', fee: 30, vat: 0 });

    expect(store.get('ord_wh1').status).toBe('successful');
    expect(store.get('ord_wh1').channel).toBe('bank_transfer');
    expect(store.get('ord_wh1').feeAmount).toBe(30);
  });

  it('advances status from pending → failed', async () => {
    const { service, store } = await buildService();

    await service.initiateCheckout({ amount: 1000, customer: { name: 'Bob', email: 'bob@test.com' }, reference: 'ord_wh2' });
    await service.applyCollectionWebhook('ord_wh2', 'failed', {});

    expect(store.get('ord_wh2').status).toBe('failed');
  });

  it('is a no-op when already settled (duplicate idempotency)', async () => {
    const { service, store } = await buildService();

    await service.initiateCheckout({ amount: 2000, customer: { name: 'Bob', email: 'bob@test.com' }, reference: 'ord_wh3' });
    await service.applyCollectionWebhook('ord_wh3', 'successful', {});
    expect(store.get('ord_wh3').status).toBe('successful');

    await service.applyCollectionWebhook('ord_wh3', 'failed', {});
    expect(store.get('ord_wh3').status).toBe('successful');
  });
});

// ─── getByRef ─────────────────────────────────────────────────────────────────

describe('CollectionsService — getByRef', () => {
  it('returns the transaction for a known reference', async () => {
    const { service } = await buildService();

    await service.initiateCheckout({ amount: 500, customer: { name: 'Zara', email: 'zara@test.com' }, reference: 'ord_get1' });

    const txn = await service.getByRef('ord_get1');
    expect(txn.internalRef).toBe('ord_get1');
    expect(txn.amount).toBe(500);
  });

  it('throws 404 for an unknown reference', async () => {
    const { service } = await buildService();
    await expect(service.getByRef('does_not_exist')).rejects.toThrow(NotFoundException);
  });
});
