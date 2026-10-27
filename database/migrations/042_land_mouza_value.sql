-- 042: Land mouza-value report service (engine: land-mouza-value)
-- Clean Bengali report from rates the shopkeeper enters from the
-- schedule they have checked (automated schedule lookup is a
-- future step — its endpoints are unmapped and never guessed).
-- Calculation: per line = rate per shatangsho × amount in
-- shatangsho; total = sum of lines; deed basis = max(total,
-- declared price). Wallet is charged ONLY on a valid report;
-- invalid input is 400 with NO charge.
-- Price below is a STARTING DEFAULT only — admin edits it in
-- Admin → Services, and the owner may change it before deploy.
-- The customer report carries NO watermark, NO source name,
-- NO source link, NO source branding, and NO raw schedule scan.
-- It states plainly: NOT a certified copy, NOT ownership /
-- title / possession proof, NOT market value, NOT a final deed
-- bill; deed fee/tax percentages are NOT quoted as official
-- rates; confirm at the sub-registrar office before a deed.
-- Idempotent: only inserts when no service with this engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Land Mouza Value Report', 'মৌজা মূল্য রিপোর্ট', 'automated', 50, 10,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: বিভাগ, জেলা, উপজেলা ও মৌজা বেছে নিন।' || chr(10) ||
    'ধাপ ২: প্রতিটি লাইনে জমির শ্রেণি, যাচাই করা তালিকার হার (প্রতি শতাংশ) ও পরিমাণ বসান — কাঠা/বিঘা দিলে শতাংশে রূপান্তর হবে।' || chr(10) ||
    'ধাপ ৩: "রিপোর্ট তৈরি করুন" চাপুন — মোট সর্বনিম্ন মূল্য, শ্রেণিভিত্তিক ভাগ ও দলিলের ভিত্তিসহ পরিষ্কার রিপোর্ট (PDF) পাবেন।' || chr(10) ||
    'নোট: বৈধ রিপোর্ট হলেই শুধু চার্জ কাটবে — ভুল ইনপুটে ৳০। এই রিপোর্ট সার্টিফাইড কপি নয়, মালিকানা/স্বত্ব/দখলের প্রমাণ নয়, বাজারমূল্য নয়, চূড়ান্ত দলিল বিল নয়। দলিলের আগে সাব-রেজিস্ট্রার অফিসে হার ও তালিকার সংস্করণ মিলিয়ে নিন।',
    'land-mouza-value', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'land-mouza-value');
