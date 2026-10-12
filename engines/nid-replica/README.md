# NID Replica Engine (as-is)

**Do NOT modify the Python files.** This folder is a byte-identical copy of
`NID-Engine-Fixed.zip` (minus `input.pdf` sample with PII, Windows `*.bat`
files, and `dlls/`). The adapter `adapter.js` only *wraps* the engine.

## Engine flow (unchanged)

1. `python3 extract_input.py input.pdf` → `work/input_data.json` + `work/images/`
2. `python3 extract_template.py output_template.pdf` → `work/template.json`
3. `python3 make_fields.py` → `work/fields.json` (user-editable)
4. `python3 build_output.py` → `work/output.pdf` (final NID card replica)

All scripts use relative `work/` paths; the adapter runs each with a
per-job CWD (`work/jobs/<uuid>/`), so concurrent users are isolated.
Fonts resolve from this folder (`fonts/`) via the engine's own `_HERE`;
the template PDF resolves via `output_template.pdf` in this folder.

## VM setup (one-time)

```bash
pip3 install pymupdf Pillow pdf417gen
# ddddocr is optional (scanned-PDF OCR fallback only)
```

## Backend mount

`POST /api/nid-engine/extract` (multipart `pdf`) → `{ jobId, fields, images }`
`POST /api/nid-engine/build` (`{ jobId, fields }`) → `application/pdf`

Both require JWT auth and are rate-limited (30/min). Python stderr is
never returned to the client.
