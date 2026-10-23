-- 040: Land services (DLRMS) — three automated services reading
-- the OFFICIAL land record through the portal's public guest
-- channel (engines/land-core/client.js, proven live 2026-10-23).
-- The wallet is charged ONLY when a record is found; "not
-- found" is a ৳0 failed order with a receipt. Prices below are
-- starting defaults — admin edits them in Admin → Services.
-- Idempotent: inserts only when the engine_id does not exist.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Land Khatian Search', 'খতিয়ান খোঁজ', 'automated', 20, 6,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: বিভাগ, জেলা, উপজেলা ও মৌজা বেছে নিন।' || chr(10) ||
    'ধাপ ২: খতিয়ান নম্বর লিখুন — জরিপের ধরন বাছতে হবে না, সব ধরনে নিজে খুঁজবে।' || chr(10) ||
    'ধাপ ৩: "খুঁজুন" চাপুন — রেকর্ড পেলে মালিকের নাম, দাগ নম্বর ও মোট জমির রিপোর্ট (PDF) পাবেন।' || chr(10) ||
    'নোট: রেকর্ড পেলেই শুধু চার্জ কাটবে — না পেলে ৳০। এই রিপোর্ট তথ্যের সারাংশ, সরকারি সার্টিফাইড কপি নয়।',
    'land-search', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'land-search');

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Land Owner Scan', 'নামে সম্পত্তি সন্ধান', 'automated', 50, 7,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: বিভাগ, জেলা, উপজেলা ও মৌজা বেছে নিন।' || chr(10) ||
    'ধাপ ২: মালিকের নাম লিখুন — পুরো মৌজা সব জরিপে স্ক্যান করে ওই নামের সব খতিয়ান বের করবে।' || chr(10) ||
    'ধাপ ৩: "সন্ধান করুন" চাপুন — সব খতিয়ান ও মোট জমির হিসাবসহ রিপোর্ট (PDF) পাবেন।' || chr(10) ||
    'নোট: অন্তত একটি খতিয়ান মিললেই শুধু চার্জ কাটবে — না মিললে ৳০।',
    'land-scan', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'land-scan');

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Land Verification Report', 'জমি যাচাই রিপোর্ট', 'automated', 100, 8,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: বিভাগ, জেলা, উপজেলা ও মৌজা বেছে নিন, খতিয়ান নম্বর লিখুন।' || chr(10) ||
    'ধাপ ২: বিক্রেতার দাবি বসান — মালিকের নাম, দাগ নম্বর, জমির পরিমাণ (যা যা জানেন)।' || chr(10) ||
    'ধাপ ৩: "যাচাই করুন" চাপুন — দাবি বনাম সরকারি রেকর্ডের মিল/অমিলের রিপোর্ট (PDF) পাবেন।' || chr(10) ||
    'নোট: খতিয়ানের রেকর্ড পেলেই শুধু চার্জ কাটবে — না পেলে ৳০। জমি কেনার আগে যাচাইয়ের জন্য এই রিপোর্ট ব্যবহার করুন।',
    'land-verify', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'land-verify');
