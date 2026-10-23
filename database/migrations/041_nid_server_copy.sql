-- 041: NID Server Copy automated service (engine: nid-server-copy)
-- A completely separate engine from nid-replica: the customer logs
-- in with their OWN NID portal (services.nidw.gov.bd/nid-pub) ID +
-- password, solves the portal's image captcha through a relay, and
-- the engine collects the profile + photo (plus the official
-- download when the account has one) and produces the NID card PDF
-- with the same output logic as the NID card engine. The portal
-- password is never stored. Wallet is charged ONLY after the card
-- PDF has been built. Price below is the starting default set by
-- the owner — admin edits it in Admin → Services.
-- Idempotent: only inserts when no service with this engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'NID Server Copy', 'এনআইডি সার্ভার কপি', 'automated', 150, 9,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: আপনার NID পোর্টালের (services.nidw.gov.bd) আইডি ও পাসওয়ার্ড দিন — পাসওয়ার্ড আমাদের সার্ভারে সংরক্ষণ করা হয় না।' || chr(10) ||
    'ধাপ ২: পোর্টালের ছবির ক্যাপচাটি দেখে হুবহু লিখুন।' || chr(10) ||
    'ধাপ ৩: "কার্ড তৈরি করুন" চাপুন — আপনার প্রোফাইলের তথ্য ও ছবি দিয়ে NID কার্ড (PDF) তৈরি হয়ে যাবে।' || chr(10) ||
    'নোট: কার্ড তৈরি সফল হলেই শুধু চার্জ কাটবে — ব্যর্থ হলে ৳০। ২০১৯ সালের আগের NID-সহ সব সালের কার্ডেই এই সেবা কাজ করে।',
    'nid-server-copy', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'nid-server-copy');
