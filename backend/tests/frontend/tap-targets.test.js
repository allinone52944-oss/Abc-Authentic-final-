// Audit #60 — small tap targets on filing-flow buttons (copy buttons
// at 4–5px padding, mini-btn at 4px 8px, .pvedit at 5px 11px).
// Fix: a 36px min-height floor on touch screens (admin precedent).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('tap targets are at least 36px on touch screens (audit #60)', () => {
  test('premium.css gives .btn-secondary/.mini-btn a 36px floor at the tablet breakpoint', () => {
    const css = read('frontend/css/premium.css');
    const mq = css.slice(css.indexOf('@media (max-width: 900px)'));
    expect(mq).toContain('.btn-secondary, .mini-btn {');
    expect(mq).toContain('min-height: 36px;');
  });

  test('the cited filing-flow buttons all carry a floored class', () => {
    // order-create copy button, order-detail file + tracker buttons,
    // service-detail copy button — each is .btn-secondary or .mini-btn,
    // so the shared floor reaches it despite its tiny inline padding.
    expect(read('frontend/order-create.html')).toContain('class="btn btn-secondary" onclick="copySampleText()"');
    expect(read('frontend/order-detail.html')).toContain('class="mini-btn"');
    expect(read('frontend/order-detail.html')).toContain('class="btn btn-secondary" style="padding:5px 12px;');
    expect(read('frontend/service-detail.html')).toContain('class="btn btn-secondary" onclick="event.stopPropagation();copySample()"');
  });

  test('bdris-apply .pvedit has a 36px floor at ≤760px', () => {
    const html = read('frontend/bdris-apply.html');
    const mq = html.slice(html.indexOf('@media (max-width:760px){'));
    expect(mq).toContain('.pvedit{min-height:36px;');
  });
});
