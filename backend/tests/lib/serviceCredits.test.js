// Unit tests for lib/serviceCredits — the strict service-locked
// credit rule (owner, 2026-10-21): scoped coupon/cashback money can
// pay ONLY for its own service, is consumed before wallet balance,
// and can never fund another service.
const { payForService, addServiceCredit, availableFor } = require('../../lib/serviceCredits');

function mockClient({ balance = 0, credits = [], dup = false } = {}) {
  const calls = [];
  const client = {
    calls,
    query: jest.fn(async (text, params) => {
      calls.push([text, params]);
      if (/trxid IN/.test(text)) return { rows: dup ? [{ x: 1 }] : [] };
      if (/FROM users WHERE id/.test(text)) return { rows: [{ balance }] };
      if (/FROM service_credits/.test(text) && /FOR UPDATE/.test(text)) {
        return { rows: credits.map((c) => ({ id: c.id, remaining: c.remaining })) };
      }
      if (/SUM\(remaining\)/.test(text)) {
        return { rows: [{ s: credits.reduce((a, c) => a + c.remaining, 0) }] };
      }
      if (/INSERT INTO service_credits/.test(text)) return { rows: [{ id: 'sc-new' }] };
      if (/wallet_apply/.test(text)) {
        return { rows: [{ new_balance: balance - Math.abs(Number(params[1])) }] };
      }
      return { rows: [] };
    }),
  };
  return client;
}

describe('payForService', () => {
  test('full balance payment when no locked credit exists', async () => {
    const client = mockClient({ balance: 500 });
    const out = await payForService(client, { userId: 'u1', serviceId: 's1', amount: 100, ref: 'r1' });
    expect(out).toMatchObject({ paidFromCredit: 0, paidFromBalance: 100, newBalance: 400 });
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', -100, 'debit', 'r1']);
  });

  test('locked credit for THIS service is consumed first, balance pays the rest', async () => {
    const client = mockClient({ balance: 70, credits: [{ id: 'c1', remaining: 50 }] });
    const out = await payForService(client, { userId: 'u1', serviceId: 's1', amount: 100, ref: 'r2' });
    expect(out).toMatchObject({ paidFromCredit: 50, paidFromBalance: 50 });
    const upd = client.calls.find((c) => /UPDATE service_credits/.test(c[0]));
    expect(upd[1]).toEqual([50, 'c1']);
    const ledger = client.calls.find((c) => /INSERT INTO transactions/.test(c[0]));
    expect(ledger[1]).toEqual(['u1', -50, 'r2:svc']);
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1][1]).toBe(-50); // only the remainder leaves the balance
  });

  test('credit alone can cover the whole price (no balance debit at all)', async () => {
    const client = mockClient({ balance: 0, credits: [{ id: 'c1', remaining: 200 }] });
    const out = await payForService(client, { userId: 'u1', serviceId: 's1', amount: 120, ref: 'r3' });
    expect(out.paidFromCredit).toBe(120);
    expect(out.paidFromBalance).toBe(0);
    expect(client.calls.find((c) => /wallet_apply/.test(c[0]))).toBeFalsy();
  });

  test("another service's credit is never touched: rows are fetched for the paid service only", async () => {
    const client = mockClient({ balance: 30 });
    await expect(
      payForService(client, { userId: 'u1', serviceId: 's2', amount: 100, ref: 'r4' })
    ).rejects.toThrow('INSUFFICIENT_BALANCE');
    const sel = client.calls.find((c) => /FROM service_credits/.test(c[0]));
    expect(sel[1]).toEqual(['u1', 's2']); // scoped strictly to the service being bought
  });

  test('FIFO consumption across multiple credit rows', async () => {
    const client = mockClient({
      balance: 0,
      credits: [{ id: 'c1', remaining: 30 }, { id: 'c2', remaining: 50 }],
    });
    const out = await payForService(client, { userId: 'u1', serviceId: 's1', amount: 60, ref: 'r5' });
    expect(out.paidFromCredit).toBe(60);
    const upds = client.calls.filter((c) => /UPDATE service_credits/.test(c[0]));
    expect(upds.map((u) => u[1])).toEqual([[30, 'c1'], [30, 'c2']]);
  });

  test('same ref twice → DUPLICATE_TRANSACTION (either part)', async () => {
    const client = mockClient({ balance: 500, dup: true });
    await expect(
      payForService(client, { userId: 'u1', serviceId: 's1', amount: 10, ref: 'r6' })
    ).rejects.toThrow('DUPLICATE_TRANSACTION');
  });
});

describe('addServiceCredit / availableFor', () => {
  test('insert is idempotent on ref and stores amount as remaining', async () => {
    const client = mockClient({});
    const id = await addServiceCredit(client, {
      userId: 'u1', serviceId: 's1', amount: 25, source: 'coupon', ref: 'coupon-c1',
    });
    expect(id).toBe('sc-new');
    const ins = client.calls.find((c) => /INSERT INTO service_credits/.test(c[0]));
    expect(ins[0]).toMatch(/ON CONFLICT \(ref\) DO NOTHING/);
    expect(ins[1][4]).toBe(25);
  });

  test('availableFor sums remaining for the user+service', async () => {
    const client = mockClient({ credits: [{ id: 'c1', remaining: 10 }, { id: 'c2', remaining: 5 }] });
    await expect(availableFor(client, 'u1', 's1')).resolves.toBe(15);
  });
});
