CREATE TABLE IF NOT EXISTS auto_nid_reports (
    order_id UUID PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
    request_hash CHAR(64) NOT NULL,
    filename TEXT NOT NULL,
    encrypted_pdf BYTEA NOT NULL
);

-- Enable the engine and set the three customer prices in Admin after adding server credentials.
WITH products (engine_id, name, name_bn, serial) AS (
    VALUES
      ('nid-auto-server-copy', 'Auto NID Server Copy', 'অটো NID সার্ভার কপি', 18),
      ('nid-auto-server-copy-premium', 'Auto NID Server Copy — SV Copy Premium', 'অটো NID সার্ভার কপি · প্রিমিয়াম', 19),
      ('nid-auto-server-copy-half', 'Auto NID Server Copy — Half Server Copy', 'অটো NID সার্ভার কপি · হাফ', 20)
)
INSERT INTO services (name, name_bn, category_id, type, price, serial, rules_text, engine_id, status)
SELECT name, name_bn,
    (SELECT category_id FROM services WHERE engine_id = 'nid-server-copy' ORDER BY serial, created_at LIMIT 1),
    'automated', 0, serial,
    'নিজের বা যার তথ্য ব্যবহারের অনুমতি রয়েছে, তার NID নম্বর ও জন্মতারিখ দিন। তিন ধরনের রিপোর্ট থেকে একটি বেছে নিন। PDF প্রস্তুত হলেই নির্বাচিত সেবার মূল্য কাটা হবে।',
    engine_id, 'disabled'
FROM products p
WHERE NOT EXISTS (SELECT 1 FROM services s WHERE s.engine_id = p.engine_id);
