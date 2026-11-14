// Past-applications list (2026-11-07) — a filed BDRIS application
// appears in History with its tracking number, a link to the filing
// page, and its stored original Form-1 PDF when retrievable: the
// download comes from the owner-only endpoint
// (GET /api/bdris-apply/applications/:ackNo/original — a
// re-download of the already-paid copy, no new charge) via the
// normal documents button, and a view button opens the same copy
// in a new tab. No bare static /bdris-original-*.pdf link is ever
// built client-side (no token in a URL).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('history.html — BDRIS filings (past-applications list)', () => {
  const html = read('frontend/history.html');

  test('bdris icon + kind filter option exist', () => {
    expect(html).toContain("bdris:'📋'");
    expect(html).toContain('<option value="bdris">বিডিআরআইএস আবেদন</option>');
  });

  test('a BDRIS item renders a filing-page link, a PDF download and a view button', () => {
    expect(html).toContain('আবেদন দেখুন');
    expect(html).toContain('আসল PDF তৈরি');
    expect(html).toContain('আসল PDF দেখুন');
    expect(html).toContain('viewHist(');
    expect(html).toContain('original_pdf_available');
  });

  test('the BDRIS download/view go through the owner-only endpoint, never a bare static file', () => {
    // the download is the generic documents button (dlHist) fed by
    // the API's documents array — the page never builds a
    // /bdris-original-*.pdf URL itself, and the view opens the same
    // blob URL in a new tab
    expect(html).toContain('function viewHist(');
    expect(html).toContain('window.open(');
    expect(html).not.toContain('bdris-original');
  });
});

describe('history.html — B2#8 kind label + status/next action per row', () => {
  const vm = require('vm');
  const script = read('frontend/history.html')
    .slice(read('frontend/history.html').lastIndexOf('<script>') + 8, read('frontend/history.html').lastIndexOf('</script>'))
    .replace(/\ninit\(\);/, '\n');

  function renderItems(items) {
    const els = {};
    const el = () => ({ style: {}, innerHTML: '' });
    const get = (id) => (els[id] = els[id] || el());
    const ctx = vm.createContext({ document: { getElementById: get }, console });
    vm.runInContext(script, ctx);
    vm.runInContext('_items = ' + JSON.stringify(items) + '; render();', ctx);
    return get('histList').innerHTML;
  }
  const at = '2026-11-14T10:00:00.000Z';

  test('every row shows its kind label', () => {
    const out = renderItems([
      { kind: 'order', id: 'o1', title: 'অর্ডার সেবা', created_at: at, documents: [] },
      { kind: 'manual', id: 'm1', title: 'ম্যানুয়াল সেবা', created_at: at, documents: [] },
      { kind: 'engine', id: 'j1', title: 'জন্ম সনদ', created_at: at, documents: [] },
      { kind: 'bdris', id: 'a1', title: 'জন্ম নিবন্ধন আবেদন', created_at: at, documents: [], link: '/bdris-apply.html', original_pdf_available: false },
    ]);
    expect(out).toContain('>অর্ডার</span>');
    expect(out).toContain('>ম্যানুয়াল সেবা</span>');
    expect(out).toContain('>ইঞ্জিন সেবা</span>');
    expect(out).toContain('>বিডিআরআইএস আবেদন</span>');
  });

  test('file-less completed row says so (record only); downloadable row says the file is ready', () => {
    const out = renderItems([
      { kind: 'order', id: 'o1', title: 'অর্ডার সেবা', created_at: at, documents: [] },
      { kind: 'engine', id: 'j1', title: 'জন্ম সনদ (সার্টিফিকেট)', created_at: at, documents: [{ filename: 'c.pdf', originalname: 'জন্ম সনদ.pdf', url: '/engine-jobs/j1/file' }] },
    ]);
    expect(out).toContain('সম্পন্ন হয়েছে — ডাউনলোডযোগ্য ফাইল নেই (শুধু রেকর্ড)');
    expect(out).toContain('ডেলিভারি ফাইল প্রস্তুত — নিচে ডাউনলোড করুন');
  });

  test('failed engine job says failed with a retry next action; BDRIS row without a stored PDF points to the filing page', () => {
    const out = renderItems([
      { kind: 'engine', id: 'j2', title: 'জন্ম সনদ (সার্টিফিকেট) — ব্যর্থ', created_at: at, documents: [] },
      { kind: 'bdris', id: 'a1', title: 'জন্ম নিবন্ধন আবেদন (আবেদন নম্বর: 123)', created_at: at, documents: [], link: '/bdris-apply.html', original_pdf_available: false },
    ]);
    expect(out).toContain('ব্যর্থ হয়েছে — কোনো ফাইল তৈরি হয়নি। আবার চেষ্টা করুন।');
    expect(out).toContain('আসল PDF এখানে সংরক্ষিত নেই — আবেদন পাতা থেকে নিতে পারবেন।');
    expect(out).toContain('আবেদন দেখুন');
  });
});
