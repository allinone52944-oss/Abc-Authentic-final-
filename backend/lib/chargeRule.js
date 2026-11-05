'use strict';

// Charge rule per service: WHEN the wallet is cut (audit #49).
// The rules are opposite per service, yet the service cards showed
// only the price — so this is the one place that names the rule,
// derived from the actual charge call sites (not from page copy):
//
// - 'upfront': the wallet is cut at confirm/submit, BEFORE the
//   result. Manual orders pay in POST /orders (routes/user.js —
//   payForService runs before the order INSERT); bdris-apply
//   charges the submit fee before the portal submission
//   (routes/bdris-apply.js charge/submit).
// - 'success': the wallet is cut ONLY when the service succeeds;
//   a failure costs ৳0. Birth/death certificates charge only on a
//   successful verification (lib/engineChargeGate.js — verify path;
//   preview/PDF ride on the same charged attempt). Land engines
//   charge only in succeed(), never in notFound()
//   (routes/land.js, land-khatian.js, land-mouza-map.js). NID
//   replica charges only after a successful build (routes/nid.js);
//   NID server-copy only after a successful build per download
//   (routes/nid-server-copy.js). QR photo-verify charges only on a
//   successful verification (routes/qr-verify.js — the wallet-hold
//   ordering from audit #9; this mapping is presentation data
//   only and touches no QR logic).
//
// Unknown engine_id -> null (no label is ever guessed). A service
// with no engine_id and type manual is the upfront order flow.

const RULES = {
  // engine_id: [rule, detail]
  'bdris-apply': ['upfront', 'জমা দেওয়ার সময়'],
  'bdris-certificate': ['success', 'যাচাই সফল হলেই'],
  'death-verify': ['success', 'যাচাই সফল হলেই'],
  'nid-replica': ['success', 'কার্ড তৈরি হলেই'],
  'nid-server-copy': ['success', 'প্রতিটি সফল ডাউনলোডে'],
  'land-search': ['success', 'রেকর্ড পেলেই'],
  'land-scan': ['success', 'রেকর্ড পেলেই'],
  'land-verify': ['success', 'রেকর্ড পেলেই'],
  'land-mouza-value': ['success', 'রিপোর্ট তৈরি হলেই'],
  'land-khatian': ['success', 'খতিয়ান পেলেই'],
  'land-mouza-map': ['success', 'ম্যাপ পেলেই'],
  'qr-photo-verify': ['success', 'যাচাই সফল হলেই'],
};

const LABELS = {
  upfront: 'আগে কাটবে',
  success: 'সফল হলেই কাটবে',
};

function chargeRuleFor(service) {
  if (!service) return null;
  const entry = service.engine_id ? RULES[service.engine_id] : null;
  if (entry) {
    return { rule: entry[0], label: LABELS[entry[0]], detail: entry[1] };
  }
  if (service.type === 'manual' || !service.engine_id) {
    return { rule: 'upfront', label: LABELS.upfront, detail: 'অর্ডার কনফার্মের সাথে সাথে' };
  }
  return null;
}

module.exports = { chargeRuleFor, RULES, LABELS };
