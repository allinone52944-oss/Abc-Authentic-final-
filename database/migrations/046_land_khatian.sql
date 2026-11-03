-- 046: Land khatian search service (engine: land-khatian,
-- SPEC Phase 1: login-free search + summary only).
-- Reads the official land record through the DLRMS public
-- guest channel (engines/land-core/client.js, re-verified
-- live 2026-11-03) via engines/land-khatian/adapter.js:
-- search by khatian number, owner name and/or dag number
-- across the surveys the portal offers in the upazila
-- (surveyId 'all'), one survey, or the conditional
-- MUTATION-key passthrough (surveyId 'mutation' — the
-- portal accepts the key but returned 0 items on the
-- verified sample, so mutation lookup is UNPROVEN and an
-- empty result means not-found, never a claimed success).
-- Wallet is charged ONLY when at least one record is
-- found; "not found" is a ৳0 failed order with a receipt.
-- The customer PDF is a clean summary: NO watermark, NO
-- source site name/link/branding, and it states plainly
-- that it is NOT a certified copy.
-- PRICE IS DELIBERATELY 0: Pankaj sets the price in
-- Admin → Services (a ৳30 figure was proposed, but it is
-- NOT baked into this migration).
-- Serial 11 = next free number after 040 (6,7,8), 041 (9)
-- and 042 (10).
-- Idempotent: only inserts when no service with this
-- engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Land Khatian Search (Summary)', 'খতিয়ান অনুসন্ধান', 'automated', 0, 11,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: বিভাগ, জেলা, উপজেলা ও মৌজা বেছে নিন (এলাকার তালিকা সরকারি পোর্টাল থেকে সরাসরি আসে)।' || chr(10) ||
    'ধাপ ২: খতিয়ান নম্বর, মালিকের নাম অথবা দাগ নম্বর — যেকোনো একটি (বা একাধিক) লিখুন; জরিপের ধরন বাছতে হবে না, সব ধরনে নিজে খুঁজবে।' || chr(10) ||
    'ধাপ ৩: "খুঁজুন" চাপুন — রেকর্ড পেলে মালিকের নাম, দাগ নম্বর ও মোট জমির সারাংশ রিপোর্ট (PDF) পাবেন।' || chr(10) ||
    'নোট: অন্তত একটি খতিয়ান মিললেই শুধু চার্জ কাটবে — না মিললে ৳০। নামজারি (মিউটেশন) অনুসন্ধানও চেষ্টা করা হয়, তবে পোর্টালে তথ্য না থাকলে ফল পাওয়া যাবে না।' || chr(10) ||
    'সীমা: এই রিপোর্ট তথ্যের সারাংশ মাত্র — এটি সরকারি সার্টিফাইড কপি নয়, মালিকানা/স্বত্ব/দখলের প্রমাণ নয়। অফিসিয়াল কাজে সরকারি পোর্টালে যাচাই করে নিন।',
    'land-khatian', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'land-khatian');
