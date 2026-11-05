// Unit tests for lib/serviceCredits — the strict service-locked
// credit rule (owner, 2026-10-21): scoped coupon/cashback money can
// pay ONLY for its own service, is consumed before wallet balance,
// and can never fund another service.
const { payForService, addServiceCredit, availableFor, refundOrderPrice, releaseHold } = require('../../lib/serviceCredits');

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

describe('refundOrderPrice — B1 engine refs (2026-11-03)', () => {
  // Same shape as the refundClient above, but ledger rows are keyed
  // by the ENGINE charge ref while the order carries only its key.
  function engineClient({ ledger = {}, creditRows = [] } = {}) {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (text, params) => {
        calls.push([text, params]);
        if (/FROM transactions/.test(text)) {
          const ref = params[1];
          return { rows: ledger[ref] || [] };
        }
        if (/FROM service_credits/.test(text)) return { rows: creditRows };
        if (/UPDATE service_credits SET remaining/.test(text)) return { rows: [] };
        if (/INSERT INTO service_credits/.test(text)) return { rows: [{ id: 'sc-ref' }] };
        if (/wallet_apply/.test(text)) return { rows: [{ new_balance: 0 }] };
        return { rows: [] };
      }),
    };
  }

  test('land client idem reconstructs via land-<mode>-<idem> (no full-balance fallback)', async () => {
    const client = engineClient({
      ledger: {
        'land-search-idem1': [
          { trxid: 'land-search-idem1', amount: -70 },
          { trxid: 'land-search-idem1:svc', amount: -30 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 50, remaining: 20 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'oL', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'idem1' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 30, balancePart: 70 });
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', 70, 'refund', 'refund-oL']); // NOT the full 100
  });

  test('land auto idem reconstructs via the doubled mode prefix', async () => {
    const client = engineClient({
      ledger: {
        'land-scan-land-scan-uuid9': [
          { trxid: 'land-scan-land-scan-uuid9', amount: -80 },
          { trxid: 'land-scan-land-scan-uuid9:svc', amount: -20 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 100, remaining: 80 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'oS', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'land-scan-uuid9' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 20, balancePart: 80 });
  });

  test('nid order key nid-<jobId> reconstructs via nid-card-<jobId>', async () => {
    const client = engineClient({
      ledger: {
        'nid-card-job9': [
          { trxid: 'nid-card-job9', amount: -55 },
          { trxid: 'nid-card-job9:svc', amount: -45 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 100, remaining: 55 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'oN', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'nid-job9' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 45, balancePart: 55 });
  });

  test('nid-server-copy order key IS the ref, so it reconstructs directly', async () => {
    const client = engineClient({
      ledger: {
        'nidsc-job7-card': [
          { trxid: 'nidsc-job7-card', amount: -60 },
          { trxid: 'nidsc-job7-card:svc', amount: -40 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 100, remaining: 60 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'oC', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'nidsc-job7-card' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 40, balancePart: 60 });
  });

  test('qr-verify order key (idem) reconstructs via qr-verify-<idem>', async () => {
    const client = engineClient({
      ledger: {
        'qr-verify-idemqr': [
          { trxid: 'qr-verify-idemqr', amount: -90 },
          { trxid: 'qr-verify-idemqr:svc', amount: -10 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 100, remaining: 90 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'oQ', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'idemqr' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 10, balancePart: 90 });
  });
});

describe('refundOrderPrice (admin-order fix, 2026-11-03)', () => {
  // Focused mock: ledger rows keyed by the charge ref the refund
  // helper reconstructs, plus one service_credits row to top up.
  function refundClient({ ledger = {}, creditRows = [] } = {}) {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (text, params) => {
        calls.push([text, params]);
        if (/FROM transactions/.test(text)) {
          const ref = params[1];
          return { rows: ledger[ref] || [] };
        }
        if (/FROM service_credits/.test(text)) return { rows: creditRows };
        if (/UPDATE service_credits SET remaining/.test(text)) return { rows: [] };
        if (/INSERT INTO service_credits/.test(text)) return { rows: [{ id: 'sc-ref' }] };
        if (/wallet_apply/.test(text)) return { rows: [{ new_balance: 0 }] };
        return { rows: [] };
      }),
    };
  }

  test('split charge refunds proportionally: credit part tops up service_credits, balance part via wallet_apply', async () => {
    const client = refundClient({
      ledger: {
        'order-ck1-u1': [
          { trxid: 'order-ck1-u1', amount: -60 },
          { trxid: 'order-ck1-u1:svc', amount: -40 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 50, remaining: 10 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'o1', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'ck1' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 40, balancePart: 60 });
    const upd = client.calls.find((c) => /UPDATE service_credits SET remaining/.test(c[0]));
    expect(upd[1]).toEqual([40, 'c1']); // headroom was 50-10=40
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', 60, 'refund', 'refund-o1']);
  });

  test('gate ref reconstructs too (engineId:attemptKey → engineId-attemptKey)', async () => {
    const client = refundClient({
      ledger: {
        'birth-final-att1': [
          { trxid: 'birth-final-att1:svc', amount: -30 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 100, remaining: 70 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'o2', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'birth-final:att1' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 30, balancePart: 70 });
  });

  test('unreconstructible split → whole price to balance, NEVER invented credit', async () => {
    const client = refundClient({ ledger: {}, creditRows: [{ id: 'c1', amount: 50, remaining: 50 }] });
    const out = await refundOrderPrice(client,
      { id: 'o3', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'unknown-key' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 0, balancePart: 100 });
    expect(client.calls.find((c) => /UPDATE service_credits/.test(c[0]))).toBeUndefined();
    expect(client.calls.find((c) => /INSERT INTO service_credits/.test(c[0]))).toBeUndefined();
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', 100, 'refund', 'refund-o3']);
  });

  test('full-credit refund still leaves a wallet_apply marker (0) so the prior-refund guard can see it', async () => {
    const client = refundClient({
      ledger: {
        'order-ck9-u1': [
          { trxid: 'order-ck9-u1:svc', amount: -100 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 100, remaining: 0 }],
    });
    const out = await refundOrderPrice(client,
      { id: 'o9', user_id: 'u1', service_id: 's1', price: 100, idempotency_key: 'ck9' }, 'refund');
    expect(out).toEqual({ refunded: true, creditPart: 100, balancePart: 0 });
    const upd = client.calls.find((c) => /UPDATE service_credits SET remaining/.test(c[0]));
    expect(upd[1]).toEqual([100, 'c1']); // headroom was 100-0=100
    // Balance leg is 0, but wallet_apply MUST still run: its
    // approved 0-amount row is the marker hasPriorRefund checks.
    // Without it a credit-only refund would leave no trace and a
    // later refund could double-restore the same credit.
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', 0, 'refund', 'refund-o9']);
  });

  test('zero price → no refund calls at all', async () => {
    const client = refundClient();
    const out = await refundOrderPrice(client,
      { id: 'o4', user_id: 'u1', service_id: 's1', price: 0, idempotency_key: 'ck0' }, 'refund');
    expect(out.refunded).toBe(false);
    expect(client.calls).toEqual([]);
  });
});

describe('releaseHold (audit #9)', () => {
  // Same static fake as refundClient (which lives inside the
  // refund describes): ledger rows keyed by ref, credit rows as
  // given. releaseHold only reads the ledger + restores credit +
  // credits the balance, so this is enough to prove the split.
  function releaseClient({ ledger = {}, creditRows = [] } = {}) {
    const calls = [];
    return {
      calls,
      query: jest.fn(async (text, params) => {
        calls.push([text, params]);
        if (/FROM transactions/.test(text)) {
          const ref = params[1];
          return { rows: ledger[ref] || [] };
        }
        if (/FROM service_credits/.test(text)) return { rows: creditRows };
        if (/UPDATE service_credits SET remaining/.test(text)) return { rows: [] };
        if (/INSERT INTO service_credits/.test(text)) return { rows: [{ id: 'sc-ref' }] };
        if (/wallet_apply/.test(text)) return { rows: [{ new_balance: 0 }] };
        return { rows: [] };
      }),
    };
  }

  test('release returns the exact split the hold consumed', async () => {
    const client = releaseClient({
      ledger: {
        'qr-verify-k1': [
          { trxid: 'qr-verify-k1', amount: -60 },
          { trxid: 'qr-verify-k1:svc', amount: -40 },
        ],
      },
      creditRows: [{ id: 'c1', amount: 50, remaining: 10 }],
    });
    const out = await releaseHold(client, { userId: 'u1', serviceId: 's1', ref: 'qr-verify-k1' });
    expect(out).toEqual({ released: true, creditPart: 40, balancePart: 60 });
    const upd = client.calls.find((c) => /UPDATE service_credits SET remaining/.test(c[0]));
    expect(upd[1]).toEqual([40, 'c1']); // headroom was 50-10=40
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', 60, 'refund', 'release-qr-verify-k1']);
  });

  test('no hold rows → released false, no money moved', async () => {
    const client = releaseClient({ ledger: {}, creditRows: [{ id: 'c1', amount: 50, remaining: 50 }] });
    const out = await releaseHold(client, { userId: 'u1', serviceId: 's1', ref: 'qr-verify-k9' });
    expect(out).toEqual({ released: false, creditPart: 0, balancePart: 0 });
    expect(client.calls.find((c) => /wallet_apply/.test(c[0]))).toBeFalsy();
    expect(client.calls.find((c) => /UPDATE service_credits/.test(c[0]))).toBeFalsy();
  });

  test('credit-only hold → credit restored + zero-amount marker row', async () => {
    const client = releaseClient({
      ledger: {
        'qr-verify-k2': [{ trxid: 'qr-verify-k2:svc', amount: -100 }],
      },
      creditRows: [{ id: 'c1', amount: 100, remaining: 0 }],
    });
    const out = await releaseHold(client, { userId: 'u1', serviceId: 's1', ref: 'qr-verify-k2' });
    expect(out).toEqual({ released: true, creditPart: 100, balancePart: 0 });
    const w = client.calls.find((c) => /wallet_apply/.test(c[0]));
    expect(w[1]).toEqual(['u1', 0, 'refund', 'release-qr-verify-k2']);
  });

  test('double release restores locked credit exactly once (bug-hunt F2)', async () => {
    // Stateful fake: the credit row's remaining actually moves, and
    // the release marker appears after the first release — the two
    // things the static releaseClient above cannot model. The old
    // code restored the credit a second time here (fresh row when
    // the first release had already filled the headroom).
    const state = {
      debit: [
        { trxid: 'qr-verify-k3', amount: -60 },
        { trxid: 'qr-verify-k3:svc', amount: -40 },
      ],
      released: false,
      credit: { id: 'c1', amount: 50, remaining: 10 }, // 40 consumed by the hold
      freshRows: 0,
    };
    const calls = [];
    const client = {
      calls, state,
      query: jest.fn(async (text, params) => {
        calls.push([text, params]);
        if (/SELECT 1 FROM transactions/.test(text)) {
          return { rows: state.released ? [{ '1': 1 }] : [] };
        }
        if (/FROM transactions/.test(text)) return { rows: state.debit };
        if (/FROM service_credits/.test(text)) {
          return { rows: [{ id: state.credit.id, amount: state.credit.amount, remaining: state.credit.remaining }] };
        }
        if (/UPDATE service_credits SET remaining/.test(text)) {
          state.credit.remaining += params[0];
          return { rows: [] };
        }
        if (/INSERT INTO service_credits/.test(text)) {
          state.freshRows += 1;
          return { rows: [{ id: 'sc-ref' }] };
        }
        if (/wallet_apply/.test(text)) {
          if (typeof params[3] === 'string' && params[3].indexOf('release-') === 0) state.released = true;
          return { rows: [{ new_balance: 0 }] };
        }
        return { rows: [] };
      }),
    };
    const first = await releaseHold(client, { userId: 'u1', serviceId: 's1', ref: 'qr-verify-k3' });
    expect(first).toEqual({ released: true, creditPart: 40, balancePart: 60 });
    expect(state.credit.remaining).toBe(50); // topped up once, to full
    expect(state.freshRows).toBe(0);
    const second = await releaseHold(client, { userId: 'u1', serviceId: 's1', ref: 'qr-verify-k3' });
    expect(second).toEqual({ released: false, creditPart: 0, balancePart: 0 });
    // Second release is a true no-op: no second top-up, no fresh
    // credit row, no second balance refund.
    expect(state.credit.remaining).toBe(50);
    expect(state.freshRows).toBe(0);
    const walletCalls = calls.filter((c) => /wallet_apply/.test(c[0]));
    expect(walletCalls).toHaveLength(1);
    expect(walletCalls[0][1]).toEqual(['u1', 60, 'refund', 'release-qr-verify-k3']);
  });
});
