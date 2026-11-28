UPDATE services
SET fields_required = CASE WHEN fields_required = '["TIN নম্বর"]'::jsonb
                           THEN '["১০ সংখ্যার NID বা ১২ সংখ্যার TIN"]'::jsonb
                           ELSE fields_required END,
    rules_text = CASE WHEN rules_text = 'নিজের বা অনুমতিপ্রাপ্ত ১২ সংখ্যার TIN নম্বর দিন। তথ্য মিললে বা তথ্যদাতার ফি কাটা নিশ্চিত হলে দেখানো চার্জ একবার কাটবে।'
                      THEN 'নিজের বা অনুমতিপ্রাপ্ত ১০ সংখ্যার NID বা ১২ সংখ্যার TIN নম্বর দিন। তথ্য মিললে বা তথ্যদাতার ফি কাটা নিশ্চিত হলে দেখানো চার্জ একবার কাটবে।'
                      ELSE rules_text END
WHERE engine_id = 'auto-tin'
  AND (fields_required = '["TIN নম্বর"]'::jsonb
       OR rules_text = 'নিজের বা অনুমতিপ্রাপ্ত ১২ সংখ্যার TIN নম্বর দিন। তথ্য মিললে বা তথ্যদাতার ফি কাটা নিশ্চিত হলে দেখানো চার্জ একবার কাটবে।');
