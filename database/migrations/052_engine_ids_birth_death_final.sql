-- Audit #14 — gate IDs renamed to directory names, in the SAME
-- change as the code rename (else the price lookup breaks and the
-- services run free — the item-17 trap):
--   bdris-certificate -> birth-final   (engines/birth-final)
--   death-verify      -> death-final   (engines/death-final)
-- Both the services rows (price lookup keys on engine_id) and the
-- engine_jobs rows (history labels key on engine_id) are renamed.
-- Guarded: if a target row already exists (e.g. an admin created
-- one by hand), the old row is left alone instead of creating a
-- duplicate engine_id — the admin merges it by hand in that case.
-- Idempotent: re-running matches zero rows.
UPDATE services SET engine_id = 'birth-final'
 WHERE engine_id = 'bdris-certificate'
   AND NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'birth-final');
UPDATE services SET engine_id = 'death-final'
 WHERE engine_id = 'death-verify'
   AND NOT EXISTS (SELECT 1 FROM services WHERE engine_id = 'death-final');
-- engine_jobs rows carry no unique key on engine_id (the unique
-- key is user_id + idempotency_key), so a plain rename is safe.
UPDATE engine_jobs SET engine_id = 'birth-final'
 WHERE engine_id = 'bdris-certificate';
UPDATE engine_jobs SET engine_id = 'death-final'
 WHERE engine_id = 'death-verify';
