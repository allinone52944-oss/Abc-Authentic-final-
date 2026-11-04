/**
 * Frontend admin order fixes F1–F15 (2026-11-03 audit, frontend half).
 *
 * admin.js is DOM-heavy, so most assertions are structural: they run
 * against the CURRENT source text and fail if a fix regresses. The
 * modal-focus rule (F14) is exercised for real with a stubbed DOM,
 * reusing the extract-by-brace-matching approach of admin.test.js.
 */

const fs = require('fs');
const path = require('path');

const ADMIN_SRC = fs.readFileSync(
  path.join(__dirname, '../../../frontend/js/admin.js'),
  'utf8',
);
const ADMIN_HTML = fs.readFileSync(
  path.join(__dirname, '../../../frontend/admin.html'),
  'utf8',
);

function extractFn(src, sig) {
  const st = src.indexOf(sig);
  if (st < 0) throw new Error('not found in admin.js: ' + sig);
  const open = src.indexOf('{', st);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(st, i + 1);
    }
  }
  throw new Error('unbalanced braces for: ' + sig);
}

function methodBody(sig) {
  return extractFn(ADMIN_SRC, sig);
}

function makeButton({ danger = false, disabled = false } = {}) {
  return {
    disabled,
    focused: false,
    classList: { contains: (c) => (c === 'danger' ? danger : false) },
    focus() { this.focused = true; },
  };
}

function makeDocument(focusables) {
  const created = [];
  const listeners = {};
  const opener = { focused: false, focus() { this.focused = true; } };
  const doc = {
    activeElement: opener,
    _opener: opener,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeEventListener(type, fn) {
      const a = listeners[type];
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
    },
    createElement() {
      const el = {
        className: '', id: '', innerHTML: '', onclick: null,
        _removed: false, children: [],
        appendChild(c) { this.children.push(c); return c; },
        remove() { this._removed = true; },
        querySelector() { return null; },
        querySelectorAll() { return focusables; },
      };
      created.push(el);
      return el;
    },
    getElementById(id) { return created.find((e) => e.id === id && !e._removed) || null; },
    body: {
      appendChild(c) { created.push(c); return c; },
      contains(el) { return el === opener; },
    },
  };
  return { doc, created, opener };
}

function loadModal(focusables) {
  const { doc } = makeDocument(focusables);
  const code = ['esc', 'closeModal', 'modal'].map((n) => extractFn(ADMIN_SRC, 'function ' + n + '(')).join('\n');
  const factory = new Function('document', code + '\nreturn { esc, modal, closeModal };');
  return { ...factory(doc), doc };
}

describe('F1 view() fallback must not replace TABS._orders', () => {
  test('no list replacement in the detail fallback fetch', () => {
    expect(ADMIN_SRC).not.toContain('TABS._orders = ld.orders');
    expect(ADMIN_SRC).toContain('TABS._detailOrder = o');
  });
});

describe('F2 pager clamps after a shrink (sidebar-unified-orders)', () => {
  test('unified orders list steps back instead of rendering an empty page', () => {
    expect(ADMIN_SRC).toContain('if (_page > _pages) { TABS._opage = _pages; return TABS.orders(); }');
  });
  test('unified pager uses the server pages/total, not client cap math', () => {
    // SUPERSEDED for the old auto-data pager: the separate
    // loadAutoData/pageAutoData pager is gone; the unified list
    // pages from GET /api/admin/unified-services pages/total, and
    // its Math.max(1, …) guard also covers the backend pages:0
    // empty result (renders page 1/1 with the empty-state row).
    expect(ADMIN_SRC).toContain("'/admin/unified-services?limit=50&page='");
    expect(ADMIN_SRC).toContain('const _pages = Math.max(1, (d.pages');
    expect(ADMIN_SRC).toContain('টি সারি · পেজ');
    expect(ADMIN_SRC).not.toContain('pageAutoData(');
  });
});

describe('F3 findOrder across _orders + _unifiedRows', () => {
  test('helper searches both lists, never defaults to price 0', () => {
    // SUPERSEDED: the old _autoOrders list is gone; the unified
    // list (_unifiedRows) is the second list now.
    const body = methodBody('  findOrder(id) {');
    expect(body).toContain('TABS._orders');
    expect(body).toContain('TABS._unifiedRows');
    expect(body).not.toContain('TABS._autoOrders');
  });
  test('cancel/fail/refund/delete use findOrder', () => {
    for (const sig of ['  async cancelOrder(', '  async failOrder(', '  async refundOrder(', '  async deleteOrder(']) {
      expect(methodBody(sig)).toContain('this.findOrder(id)');
    }
  });
  test('deleteAutoOrder is repointed to the unified orders list', () => {
    // SUPERSEDED: the old auto-data return target is gone; the
    // shim now deletes via the single orders list, and never
    // clobbers _orders from a second list.
    const body = methodBody('  deleteAutoOrder(id) {');
    expect(body).toContain("AdmOrders.deleteOrder(id, 'orders')");
    expect(body).not.toContain('TABS._orders = TABS._autoOrders');
  });
});

