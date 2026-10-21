-- 036: QR + Photo Verification automated service (engine: qr-photo-verify)
-- Verification runs through the NID Secure Gateway (my-api.top);
-- the gateway API key lives in settings key 'qr_verify' (Admin →
-- Settings), never in code. Wallet is charged ONLY on a verified
-- match (the gateway itself charges only on success: ৳30/call).
-- Price below is just the starting default — admin edits it in
-- Admin → Services like every other service.
-- Idempotent: only inserts when no service with this engine_id exists.
INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'QR Photo Verification',
    'QR + ছবি যাচাই',
    'automated',
    50,
    5,
    '[]'::jsonb,
    '[]'::jsonb,
    '{}'::jsonb,
    'ধাপ ১: যার যাচাই করবেন তার NID নম্বর/আইডি লিখুন।' || chr(10) ||
    'ধাপ ২: তার NID-এর QR কোডের ছবি আপলোড করুন (প্রতিটি QR মাত্র একবার ব্যবহারযোগ্য)।' || chr(10) ||
    'ধাপ ৩: ব্যক্তির স্পষ্ট ছবি আপলোড করুন।' || chr(10) ||
    'ধাপ ৪: "যাচাই করুন" চাপুন — ছবির সঙ্গে QR-এর মালিক মিললেই যাচাই সফল।' || chr(10) ||
    'নোট: শুধুমাত্র যাচাই সফল হলেই ওয়ালেট থেকে চার্জ কাটবে — ব্যর্থ যাচাইয়ে কোনো চার্জ নেই। রসিদটি ইতিহাসে (History) সংরক্ষিত থাকবে।',
    'qr-photo-verify',
    'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'qr-photo-verify');
