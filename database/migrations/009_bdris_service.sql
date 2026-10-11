-- 009: BDRIS Birth Certificate automated service (engine: bdris-certificate)
-- The engine folder is a byte-identical copy of BuilderEngine-fixed.zip,
-- mounted at /bdris-engine. UI: frontend/bdris-certificate.html (4-step wizard).
-- Idempotent: only inserts when no service with this engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'BDRIS Birth Certificate',
    'জন্ম নিবন্ধন সনদ',
    'automated',
    100,
    1,
    '[]'::jsonb,
    '[{"name":"brn","label":"BRN (১৭ সংখ্যা)","label_en":"BRN (17 digits)","type":"text","required":true,"pattern":"^[0-9]{17}$"},{"name":"dob","label":"জন্ম তারিখ","label_en":"Date of Birth","type":"date","required":true}]'::jsonb,
    '{}'::jsonb,
    'ধাপ ১: BRN (১৭ সংখ্যা) ও জন্ম তারিখ দিন।' || chr(10) ||
    'ধাপ ২: ক্যাপচা ছবি দেখে উত্তর লিখুন (অথবা স্বয়ংক্রিয় চেষ্টা করুন)।' || chr(10) ||
    'ধাপ ৩: BDRIS থেকে তথ্য যাচাই হবে — নাম ও তথ্য মিলিয়ে নিন।' || chr(10) ||
    'ধাপ ৪: "সনদ তৈরি করুন" চাপুন — A4 PDF ডাউনলোড হবে।' || chr(10) ||
    'নোট: শুধুমাত্র আপনার নিজের/অনুমোদিত তথ্য ব্যবহার করুন।',
    'bdris-certificate',
    'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'bdris-certificate');