describe('F4 cancel/fail/refund return to the detail backTab', () => {
  test('all three redirect via _backTab, never hardcoded orders', () => {
    const shows = (ADMIN_SRC.match(/show\(_backTab\)/g) || []).length;
    expect(shows).toBeGreaterThanOrEqual(5); // cancel 1 + fail 1 + refund 3
    for (const sig of ['  async cancelOrder(', '  async failOrder(', '  async refundOrder(']) {
      expect(methodBody(sig)).toContain('show(_backTab)');
    }
  });
  test('detail-modal pipeline actions also return via _backTab (list rows fall back to orders)', () => {
    for (const sig of ['  async setStatus(', '  async startProcessing(', '  async markCompleted(', '  async markDelivered(']) {
      const body = methodBody(sig);
      expect(body).toContain('_backTabForAction()');
      expect(body).toContain('show(_backTab)');
    }
  });
});

describe('F5 partial-transition message is honest about refresh', () => {
  test('refresh claim is conditional on a real refresh', () => {
    expect(ADMIN_SRC).toContain('_refreshed ?');
    expect(ADMIN_SRC).toContain('তালিকা রিফ্রেশ করা যায়নি');
  });
});

describe('F6 auto-data cache invalidated on BDRIS/engine delete', () => {
  test('both delete paths null the cached lists before reload', () => {
    expect(methodBody('  async deleteBdrisApp(id) {')).toContain('TABS._autoBdris = null');
    expect(methodBody('  async deleteEngineJob(id) {')).toContain('TABS._autoEngine = null');
  });
});

describe('F7 search cap warning also while searching (sidebar-unified-orders)', () => {
  test('client cap notes are gone — the unified list is server-paginated', () => {
    // SUPERSEDED: the old renderAutoData client caps (newest 200
    // BDRIS / 100 engine rows) no longer exist, because the
    // unified list pages on the server (limit=50, total/pages
    // from the endpoint) instead of filtering a cached fetch.
    expect(ADMIN_SRC).not.toContain('শুধু নতুন ২০০টি সারি খোঁজা হয়েছে');
    expect(ADMIN_SRC).not.toContain('শুধু নতুন ১০০টি সারি খোঁজা হয়েছে');
    expect(ADMIN_SRC).not.toContain('renderAutoData');
    expect(ADMIN_SRC).toContain("'/admin/unified-services?limit=50&page='");
  });
});

describe('F8 unified pager from server page/limit/total', () => {
  test('unified list pages the server query', () => {
    // SUPERSEDED: loadAutoData/pageAutoData are gone; paging is
    // the unified list's own pager over the endpoint's pages.
    expect(ADMIN_SRC).toContain("'/admin/unified-services?limit=50&page='");
    expect(ADMIN_SRC).toContain('AdmOrders.page(');
    expect(methodBody('  page(p) {')).toContain('TABS._opage');
    expect(ADMIN_SRC).not.toContain('pageAutoData(');
  });
});

describe('F9 per-section load failures (sidebar-unified-orders)', () => {
  test('unified single fetch fails with one honest message', () => {
    // SUPERSEDED: there are no separate BDRIS/engine/auto
    // sections to fail independently any more — one unified
    // fetch either loads or throws the single list-failure
    // message; a failure never renders as "no records".
    expect(ADMIN_SRC).toContain('তালিকা লোড ব্যর্থ (সার্ভার সমস্যা)');
    expect(ADMIN_SRC).not.toContain('TABS._autoBdrisError');
    expect(ADMIN_SRC).not.toContain('TABS._autoEngineError');
    expect(ADMIN_SRC).not.toContain('TABS._autoOrdersError');
    expect(ADMIN_SRC).not.toContain('BDRIS তালিকা লোড ব্যর্থ হয়েছে');
  });
});

describe('F10 manual summary lists pending as excluded', () => {
  test('exclusion wording names অপেক্ষমান', () => {
    expect(ADMIN_SRC).toContain('নতুন, অপেক্ষমান, প্রসেসিং, ব্যর্থ, বাতিল ও রিফান্ডেড');
  });
});

describe('F11 mobile sticky column is a real 170px', () => {
  test('sticky first column has width + min-width 170px', () => {
    expect(ADMIN_HTML).toContain('width: 170px; min-width: 170px; max-width: 170px;');
  });
});

describe('F12 modal X is a 36px tap target', () => {
  test('stylesheet rule and inline modal style both size the X', () => {
    expect(ADMIN_HTML).toContain('.modal-x');
    expect(ADMIN_HTML).toContain('min-width: 36px; min-height: 36px;');
    expect(ADMIN_SRC).toContain('width:36px;height:36px;min-width:36px;min-height:36px;');
  });
});

describe('F13 36px tap targets', () => {
  test('detail phone-copy button and user-row small buttons', () => {
    expect(ADMIN_SRC).toContain('aria-label="ফোন নম্বর কপি করুন" style="min-width:36px;min-height:36px;');
    expect(ADMIN_SRC).toContain('min-height:36px;padding:9px 12px;');
    expect(ADMIN_SRC).toContain('min-width:36px;min-height:36px;padding:9px 11px;');
  });
});

