// PREIUM-PRIVATE (2026-11-13): the DONE page's "আসল PDF" button must fetch
// the copy through the owner-only route. The engine used to hand back a
// bare /bdris-original-<ack>.pdf URL and that file sat in the web root,
// so anyone who guessed a number downloaded someone's application copy.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '../../../frontend/bdris-apply.html'), 'utf8');

function source(name) {
  const i = html.indexOf('function ' + name + '(');
  const start = html.slice(i - 6, i) === 'async ' ? i - 6 : i;
  return html.slice(start, html.indexOf('\n}\n', i) + 3);
}

function setup(body = '%PDF-1.4\nfixture') {
  const seen = [];
  const button = { textContent: 'PDF', disabled: false };
  const c = {
    S: { ackNo: '123456789', _pdfTok: { 'pdf-123456789': { tok: 'paid-fixture', at: Date.now() } } },
    canonicalAck: (s) => String(s).replace(/\D/g, ''),
    pdfChargeKey: (s) => 'pdf-' + s,
    $: () => button,
    Date, Blob, File, Uint8Array, String, encodeURIComponent,
    charge: async () => 'paid-fixture',
    getToken: () => 'fixture-session',
    fetch: async (url, opts) => { seen.push(url); return { ok: true, blob: async () => new Blob([body]) }; },
    document: { createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} } },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    note() {}, setTimeout() {}, navigator: {}, matchMedia: () => ({ matches: false }),
  };
  vm.createContext(c);
  vm.runInContext(source('downloadOriginal'), c);
  return { c, seen, button };
}

test('the download goes to the owner-only route, not a bare static file', async () => {
  const x = setup();
  expect(await x.c.downloadOriginal('/bdris-original-123456789.pdf', '123456789')).toBe(true);
  expect(x.seen).toEqual(['/api/bdris-apply/applications/123456789/original']);
});

test('the request carries the session and the paid receipt', async () => {
  const x = setup();
  await x.c.downloadOriginal('/bdris-original-123456789.pdf', '123456789');
  expect(x.button.disabled).toBe(false);
});

test('no bare /bdris-original-*.pdf URL is ever fetched client-side', () => {
  const src = source('downloadOriginal');
  expect(src).not.toMatch(/fetch\(\s*url/);
  expect(src).toContain("'/api/bdris-apply/applications/'");
});
