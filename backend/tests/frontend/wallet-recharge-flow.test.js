const fs = require('fs');
const path = require('path');
const vm = require('vm');

const wallet = fs.readFileSync(path.join(__dirname, '../../../frontend/wallet.html'), 'utf8');
const source = wallet.slice(wallet.indexOf('function rechargeErrText'), wallet.indexOf('async function redeem()'));
const response = (transaction, status = 200) => ({ ok: status < 400, status, json: async () => ({ transaction }) });

function fixture() {
  const elements = Object.fromEntries(['rechargeSubmit', 'err', 'amount', 'sender', 'trxid', 'ok'].map(id => [
    id, { value: '', textContent: '', innerHTML: '', dataset: {}, focus: jest.fn() },
  ]));
  elements.amount.value = '125';
  elements.sender.value = '01700000000';
  elements.trxid.value = 'FIXTURE123';
  const context = {
    document: { getElementById: id => elements[id] },
    RECHARGE_FORM: { elements: { paymentMethod: { value: 'bkash_payment' } } },
    rechargeStorageKey: 'abc_wallet_recharge:fixture',
    sessionStorage: { setItem: jest.fn(), removeItem: jest.fn() },
    setInterval: jest.fn(() => 1),
    clearInterval: jest.fn(),
    ABC: { api: jest.fn() },
    loadWallet: jest.fn(),
    bn: String,
    esc: value => String(value).replace(/</g, '&lt;'),
  };
  vm.runInNewContext(source, context);
  return { elements, ...context };
}

test('wallet shows one Auto Payment form requiring a TrxID', () => {
  expect(wallet.match(/<form\b/g)).toHaveLength(1);
  expect(wallet).toContain('<h2 id="paymentTitle">অটো পেমেন্ট</h2>');
  expect(wallet).toMatch(/id="trxid"[^>]*\brequired\b/);
  expect(wallet).not.toMatch(/\/wallet\/recharge\/auto|gwStartSession|manualSection|wallet-preview-adapter/);
  const inline = [...wallet.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  inline.forEach(([, code]) => expect(() => new vm.Script(code)).not.toThrow());
});

test('transaction history keeps full references, status filters and pagination', () => {
  expect(wallet).toMatch(/const shortRef = x => \{[\s\S]*return m \? '#' \+ m\[1\] : x/);
  expect(wallet).toContain('PAYMENT_METHOD_NAMES[t.method]');
  expect(wallet).toContain('t.sender_no');
  expect(wallet).toContain('fmtElapsed(t.created_at)');
  expect(wallet).not.toContain('SMS এখনো আসেনি');
  expect(wallet).toContain('id="txFilterType"');
  expect(wallet).toContain('id="txFilterStatus"');
  expect(wallet).toContain('id="txMoreBtn"');
  expect(wallet).toContain('TX_PAGE_SIZE');
});

test('history inline scripts parse and its download action still depends on documents', () => {
  const history = fs.readFileSync(path.join(__dirname, '../../../frontend/history.html'), 'utf8');
  for (const [, code] of history.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    expect(() => new vm.Script(code)).not.toThrow();
  }
  expect(history).toContain('id="histSearch"');
  expect(history).toContain('id="histKind"');
  expect(history).toContain('id="histMoreBtn"');
  expect(history).toContain("docs ? '<div class=\"hist-docs\">'");
});

test('a missing TrxID focuses the field and sends no request', async () => {
  const t = fixture();
  t.elements.trxid.value = '';
  await t.submitRecharge({ preventDefault() {} });
  expect(t.ABC.api).not.toHaveBeenCalled();
  expect(t.elements.trxid.focus).toHaveBeenCalledTimes(1);
});

test('a double click submits exactly one TrxID request and reflects auto approval', async () => {
  const t = fixture();
  let resolve;
  t.ABC.api.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const first = t.submitRecharge({ preventDefault() {} });
  await t.submitRecharge({ preventDefault() {} });
  expect(t.ABC.api).toHaveBeenCalledTimes(1);
  expect(t.ABC.api).toHaveBeenCalledWith('/wallet/recharge', {
    method: 'POST', body: { method: 'bkash_payment', sender_no: '01700000000', trxid: 'FIXTURE123', amount: '125' },
  });
  resolve(response({ status: 'approved', amount: 125, trxid: 'FIXTURE123' }, 201));
  await first;
  expect(t.elements.ok.dataset.status).toBe('approved');
  expect(t.loadWallet).toHaveBeenCalled();
  expect(t.elements.rechargeSubmit.disabled).toBe(false);
});

test('pending requests are tracked by their TrxID and display the same request when approved', async () => {
  const t = fixture();
  const pending = { status: 'pending', amount: 125, trxid: 'FIXTURE123' };
  t.ABC.api
    .mockResolvedValueOnce(response(pending, 201))
    .mockResolvedValueOnce(response(pending))
    .mockResolvedValueOnce(response({ ...pending, status: 'approved' }));
  await t.submitRecharge({ preventDefault() {} });
  expect(t.elements.ok.dataset.status).toBe('pending');
  expect(t.sessionStorage.setItem).toHaveBeenCalledWith('abc_wallet_recharge:fixture', 'FIXTURE123');
  expect(t.ABC.api).toHaveBeenLastCalledWith('/wallet/recharge/FIXTURE123');
  await new Promise(resolve => setImmediate(resolve));
  t.setInterval.mock.calls[0][0]();
  await new Promise(resolve => setImmediate(resolve));
  expect(t.elements.ok.dataset.status).toBe('approved');
  expect(t.elements.ok.innerHTML).toContain('FIXTURE123');
  expect(t.clearInterval).toHaveBeenCalledWith(1);
});

test('a duplicate belonging to the user shows its recorded status', async () => {
  const t = fixture();
  t.ABC.api.mockResolvedValueOnce({
    ok: false,
    json: async () => ({ error: 'DUP_TRXID', existing_tx: { status: 'rejected', amount: 125, cancel_reason: '<review>' } }),
  });
  await t.submitRecharge({ preventDefault() {} });
  expect(t.elements.ok.dataset.status).toBe('rejected');
  expect(t.elements.ok.innerHTML).toContain('&lt;review>');
  expect(t.ABC.api).toHaveBeenCalledTimes(1);
});
