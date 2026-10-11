-- 010: Death Record Verify automated service (engine: death-verify)
-- The engine folder is an as-is copy of Death-Verify-Engine.zip,
-- mounted at /api/death-engine. UI: frontend/death-verify.html (4-step wizard).
-- Idempotent: only inserts when no service with this engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Death Record Verify',
    'মৃত্যু নিবন্ধন যাচাই',
    'automated',
    100,
    2,
    '[]'::jsonb,
    '[{"name":"drn","label":"Death Registration No (১৭ সংখ্যা)","label_en":"DRN (17 digits)","type":"text","required":true,"pattern":"^[0-9]{17}$"},{"name":"dod","label":"মৃত্যু তারিখ","label_en":"Date of Death","type":"date","required":true}]'::jsonb,
    '{}'::jsonb,
    'ধাপ ১: Death Registration No (১৭ সংখ্যা) ও মৃত্যু তারিখ দিন।' || chr(10) ||
    'ধাপ ২: ক্যাপচা ছবি দেখে উত্তর লিখুন (অথবা স্বয়ংক্রিয় চেষ্টা করুন)।' || chr(10) ||
    'ধাপ ৩: BDRIS থেকে মৃত্যু তথ্য যাচাই হবে — নাম ও তথ্য মিলিয়ে নিন।' || chr(10) ||
    'ধাপ ৪: "সনদ তৈরি করুন" চাপুন — A4 PDF ডাউনলোড হবে।' || chr(10) ||
    'নোট: শুধুমাত্র আপনার নিজের/অনুমোদিত তথ্য ব্যবহার করুন।',
    'death-verify',
    'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'death-verify');
