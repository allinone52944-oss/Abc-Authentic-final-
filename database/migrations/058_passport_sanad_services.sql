-- 058: Passport + Sanad/Certificate engine service rows
-- (pages moved into frontend/ static serving in 592f4e2:
-- frontend/passport.html and frontend/sanad.html).
--
-- The two engines were built Nov 10, 2026 and sat in public/
-- (which the backend never served), so they had no service
-- rows and no links — this migration publishes them as
-- services. They are standalone pages (no backend route),
-- exactly like land-mouza-map's page.
--
-- PRICE IS DELIBERATELY 0: the admin sets the fee in
-- Admin → Services (a separate fee row exists from this
-- migration; the amount is the admin's decision, never
-- baked in) — same convention as migration 048.
-- Serial 13 (passport) and 14 (sanad) = next free numbers
-- after 048 (12).
-- Idempotent: only inserts when no service with this
-- engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Passport Engine', 'পাসপোর্ট ইঞ্জিন', 'automated', 0, 13,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: পাসপোর্টের তথ্য বসান — নাম, জন্মতারিখ, জাতীয়তা ও পাসপোর্ট নম্বর।' || chr(10) ||
    'ধাপ ২: প্রিভিউ দেখে যাচাই করুন — MRZ লাইন ও নম্বর ঠিক আছে কি না মিলিয়ে নিন।' || chr(10) ||
    'নোট: এই পাতাটি আবেদন/যাচাইয়ের সহায়ক — পাসপোর্ট ইস্যু করে সরকারি পাসপোর্ট অফিস।',
    'passport', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'passport');

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'BD Sanad & Certificate Engine', 'সনদ ও সার্টিফিকেট ইঞ্জিন', 'automated', 0, 14,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: সনদের ধরন বেছে নিন ও প্রয়োজনীয় তথ্য বসান।' || chr(10) ||
    'ধাপ ২: প্রিভিউ দেখে যাচাই করুন — নাম, ঠিকানা ও সনদের বিবরণ ঠিক আছে কি না মিলিয়ে নিন।' || chr(10) ||
    'ধাপ ৩: প্রিন্ট / PDF সংরক্ষণ করুন।' || chr(10) ||
    'নোট: এই পাতাটি আবেদন/যাচাইয়ের সহায়ক — সনদ ইস্যু করে সংশ্লিষ্ট কর্তৃপক্ষ।',
    'sanad', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'sanad');
