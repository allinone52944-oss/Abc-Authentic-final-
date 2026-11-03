/**
 * Frontend unit tests — P1 premium gaps: admErrBn() + admRefundText()
 * in frontend/js/admin.js. Same extraction approach as admin.test.js:
 * read the CURRENT source and evaluate the exact function definitions.
 */
const fs = require('fs');
const path = require('path');

const ADMIN_SRC = fs.readFileSync(
  path.join(__dirname, '../../../frontend/js/admin.js'),
  'utf8',
);

function extractFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\s*\\('));
  if (!m) throw new Error('function not found in admin.js: ' + name);
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  throw new Error('unbalanced braces for: ' + name);
}

function load() {
  const code = ['bn', 'admErrBn', 'admRefundText'].map((n) => extractFn(ADMIN_SRC, n)).join('\n');
  const factory = new Function(code + '\nreturn { bn, admErrBn, admRefundText };');
  return factory();
}

describe('admErrBn() — no raw codes / HTTP numbers in admin UI', () => {
  test('maps known order-action codes to Bengali', () => {
    const { admErrBn } = load();
    expect(admErrBn('ALREADY_REFUNDED')).toBe('এই অর্ডারের টাকা আগেই ফেরত দেওয়া হয়েছে');
    expect(admErrBn('INVALID_TRANSITION')).toBe('এই অবস্থা থেকে ওই অবস্থায় নেওয়া যাবে না');
    expect(admErrBn('INVALID_STATUS')).toBe('অবৈধ স্ট্যাটাস — আবার চেষ্টা করুন');
    expect(admErrBn('NOT_FOUND')).toBe('অর্ডার পাওয়া যায়নি');
  });

  test('maps an embedded code inside a longer message', () => {
    const { admErrBn } = load();
    expect(admErrBn('failed: ALREADY_REFUNDED')).toBe('এই অর্ডারের টাকা আগেই ফেরত দেওয়া হয়েছে');
  });

  test('maps HTTP numbers and unknown code-like tokens to generic Bengali', () => {
    const { admErrBn } = load();
    expect(admErrBn('500')).toMatch(/সার্ভার সমস্যা/);
    expect(admErrBn('SOME_FUTURE_CODE')).toMatch(/সার্ভার সমস্যা/);
    expect(admErrBn('SOME_FUTURE_CODE')).not.toContain('SOME_FUTURE_CODE');
  });

  test('passes ordinary Bengali messages through unchanged', () => {
    const { admErrBn } = load();
    expect(admErrBn('বাতিল ব্যর্থ')).toBe('বাতিল ব্যর্থ');
  });
});

describe('admRefundText() — split-aware wording, never wallet-only', () => {
  test('names both wallet and credit parts', () => {
    const { admRefundText } = load();
    const t = admRefundText({ balancePart: 100, creditPart: 50 }, 150, false);
    expect(t).toMatch(/ওয়ালেটে/);
    expect(t).toMatch(/ওই সেবার ক্রেডিটে/);
    expect(t).toMatch(/ফেরত যাবে/);
  });

  test('past tense for completed refunds; credit-only names credit only', () => {
    const { admRefundText } = load();
    expect(admRefundText({ balancePart: 0, creditPart: 50 }, 50, true)).toMatch(/ফেরত দেওয়া হয়েছে/);
    expect(admRefundText({ balancePart: 0, creditPart: 50 }, 50, true)).not.toMatch(/ওয়ালেটে/);
  });

  test('alreadyRefunded split says the money is already back', () => {
    const { admRefundText } = load();
    expect(admRefundText({ alreadyRefunded: true }, 200, false)).toBe('এই অর্ডারের টাকা আগেই ফেরত দেওয়া হয়েছে');
  });
});
