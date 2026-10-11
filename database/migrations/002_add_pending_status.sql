-- Migration 002: allow 'pending' user status (registration flow)
-- New users register as 'pending' until email verified / admin activates.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
    CHECK (status IN ('active','disabled','blocked','pending'));
