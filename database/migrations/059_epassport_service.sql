-- 059: E-Passport engine service row
-- (new page frontend/epassport.html — the e-passport branch
-- of the passport engine: entering the passport engine offers
-- an MRP / e-passport choice; e-passport uses the document-data
-- engine logic from the user-provided file, integrated the same
-- way as the MRP passport engine: site shell, login gate,
-- charge/order via backend, form -> Create -> real PDF).
--
-- PRICE IS DELIBERATELY 0: the admin sets the fee in
-- Admin → Services (a separate fee row exists from this
-- migration; the amount is the admin's decision, never
-- baked in) — same convention as migration 048 and 058.
-- Serial 15 = next free number after 058 (14).
-- Idempotent: only inserts when no service with this
-- engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'E-Passport Engine', 'ই-পাসপোর্ট ইঞ্জিন', 'automated', 0, 15,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: ই-পাসপোর্টের তথ্য বসান — নাম, জন্মতারিখ, জাতীয়তা ও পাসপোর্ট নম্বর।' || chr(10) ||
    'ধাপ ২: প্রিভিউ দেখে যাচাই করুন — MRZ লাইন ও নম্বর ঠিক আছে কি না মিলিয়ে নিন।' || chr(10) ||
    'নোট: এই পাতাটি আবেদন/যাচাইয়ের সহায়ক — পাসপোর্ট ইস্যু করে সরকারি পাসপোর্ট অফিস।',
    'epassport', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'epassport');
