-- 048: Mouza map service (engine: land-mouza-map, SEPARATE
-- engine from land-khatian — Pankaj, 2026-11-04: its own
-- page, its own services row, its own fee; never a button
-- inside the khatian page).
--
-- Reads the DLRMS public guest channel (engines/land-core/
-- client.js, proven live 2026-11-04): map JL list per survey
-- (/public/map-mouzas/jl-numbers — a SEPARATE list from the
-- khatian JL list, matched on MOUZA_ID) → sheet list
-- (/public/maps?JL_NUMBER_ID=) → preview PNG per sheet
-- (/public/maps/image-view-file/{id}).
--
-- The preview images are the portal's own free search-card
-- images — NOT the certified sheet (that stays a paid cart
-- order, govt fee ৳545/sheet, and is NOT built here). The
-- page says so plainly. The sheet list carries NO dag
-- membership — a customer picks by sheet number, not by dag.
--
-- Wallet is charged ONLY when at least one sheet is found;
-- "not found" is a ৳0 failed order with a receipt. Preview
-- PNGs are served only against the completed order that the
-- search created (order_id + sheet id must match).
--
-- PRICE IS DELIBERATELY 0: Pankaj sets the fee himself in
-- Admin → Services (a separate fee row exists from this
-- migration; the amount is his decision, never baked in).
-- Serial 12 = next free number after 046 (11).
-- Idempotent: only inserts when no service with this
-- engine_id exists.

INSERT INTO services (name, name_bn, type, price, serial, documents_required, fields_required, schedule, rules_text, engine_id, status)
SELECT
    'Land Mouza Map (Preview)', 'মৌজা ম্যাপ', 'automated', 0, 12,
    '[]'::jsonb, '[]'::jsonb, '{}'::jsonb,
    'ধাপ ১: বিভাগ, জেলা, উপজেলা, জরিপ ও মৌজা বেছে নিন (এলাকার তালিকা সরকারি পোর্টাল থেকে সরাসরি আসে)।' || chr(10) ||
    'ধাপ ২: "ম্যাপ খুঁজুন" চাপুন — ওই মৌজার শিটের তালিকা ও প্রিভিউ ছবি দেখতে পাবেন, শিট নম্বর ধরে ছবি ডাউনলোড করতে পারবেন।' || chr(10) ||
    'নোট: অন্তত একটি শিট পেলেই শুধু চার্জ কাটবে — না পেলে ৳০।' || chr(10) ||
    'সীমা: এই ছবিগুলো প্রিভিউ মাত্র — এগুলো সরকারি সার্টিফাইড মৌজা শিট নয়, মালিকানা/স্বত্ব/দখলের প্রমাণ নয়। সার্টিফাইড শিট আলাদা অর্ডার। কোন শিটে কোন দাগ আছে, সেটা পোর্টাল দেয় না — শিট নম্বর দেখে বাছতে হবে।',
    'land-mouza-map', 'active'
WHERE NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'land-mouza-map');
