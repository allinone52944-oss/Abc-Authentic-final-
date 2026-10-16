-- Migration 028: Add user-defined order statuses
-- User spec (2026-10-16): waiting, received, registered
-- Safe: keeps all existing statuses, only ADDS new ones

DO $$ DECLARE
  c RECORD;
BEGIN
  -- Drop ANY check constraint on orders.status (whatever its name)
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'orders'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE 'ALTER TABLE orders DROP CONSTRAINT ' || quote_ident(c.conname);
  END LOOP;
END $$;

-- Add unified constraint with all statuses (old + new)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check'
  ) THEN
    ALTER TABLE orders ADD CONSTRAINT orders_status_check
      CHECK (status IN (
        'new', 'pending', 'waiting',
        'received', 'processing', 'registered',
        'completed', 'delivered',
        'failed', 'cancelled', 'refunded'
      ));
  END IF;
END $$;
