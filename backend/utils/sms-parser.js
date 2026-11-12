// ============================================================
// All In One (Abc Authentic) - MFS SMS parser
// Parses bKash / Nagad / Rocket money-received SMS text into
// { method, amount, sender, trxid, direction }.
// Returns null when nothing usable can be extracted.
// Pure functions — no DB, no side effects (easy to unit test).
// ============================================================

'use strict';

const SENDER_METHOD = {
  bkash: 'bkash', '16247': 'bkash',
  nagad: 'nagad', '16167': 'nagad',
  rocket: 'rocket', dbbl: 'rocket', '16216': 'rocket',
};

// "Tk 500.00", "TK 1,250.50", "BDT 500", "৳৫০০"
const AMOUNT_RE = /(?:Tk|TK|BDT|৳)\s*([\d,]+(?:\.\d{1,2})?)/i;
const RECEIVED_AMOUNT_RE = /(?:received|credited|cash\s*in)[\s\S]{0,40}?(?:Tk|TK|BDT|৳)\s*[\d,]+(?:\.\d{1,2})?/i;

// Complete bounded token: never silently truncate a long provider ID.
// The manual form accepts up to 40 characters, so the parser does too.
// TrxID priority (Bug #5): an explicit TrxID/TxnID always wins over a
// "Reference"/"Ref" number. The old single regex took the LEFTMOST match,
// so "Reference: 20261112001. TrxID: DKC4E2R81M" returned the Reference.
// The Reference/Ref pattern stays as a fallback for SMS that carry no
// explicit TrxID — those still get a trxid.
const TRXID_RE = /(?:TrxID|TxnID|Txn\s*ID)\s*:?\s*([A-Z0-9]{6,40})(?![A-Z0-9])/i;
const REF_RE = /(?:Reference|Ref)\s*:?\s*([A-Z0-9]{6,40})(?![A-Z0-9])/i;

// Sender mobile (Bug #6): every accepted spelling normalizes to the exact
// 11-digit 01XXXXXXXXX form the matcher relies on. Accepted:
//   "from 017XXXXXXXX" (existing), "from +8801712345678" (+880 prefix),
//   separators ("from 0171-2345678", "from 0171 234 5678"),
//   "Sender: 017XXXXXXXX" / "Sender No: 017XXXXXXXX",
//   Rocket "A/C:017XXXXXXXX-X" (trailing check digit dropped).
// A candidate that cannot normalize to 01[3-9]XXXXXXXXX returns null —
// never guessed. "to 017XXXXXXXX" is deliberately NOT a sender: on
// money-out SMS that number is the recipient, not the payer, and sender
// feeds the matcher.
function normalizeBdMobile(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[\s\-()]/g, '');
  if (d.startsWith('+880')) d = '0' + d.slice(4);
  else if (d.startsWith('880')) d = '0' + d.slice(3);
  if (!/^01[3-9]\d{8}$/.test(d)) return null;
  return d;
}

function parseSender(rawMessage) {
  const m = String(rawMessage || '');
  const candidates = [];
  const fromM = m.match(/from\s+(\+?[\d][\d\s\-()]{7,13}\d)/i);
  if (fromM) candidates.push(fromM[1]);
  const senderM = m.match(/\bsender(?:\s+no\.?)?\s*:?\s*(\+?[\d][\d\s\-()]{7,13}\d)/i);
  if (senderM) candidates.push(senderM[1]);
  const acctM = m.match(/A\/C:?\s*(\+?[\d][\d\s\-()]{7,13}\d)/i);
  if (acctM) candidates.push(acctM[1].replace(/-\d$/, ''));
  for (const c of candidates) {
    const n = normalizeBdMobile(c);
    if (n) return n;
  }
  return null;
}

function detectMethod(rawMessage, rawSender) {
  const s = String(rawSender || '').trim().toLowerCase();
  if (SENDER_METHOD[s]) return SENDER_METHOD[s];
  const m = String(rawMessage || '');
  if (/bkash/i.test(m)) return 'bkash';
  if (/nagad/i.test(m)) return 'nagad';
  if (/rocket|dutch[\s-]?bangla|\bdbbl\b/i.test(m)) return 'rocket';
  return 'unknown';
}

function normalizeDigits(value) {
  return String(value || '').replace(/[০-৯]/g, d => String('০১২৩৪৫৬৭৮৯'.indexOf(d)));
}

function detectDirection(rawMessage) {
  const m = String(rawMessage || '');
  // Negated or contradictory wording is not proof of money-in.
  if (/\b(?:not|never)\s+(?:received|credited)\b/i.test(m)) return 'unknown';
  const incoming = /receiv|credited|cash\s*in/i.test(m);
  const outgoing = /debited|\bsent\b|payment\s+.*\bto\b|cash\s*out/i.test(m);
  if (incoming && outgoing) return 'unknown';
  if (incoming) return 'in';
  if (outgoing) return 'out';
  return 'unknown';
}

function parseAmount(rawMessage) {
  const normalized = normalizeDigits(rawMessage);
  // Prefer the amount attached to received/credited/cash-in wording, so a
  // leading fee or balance cannot become the recharge amount by accident.
  const received = normalized.match(RECEIVED_AMOUNT_RE);
  const m = (received ? received[0] : normalized).match(AMOUNT_RE);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function parseSms(rawMessage, rawSender) {
  if (!rawMessage || !String(rawMessage).trim()) return null;

  // Real TrxID first; Reference/Ref only when no explicit TrxID exists.
  const trxidM = String(rawMessage).match(TRXID_RE) || String(rawMessage).match(REF_RE);
  const amount = parseAmount(rawMessage);
  if (!trxidM && amount == null) return null; // nothing usable

  const sender = parseSender(rawMessage);

  return {
    method: detectMethod(rawMessage, rawSender),
    amount,
    sender,
    trxid: trxidM ? trxidM[1].toUpperCase() : null,
    direction: detectDirection(rawMessage),
  };
}

module.exports = { parseSms, detectMethod, detectDirection, parseAmount, parseSender };
