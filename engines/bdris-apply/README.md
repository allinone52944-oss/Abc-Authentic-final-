# BDRIS Apply Engine (as-is)

As-is copy of `Bdris-apply-v2-CLEAN-v23.zip` (BDRIS Auto-fill Bot v6).
**Do not modify engine logic here.** Integration-only changes live in:
- `index.js` (subprocess adapter, no logic changes)
- `../../backend/routes/bdris-apply.js` (wallet charging)
- `../../frontend/bdris-apply.html` (copied frontend + charge shim)

## VM setup (one-time)

```bash
cd /opt/all-in-one-abc-authentic/engines/bdris-apply
npm install
# Playwright downloads Chromium (~170MB) on first run automatically
```

## Pricing (both admin-configurable)

- **Submit charge**: Admin → Services → "বিডিআরআইএস আবেদন" → price.
  Deducted via `POST /api/bdris-apply/charge/submit` before `SUBMIT_S4_OTP`.
- **PDF download charge**: Admin → Settings → "BDRIS আবেদন PDF ডাউনলোড চার্জ (৳)".
  Stored in settings key `bdris_apply.pdf_price` (default 0).
  Deducted via `POST /api/bdris-apply/charge/pdf` before `FETCH_ORIGINAL`.

Both return 402 `INSUFFICIENT_BALANCE` (Bengali message) when short.
