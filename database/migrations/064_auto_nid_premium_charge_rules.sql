-- Adjust the seeded wording without replacing admin-authored rules.
UPDATE services
SET rules_text = CASE engine_id
  WHEN 'nid-auto-server-copy-premium' THEN
    'নিজের বা যার তথ্য ব্যবহারের অনুমতি রয়েছে, তার NID নম্বর ও জন্মতারিখ দিন। মিল থাকা তথ্য এলে বা যাচাইয়ের ফি কাটা নিশ্চিত হলে Premium রেট কাটবে। ঠিকানা আংশিক হতে পারে।'
  ELSE
    'নিজের বা যার তথ্য ব্যবহারের অনুমতি রয়েছে, তার NID নম্বর ও জন্মতারিখ দিন। তিন ধরনের রিপোর্ট থেকে একটি বেছে নিন। Premium-এ মিল থাকা তথ্য এলে বা যাচাইয়ের ফি কাটা নিশ্চিত হলে চার্জ কাটবে। Backup ও Half-এ PDF প্রস্তুত হলে চার্জ কাটবে।'
END
WHERE engine_id IN ('nid-auto-server-copy', 'nid-auto-server-copy-premium')
  AND rules_text = 'নিজের বা যার তথ্য ব্যবহারের অনুমতি রয়েছে, তার NID নম্বর ও জন্মতারিখ দিন। তিন ধরনের রিপোর্ট থেকে একটি বেছে নিন। PDF প্রস্তুত হলেই নির্বাচিত সেবার মূল্য কাটা হবে।';
