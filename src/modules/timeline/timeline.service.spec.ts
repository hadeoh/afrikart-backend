import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { NotFoundException } from '@nestjs/common';
import { TimelineService } from './timeline.service';
import { Transaction } from '../collections/schemas/transaction.schema';
import { Payout } from '../payouts/schemas/payout.schema';
import { AfrikartService } from '../afrikart/afrikart.service';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTxnModel(txns: any[]) {
  return {
    findOne: jest.fn((filter: any) => {
      const result = txns.find((t) => t.internalRef === filter.internalRef) ?? null;
      const p = Promise.resolve(result ? { ...result } : null);
      return { lean: () => p };
    }),
  };
}

function makePayoutModel(payouts: any[]) {
  return {
    findOne: jest.fn((filter: any) => {
      const result = payouts.find((p) => p.customerReference === filter.customerReference) ?? null;
      const p = Promise.resolve(result ? { ...result } : null);
      return { lean: () => p };
    }),
    find: jest.fn((filter: any) => {
      const results = payouts.filter((p) => p.sourceTransactionRef === filter.sourceTransactionRef);
      const p = Promise.resolve(results.map((r) => ({ ...r })));
      return { lean: () => p };
    }),
  };
}

async function buildService(txns: any[] = [], payouts: any[] = [], afrikartOverrides: any = {}) {
  const module = await Test.createTestingModule({
    providers: [
      TimelineService,
      { provide: getModelToken(Transaction.name), useValue: makeTxnModel(txns) },
      { provide: getModelToken(Payout.name), useValue: makePayoutModel(payouts) },
      {
        provide: AfrikartService,
        useValue: {
          getEvents: jest.fn().mockResolvedValue({ data: [] }),
          getWalletLogs: jest.fn().mockResolvedValue({ data: [] }),
          ...afrikartOverrides,
        },
      },
    ],
  }).compile();

  return module.get<TimelineService>(TimelineService);
}

// ─── Transaction timeline ─────────────────────────────────────────────────────

