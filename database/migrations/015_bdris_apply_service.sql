-- 015: BDRIS Application automated service (engine: bdris-apply)
-- The engine folder is an as-is copy of Bdris-apply-v2-CLEAN-v23.zip
-- (BDRIS Auto-fill Bot v6: Express + Socket.IO + Playwright).
-- Mounted at /api/bdris-apply. UI: frontend/bdris-apply.html.
-- Pricing (both admin-configurable, no hardcoded prices):
--   * Submit charge: this row's `price` (Admin → Services → edit price).
--     Deducted via POST /api/bdris-apply/charge/submit before SUBMIT_S4_OTP.
--   * PDF download charge: settings key 'bdris_apply.pdf_price'
--     (Admin → Settings). Deducted via POST /api/bdris-apply/charge/pdf
--     before FETCH_ORIGINAL. Default 0.
-- Idempotent: only inserts when no service with this engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'BDRIS Application',
    'বিডিআরআইএস আবেদন',
    'automated',
    100,
    4,
    '[]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    'ধাপ ১: আবেদনের ভিত্তি (জন্মস্থান/স্থায়ী ঠিকানা)।' || chr(10) ||
    'ধাপ ২: ব্যক্তির পরিচিতি (নাম, জন্ম তারিখ, ঠিকানা)।' || chr(10) ||
    'ধাপ ৩: পিতামাতার তথ্য (BRN যাচাই)।' || chr(10) ||
    'ধাপ ৪: ডকুমেন্ট আপলোড।' || chr(10) ||
    'ধাপ ৫: OTP দিয়ে জমা।' || chr(10) ||
    'নোট: জমা দেওয়ার সময় সার্ভিস চার্জ ওয়ালেট থেকে কাটবে। PDF ডাউনলোডে আলাদা চার্জ (অ্যাডমিন নির্ধারিত)।',
    'bdris-apply',
    'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'bdris-apply');

-- Default PDF download price (admin can change in Settings)
INSERT INTO settings (key, value)
SELECT 'bdris_apply.pdf_price', '0'
WHERE NOT EXISTS (SELECT 1 FROM settings WHERE key = 'bdris_apply.pdf_price');
