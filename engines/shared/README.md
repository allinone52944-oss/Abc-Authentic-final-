# Shared helpers (senior design)

Engines stay separate. Birth and death keep their own server, ports,
API paths, field mapping and certificate HTML. Only data-independent
helpers are shared, because they are byte-identical in both engines:

- `solve_local.py` — offline BDRIS captcha solver. It takes only a
  captcha image file and prints an answer. It does not know whether
  the captcha came from a birth or a death flow.
- `templates.json` — the captcha glyph bank used by `solve_local.py`
  (120 glyphs, 32x32 each). It is not the certificate layout and it
  does not contain birth or death record data. The bank is already
  full at 120 entries, so the solver's harvest step returns early
  and does not write to this file.
- `cert-engine-standalone.js` — QR/barcode code engine. It takes
  only a certificate number and an optional official URL, and
  returns key, code, QR and barcode. It does not know birth from
  death.

Safety rules that keep logic unchanged:

- Each engine resolves the shared solver with a fallback: if
  `../shared/solve_local.py` is missing, it uses its own local
  copy path, exactly as before. Death's cert engine does the same
  with a try/catch require.
- No QR logic, no port, no API path, no BDRIS field mapping and
  no certificate HTML was changed in this branch.
- If a shared helper ever needs birth-only or death-only logic,
  do not edit it in place for one engine. Add a parameter to it
  and keep both engines tested, or split that part out. Never
  silently change shared behaviour for one engine.