describe('TimelineService — getTransactionTimeline', () => {
  it('throws 404 for an unknown internalRef', async () => {
    const svc = await buildService();
    await expect(svc.getTransactionTimeline('missing_ref')).rejects.toThrow(NotFoundException);
  });

  it('returns transaction metadata and an empty timeline when no payouts exist', async () => {
    const txn = {
      internalRef: 'ord_t1',
      externalPaymentId: 'txn_abc',
      amount: 5000,
      currency: 'NGN',
      customer: { name: 'Ada', email: 'ada@test.com' },
      status: 'successful',
      channel: 'bank_transfer',
      timeline: [
        { at: new Date('2026-01-01T10:00:00Z'), event: 'checkout.initiated', actor: 'system', detail: {} },
        { at: new Date('2026-01-01T10:05:00Z'), event: 'webhook.collection.successful', actor: 'webhook', detail: {} },
      ],
    };
    const svc = await buildService([txn]);

    const result = await svc.getTransactionTimeline('ord_t1');

    expect(result.transaction.internalRef).toBe('ord_t1');
    expect(result.transaction.status).toBe('successful');
    expect(result.payouts).toHaveLength(0);
    expect(result.timeline).toHaveLength(2);
    expect((result.timeline[0] as any).event).toBe('checkout.initiated');
  });

  it('merges and sorts transaction + payout events chronologically', async () => {
    const txn = {
      internalRef: 'ord_merge',
      externalPaymentId: 'txn_m1',
      amount: 10000,
      currency: 'NGN',
      customer: { name: 'Fatima', email: 'fatima@test.com' },
      status: 'successful',
      channel: null,
      timeline: [
        { at: new Date('2026-01-01T10:00:00Z'), event: 'checkout.initiated', actor: 'system', detail: {} },
        { at: new Date('2026-01-01T10:10:00Z'), event: 'webhook.collection.successful', actor: 'webhook', detail: {} },
      ],
    };

    const payout = {
      customerReference: 'po_m1',
      sourceTransactionRef: 'ord_merge',
      providerPayoutReference: 'pref_m1',
      amount: 9000,
      status: 'successful',
      failureReason: null,
      recipient: { name: 'Vendor', accountNumber: '123', bankCode: '058' },
      timeline: [
        { at: new Date('2026-01-01T10:15:00Z'), from: 'verification_pending', to: 'processing', actor: 'system', detail: {} },
        { at: new Date('2026-01-01T10:05:00Z'), from: 'init', to: 'verification_pending', actor: 'system', detail: {} },
      ],
    };

    const svc = await buildService([txn], [payout]);
    const result = await svc.getTransactionTimeline('ord_merge');

    expect(result.payouts).toHaveLength(1);
    expect(result.payouts[0].customerReference).toBe('po_m1');

    // Events should be sorted — earliest first regardless of source
    const times = result.timeline.map((e: any) => new Date(e.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(result.timeline).toHaveLength(4);

    const sources = result.timeline.map((e: any) => e.source);
    expect(sources).toContain('transaction');
    expect(sources).toContain('payout');
  });
});

// ─── Payout timeline ──────────────────────────────────────────────────────────

describe('TimelineService — getPayoutTimeline', () => {
  it('throws 404 for an unknown customerReference', async () => {
    const svc = await buildService();
    await expect(svc.getPayoutTimeline('unknown_ref')).rejects.toThrow(NotFoundException);
  });

  it('returns payout metadata and timeline sorted by time', async () => {
    const payout = {
      customerReference: 'po_tl1',
      providerPayoutReference: 'pref_tl1',
      providerPayoutId: 'po_abc',
      amount: 3000,
      status: 'failed',
      failureReason: 'Rejected by bank',
      walletCreditAt: new Date('2026-01-02T12:00:00Z'),
      recipient: { name: 'Vendor', accountNumber: '0000', bankCode: '058', verifiedName: 'Vendor Ltd' },
      attemptCount: 1,
      timeline: [
        { at: new Date('2026-01-02T11:55:00Z'), from: 'processing', to: 'failed', actor: 'webhook', detail: {} },
        { at: new Date('2026-01-02T11:50:00Z'), from: 'verification_pending', to: 'processing', actor: 'system', detail: {} },
        { at: new Date('2026-01-02T11:45:00Z'), from: 'init', to: 'verification_pending', actor: 'system', detail: {} },
      ],
    };

    const svc = await buildService([], [payout]);
    const result = await svc.getPayoutTimeline('po_tl1');

    expect(result.payout.customerReference).toBe('po_tl1');
    expect(result.payout.status).toBe('failed');
    expect(result.payout.walletCreditAt).toBeDefined();
    expect(result.payout.failureReason).toBe('Rejected by bank');

    // Timeline must be sorted ascending
    const times = result.timeline.map((e: any) => new Date(e.at).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(result.timeline[0].to).toBe('verification_pending');
    expect(result.timeline[2].to).toBe('failed');
  });
});

// ─── Provider passthrough methods ─────────────────────────────────────────────

describe('TimelineService — provider passthrough', () => {
  it('getProviderEvents delegates to AfrikartService.getEvents', async () => {
    const getEvents = jest.fn().mockResolvedValue({ data: [{ id: 'evt_1' }] });
    const svc = await buildService([], [], { getEvents });

    const result = await svc.getProviderEvents('collection.successful', 10);
    expect(getEvents).toHaveBeenCalledWith('collection.successful', 10);
    expect(result).toEqual([{ id: 'evt_1' }]);
  });

  it('getWalletLogs delegates to AfrikartService.getWalletLogs', async () => {
    const getWalletLogs = jest.fn().mockResolvedValue({ data: [{ id: 'wl_1', type: 'debit' }] });
    const svc = await buildService([], [], { getWalletLogs });

    const result = await svc.getWalletLogs('NGN', 'debit', 1, 20);
    expect(getWalletLogs).toHaveBeenCalledWith('NGN', 'debit', 1, 20);
    expect(result).toEqual([{ id: 'wl_1', type: 'debit' }]);
  });
});
