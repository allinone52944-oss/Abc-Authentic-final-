-- 014: NID Card Replica automated service (engine: nid-replica)
-- The engine folder is an as-is copy of NID-Engine-Fixed.zip (Python kit),
-- mounted at /api/nid-engine. UI: frontend/nid-replica.html (4-step wizard).
-- Idempotent: only inserts when no service with this engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'NID Card Replica',
    'এনআইডি কার্ড রেপ্লিকা',
    'automated',
    50,
    3,
    '[]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    'ধাপ ১: আপনার NID ফর্মের PDF আপলোড করুন।' || chr(10) ||
    'ধাপ ২: তথ্য বের হচ্ছে — অপেক্ষা করুন।' || chr(10) ||
    'ধাপ ৩: কার্ডের তথ্য মিলিয়ে নিন, ভুল থাকলে ঠিক করুন।' || chr(10) ||
    'ধাপ ৪: "কার্ড তৈরি করুন" চাপুন — PDF ডাউনলোড হবে।' || chr(10) ||
    'নোট: শুধুমাত্র আপনার নিজের/অনুমোদিত তথ্য ব্যবহার করুন।',
    'nid-replica',
    'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'nid-replica');
