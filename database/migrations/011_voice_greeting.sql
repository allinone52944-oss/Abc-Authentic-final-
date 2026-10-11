-- 011_voice_greeting.sql
-- Religion-based voice greeting config (admin-editable)
-- greetings.other = "" means fall back to time-based greeting (সুপ্রভাত/শুভ দুপুর/...)
INSERT INTO settings (key, value) VALUES
    ('voice_greeting', '{"enabled": true, "rotation": true, "greetings": {"islam": "আসসালামু আলাইকুম", "hindu": "নমস্কার", "buddhist": "নমো বুদ্ধায়", "christian": "প্রভুর শান্তি", "other": ""}}')
ON CONFLICT (key) DO NOTHING;