describe('F14 delete-modal focus never lands on a destructive button', () => {
  test('refundable branch puts cancel (ফিরে যান) before any delete button', () => {
    const body = methodBody('  async deleteOrder(');
    const cancelIdx = body.indexOf('ফিরে যান');
    const deleteIdx = body.indexOf('confirmDelete');
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(deleteIdx).toBeGreaterThan(-1);
    expect(cancelIdx).toBeLessThan(deleteIdx);
  });
  test('modal() focuses the first non-danger control, skipping danger', () => {
    const danger = makeButton({ danger: true });
    const safe = makeButton();
    const { modal } = loadModal([danger, safe]);
    modal('T', '<p>x</p>');
    expect(danger.focused).toBe(false);
    expect(safe.focused).toBe(true);
  });
  test('modal() falls back to the only control when all are danger', () => {
    const danger = makeButton({ danger: true });
    const { modal } = loadModal([danger]);
    modal('T', '<p>x</p>');
    expect(danger.focused).toBe(true);
  });
});

describe('F15 delete focus returns to a durable element', () => {
  test('confirmDelete suppresses the opener restore and focuses the tab', () => {
    const body = methodBody('  async confirmDelete(');
    expect(body).toContain('_returnTo = null');
    expect(body).toContain('_focusAfterDelete(backTab)');
    expect(methodBody('  _focusAfterDelete(backTab) {')).toContain('.side-link[data-t="');
  });
});

describe('sidebar-unified-orders: one orders section, bulk delete, userTotal', () => {
  test('removed sidebar tabs are gone from admin.html; admin.js cache bumped to v=88', () => {
    expect(ADMIN_HTML).not.toContain('data-t="bdrisApps"');
    expect(ADMIN_HTML).not.toContain('data-t="engineJobs"');
    expect(ADMIN_HTML).not.toContain('data-t="autoData"');
    expect(ADMIN_HTML).toContain('/js/admin.js?v=88');
  });
  test('admin engine dropdowns (create + edit) include land-khatian', () => {
    expect(ADMIN_SRC.split('value="land-khatian"').length - 1).toBeGreaterThanOrEqual(2);
    expect(ADMIN_SRC).toContain("s.engine_id === 'land-khatian' ? ' selected' : ''");
  });
  test('admin engine dropdowns (create + edit) include land-mouza-map (2026-11-04)', () => {
    expect(ADMIN_SRC.split('value="land-mouza-map"').length - 1).toBeGreaterThanOrEqual(2);
    expect(ADMIN_SRC).toContain("s.engine_id === 'land-mouza-map' ? ' selected' : ''");
  });
  test('orders list fetches only the unified endpoint with kind labels', () => {
    expect(ADMIN_SRC).toContain("'/admin/unified-services?limit=50&page='");
    expect(ADMIN_SRC).toContain("KIND_LABEL = { order: 'অর্ডার', delivery: 'ডেলিভারি', application: 'আবেদন' }");
    expect(ADMIN_SRC).toContain('স্ট্যাটাস ফিল্টার শুধু অর্ডার সারির ক্ষেত্রে প্রযোজ্য');
  });
  test('bulk delete loops only single-delete paths, orders always refund=no, no refund preview', () => {
    const body = methodBody('  async bulkDeleteUnified() {');
    expect(body).toContain("'/admin/orders/' + it.id + '?confirm=yes&refund=no'");
    expect(body).toContain("'/admin/engine-jobs/' + it.id");
    expect(body).toContain("'/admin/bdris-applications/' + it.id");
    expect(body).not.toContain('refund-preview');
    expect(body).not.toContain('refund=yes');
    // The only refund param in the bulk path is the no-refund one
    // asserted above (refund=no); no other refund value appears.
    expect(body.match(/refund=[a-z]+/g)).toEqual(['refund=no']);
    expect(body).toContain('মুছলে কোনো টাকা ফেরত যাবে না');
  });
  test('userTotal block label is exactly the display-only label, with no action', () => {
    expect(ADMIN_SRC).toContain('মোট কাজের টাকা (সম্পন্ন/ডেলিভার্ড)');
    expect(ADMIN_SRC).toContain('User search total: display only');
  });
  test('restored order-row badge + refund line use order-only fields', () => {
    expect(ADMIN_SRC).toContain('adm-type-badge manual');
    expect(ADMIN_SRC).toContain('r.refund_balance');
    expect(ADMIN_SRC).toContain("r.kind === 'order'");
  });
  test('no new "auto order" wording (one pre-existing toast comment only)', () => {
    // The unified diff itself adds zero occurrences; the single
    // occurrence in the whole file is the pre-existing, untouched
    // stats-toast comment ("a new AUTO order must not be hidden").
    // Pinning the count at 1 fails if any new one is introduced.
    expect((ADMIN_SRC.match(/auto order/gi) || []).length).toBe(1);
    expect(ADMIN_SRC).toContain('a new AUTO order');
  });
});
