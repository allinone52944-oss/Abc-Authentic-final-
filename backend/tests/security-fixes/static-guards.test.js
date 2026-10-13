// FIX-7 + FIX-17 notes.
// FIX-7 (modal() title escaped) is a FRONTEND fix — the backend suite has no
// DOM, so there is no behavioral backend test. This file keeps a static
// source guard so the fix cannot silently regress.
// FIX-17 (frontend api() clears stale tokens on failed refresh) is likewise
// frontend-only; per task scope it is NOT tested here (task #3 covers the
// frontend). The skipped block below documents that explicitly.
const fs = require('fs');
const path = require('path');

const ADMIN_JS = path.join(__dirname, '../../../frontend/js/admin.js');

describe('FIX-7 modal() title escaping — static source guard (frontend fix)', () => {
  test('modal() renders its title through esc(), never raw', () => {
    const src = fs.readFileSync(ADMIN_JS, 'utf8');
    const m = src.match(/function modal\(title, bodyHtml\) \{[\s\S]*?\n\}/);
    expect(m).not.toBeNull();
    expect(m[0]).toContain('esc(title)');
    expect(m[0]).not.toMatch(/\+\s*title\s*\+/);
  });
});

describe.skip('FIX-17 api() clears stale tokens on failed refresh — N/A in backend suite', () => {
  test('frontend-only fix; covered by task #3 (frontend tests), not here', () => {
    // Intentionally skipped: do not test frontend behavior in the backend suite.
  });
});
