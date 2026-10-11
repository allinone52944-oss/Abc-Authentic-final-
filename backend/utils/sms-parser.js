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

// First money figure in the message is the received amount:
// "Tk 500.00", "TK 1,250.50", "BDT 500", "৳৫০০"
const AMOUNT_RE = /(?:Tk|TK|BDT|৳)\s*([\d,]+(?:\.\d{1,2})?)/;

// Transaction reference:
// "TrxID 9HXK2LQM4N", "TrxID: ABC123DEFG", "TxnID: ABCD1234",
// "Txn ID ABCD1234", "Ref: TRX123456", "Reference 9HXK2LQM4N"
const TRXID_RE = /(?:TrxID|TxnID|Txn\s*ID|Reference|Ref)\s*:?\s*([A-Z0-9]{6,24})/i;

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

function detectDirection(rawMessage) {
  const m = String(rawMessage || '');
  if (/receiv|credited|cash\s*in/i.test(m)) return 'in';
  if (/debited|\bsent\b|payment\s+.*\bto\b|cash\s*out/i.test(m)) return 'out';
  return 'unknown';
}

function parseAmount(rawMessage) {
  const m = String(rawMessage || '').match(AMOUNT_RE);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function parseSms(rawMessage, rawSender) {
  if (!rawMessage || !String(rawMessage).trim()) return null;

  const trxidM = String(rawMessage).match(TRXID_RE);
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
