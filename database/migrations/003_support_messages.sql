-- 003: Order support messages (admin -> user one-way status/support updates)
CREATE TABLE IF NOT EXISTS order_support_messages (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    template_key VARCHAR(40),
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_support_msg_order ON order_support_messages(order_id, created_at DESC);
