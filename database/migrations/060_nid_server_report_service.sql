-- 060: NID Server Copy Report engine service row
-- (new engine frontend/nid-server-report.html + backend route
-- backend/routes/nid-server-report.js + adapter
-- engines/nid-server-report/: the customer uploads an NID form
-- PDF (or an old v1/v2 report); the engine extracts the fields,
-- the customer reviews/edits them, and Create builds TWO report
-- PDFs — v1 (everything-bd print style) and v2 (NIDW print style,
-- photo + fresh QR) — for ONE charge.
--
-- PRICE IS DELIBERATELY 0: the admin sets the fee in
-- Admin → Services (a separate fee row exists from this
-- migration; the amount is the admin's decision, never
-- baked in) — same convention as migration 048 and 058/059.
-- Serial 16 = next free number after 059 (15).
-- Idempotent: only inserts when no service with this
-- engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'NID Server Copy Report', 'এনআইডি সার্ভার কপি রিপোর্ট', 'automated', 0, 16,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: NID ফর্ম PDF (বা পুরোনো v1/v2 রিপোর্ট) আপলোড করুন।' || chr(10) ||
    'ধাপ ২: তথ্য মিলিয়ে নিন — ভুল থাকলে ঠিক করে দিন।' || chr(10) ||
    'ধাপ ৩: Create করুন — এক চার্জে v1 + v2 দুটো সার্ভার কপি রিপোর্ট PDF ডাউনলোড হবে।' || chr(10) ||
    'নোট: এই পাতাটি রিপোর্ট তৈরির সহায়ক — NID ইস্যু করে নির্বাচন কমিশন।',
    'nid-server-report', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'nid-server-report');
