-- Migration 030: Banner animation control (user spec 2026-10-16)
-- Admin controls animation type and speed

ALTER TABLE banners ADD COLUMN IF NOT EXISTS animation_type VARCHAR(30) NOT NULL DEFAULT 'slide'
  CHECK (animation_type IN ('slide', 'fade', 'ticker', 'bounce', 'none'));
ALTER TABLE banners ADD COLUMN IF NOT EXISTS animation_speed INT NOT NULL DEFAULT 30
  CHECK (animation_speed BETWEEN 5 AND 120);

COMMENT ON COLUMN banners.animation_type IS 'slide=ticker-মতো যাবে, fade=আস্তে বদলাবে, ticker=news ticker, bounce=নড়াচড়া, none=স্থির';
COMMENT ON COLUMN banners.animation_speed IS 'সেকেন্ডে কতটুকু (৫-১২০, বেশি=দ্রুত)';
