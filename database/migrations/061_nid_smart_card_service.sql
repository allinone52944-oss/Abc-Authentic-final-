-- 061: NID Smart Card engine service row
-- (new engine frontend/nid-smart-card.html + backend route
-- backend/routes/nid-smart-card.js + adapter
-- engines/nid-smart-card/: the customer uploads an NID form
-- PDF; the engine extracts the fields, the customer reviews/edits
-- them, and Create builds the new smart card (front+back, one
-- Letter page, MRZ + PDF417 barcode) for ONE charge.
-- v2 template only — the old 2-page card template is not in this
-- engine.
--
-- PRICE IS DELIBERATELY 0: the admin sets the fee in
-- Admin → Services (a separate fee row exists from this
-- migration; the amount is the admin's decision, never
-- baked in) — same convention as migration 048 and 058/059/060.
-- Serial 17 = next free number after 060 (16).
-- Idempotent: only inserts when no service with this
-- engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Sign to Smart Card Pdf', 'স্মার্ট কার্ড পিডিএফ', 'automated', 0, 17,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: NID ফর্ম PDF আপলোড করুন।' || chr(10) ||
    'ধাপ ২: তথ্য মিলিয়ে নিন — ভুল থাকলে ঠিক করে দিন। প্রদানের তারিখ আজকের তারিখে আগে থেকে বসানো থাকে, চাইলে বদলে দিন।' || chr(10) ||
    'ধাপ ৩: Create করুন — এক চার্জে স্মার্ট কার্ড PDF ডাউনলোড হবে।' || chr(10) ||
    'নোট: এই পাতাটি কার্ড তৈরির সহায়ক — NID ইস্যু করে নির্বাচন কমিশন।',
    'nid-smart-card', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'nid-smart-card');
