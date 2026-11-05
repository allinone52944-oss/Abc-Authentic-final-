// Audit #49 — charge rules are opposite per service, yet the cards
// showed only the price. Cards + details now carry a small label
// naming WHEN the fee is cut (from the API's charge_rule, which the
// backend derives from the charge call sites — never guessed).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('services.html — charge-rule label on cards (audit #49)', () => {
  const html = read('frontend/services.html');

  test('a chargeRuleHtml helper renders label + detail from the API rule', () => {
    expect(html).toContain('function chargeRuleHtml(s){');
    expect(html).toContain('s.charge_rule');
    expect(html).toContain('r.label');
    expect(html).toContain('r.detail');
  });

  test('the label is shown on both card shapes (land group + regular)', () => {
    expect(html).toContain("chargeRuleHtml(s) + '</div></div>'");
    const cardFn = html.slice(html.indexOf('function card(s){'), html.indexOf('let GROUPS'));
    expect(cardFn.match(/chargeRuleHtml\(s\)/g)).toHaveLength(2);
  });

  test('no label for free services or unknown rules (never guessed)', () => {
    expect(html).toContain('if(!r || !(Number(s.price) > 0)) return');
  });
});

describe('service-detail.html — charge-rule line (audit #49)', () => {
  const html = read('frontend/service-detail.html');

  test('the detail shows label + detail, and the ৳0 line for success-only rules', () => {
    expect(html).toContain('s.charge_rule');
    expect(html).toContain('s.charge_rule.label');
    expect(html).toContain('s.charge_rule.detail');
    expect(html).toContain('না পেলে ৳০ — কোনো টাকা কাটা হবে না');
  });

  test('no label without a rule or for a free service', () => {
    expect(html).toContain("((price > 0 && s.charge_rule) ?");
  });
});
