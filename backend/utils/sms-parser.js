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

// Sender mobile: "from 017XXXXXXXX"
const FROM_RE = /from\s+(01[3-9]\d{8})/i;

// Rocket account: "A/C:017XXXXXXXX-X" / "A/C 017XXXXXXXXX"
const ACCT_RE = /A\/C:?\s*(01[3-9]\d{7,10}(?:-\d)?)/i;

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

  const fromM = String(rawMessage).match(FROM_RE);
  const acctM = String(rawMessage).match(ACCT_RE);
  const sender = fromM ? fromM[1] : (acctM ? acctM[1] : null);

  return {
    method: detectMethod(rawMessage, rawSender),
    amount,
    sender,
    trxid: trxidM ? trxidM[1].toUpperCase() : null,
    direction: detectDirection(rawMessage),
  };
}

module.exports = { parseSms, detectMethod, detectDirection, parseAmount };
