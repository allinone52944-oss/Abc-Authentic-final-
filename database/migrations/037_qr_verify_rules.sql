-- 037: QR + Photo verification form is now just QR image + photo —
-- the NID/ID (subject_ref) field was removed at the owner's request
-- (2026-10-21: "just qr -r photo dilei hobe"). Refresh the seeded
-- how-it-works text so the service page matches the actual form.
-- Idempotent: a plain UPDATE keyed by engine_id.
UPDATE services SET rules_text =
    'ধাপ ১: যার যাচাই করবেন তার NID-এর QR কোডের ছবি আপলোড করুন (প্রতিটি QR মাত্র একবার ব্যবহারযোগ্য)।' || chr(10) ||
    'ধাপ ২: ব্যক্তির স্পষ্ট ছবি আপলোড করুন।' || chr(10) ||
    'ধাপ ৩: "যাচাই করুন" চাপুন — ছবির সঙ্গে QR-এর মালিক মিললেই যাচাই সফল।' || chr(10) ||
    'নোট: শুধুমাত্র যাচাই সফল হলেই ওয়ালেট থেকে চার্জ কাটবে — ব্যর্থ যাচাইয়ে কোনো চার্জ নেই। রসিদটি ইতিহাসে (History) সংরক্ষিত থাকবে।'
WHERE engine_id = 'qr-photo-verify';
