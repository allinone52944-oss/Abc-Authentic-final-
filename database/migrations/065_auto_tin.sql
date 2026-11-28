-- Admin sets the customer price and enables this service after reviewing the setup.
INSERT INTO services (name, name_bn, type, price, serial, fields_required, rules_text, engine_id, status)
SELECT 'Auto TIN Verification', 'অটো TIN যাচাই', 'automated', 0, 21,
       '["TIN নম্বর"]'::jsonb,
       'নিজের বা অনুমতিপ্রাপ্ত ১২ সংখ্যার TIN নম্বর দিন। তথ্য মিললে বা তথ্যদাতার ফি কাটা নিশ্চিত হলে দেখানো চার্জ একবার কাটবে।',
       'auto-tin', 'disabled'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'auto-tin');
