-- 043: Mouza report — rate follows the selected unit.
-- The mouza calculator changed so the entered rate means "per selected
-- unit" (shatangsho/katha/bigha/gonda), not always per shatangsho.
-- The seeded rules text from 042 still said "প্রতি শতাংশ", which would
-- now mislead shopkeepers, so update that step in place. Idempotent:
-- only touches the land-mouza-value service row, if present.
UPDATE services
SET rules_text =
    'ধাপ ১: বিভাগ, জেলা, উপজেলা ও মৌজা বেছে নিন।' || chr(10) ||
    'ধাপ ২: প্রতিটি লাইনে জমির শ্রেণি, নির্বাচিত এককপ্রতি হার ও পরিমাণ বসান — হার সবসময় বাছা এককের হিসাবে (শতাংশ/কাঠা/বিঘা/গন্ডা); শতাংশ রূপান্তর শুধু দেখানোর জন্য।' || chr(10) ||
    'ধাপ ৩: "রিপোর্ট তৈরি করুন" চাপুন — মোট সর্বনিম্ন মূল্য, শ্রেণিভিত্তিক ভাগ ও দলিলের ভিত্তিসহ পরিষ্কার রিপোর্ট (PDF) পাবেন।' || chr(10) ||
    'নোট: বৈধ রিপোর্ট হলেই শুধু চার্জ কাটবে — ভুল ইনপুটে ৳০। এই রিপোর্ট সার্টিফাইড কপি নয়, মালিকানা/স্বত্ব/দখলের প্রমাণ নয়, বাজারমূল্য নয়, চূড়ান্ত দলিল বিল নয়। দলিলের আগে সাব-রেজিস্ট্রার অফিসে হার ও তালিকার সংস্করণ মিলিয়ে নিন।'
WHERE engine_id = 'land-mouza-value';
