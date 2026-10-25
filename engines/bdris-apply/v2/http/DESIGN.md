# BDRIS HTTP-first client — design note (first version, partial)

Status: **CANDIDATE-COMPLETE, NOT LIVE-VERIFIED.** This module covers
the verified HTTP steps (session, geo, documents, OTP send) plus
**candidate** implementations of OTP verify and final submit
(`buildVerifyPayload()` / `buildSubmitPayload()` in `client.js`).
Candidate = derived from the Playwright v2 StepHandler field map, not
from a live capture of the two requests. Until one live capture
confirms the real method + field list, the Playwright v2 path (page
pool, live-verified ~5s session-ready) remains the LIVE path, and
this HTTP path is OPT-IN ONLY (env `BDRIS_HTTP_PATH=on`; default
OFF, safe-by-default, senior decision 2026-10-25) — it must not be
called realtime in production.

## Hybrid fallback, in words

```
User flow
   │
   ├─ Geo cascade ───────────────► HTTP client (this module)
   │   division → district → zone → ward, via targetGeoOrder
   ├─ Document upload (40, 41) ──► HTTP client (this module)
   ├─ OTP send ───────────────────► HTTP client (this module)
   ├─ OTP verify ─────────────────► HTTP client, CANDIDATE (POST, otpSend
   │   context + otp; see buildVerifyPayload) — Playwright v2 fallback
   │   if the live server rejects the candidate
   └─ Final submit ───────────────► HTTP client, CANDIDATE (POST, flat
       StepHandler field names + upload refs 40/41; see
       buildSubmitPayload) — Playwright v2 fallback if rejected live
       outcome: success page (phrase + print link, see client.js)
```

Office registration is out of scope entirely: it does not happen
immediately after submit (user, 2026-10-25), and this engine is needed
only up to a successful SUBMIT (success page).

## Session model (verified)

1. `GET /br/application` first (public, no login). Parse
   `meta name="_csrf"` (token) and `meta name="_csrf_headerName"`.
2. Keep a live cookie jar. Update it from **every** `Set-Cookie`
   response: the server rotates TS cookies, one with ~30s `Max-Age`.
   Never hardcode a cookie or a token; never reuse a captured session.
3. Every API call sends: session cookies, the CSRF header (meta header
   name, default `X-CSRF-TOKEN`), `x-requested-with: XMLHttpRequest`,
   `Referer: https://bdris.gov.bd/br/application`, `client: bris`.

## Verified vs unverified

| Item | State | Source / note |
|---|---|---|
| Base + form page, public, no login | VERIFIED | live form page |
| Session bootstrap via form-page meta CSRF | VERIFIED | form page + `js/util.js` |
| Required headers (cookies, CSRF, XHR, referer, `client: bris`) | VERIFIED | curl capture, header names only |
| Cookie rotation via Set-Cookie | VERIFIED | capture (one cookie ~30s Max-Age) |
| Geo endpoint + query params (`geoGroup=birthPlace`, `geoOrder`, `geoType`, `ward=true`) | VERIFIED | Network capture |
| Geo response shape (`geoGroup/geoOrder/geoType/targetGeoOrder/geoObject[]`) | VERIFIED | sanitised sample |
| Geo rules: match `nameBn`, next parent = chosen `id`, next order = `targetGeoOrder` (never order+1; zone branch jumps 3 → 5, ward call is order 5 / type 6 with `ward=true`) | VERIFIED | samples + chain |
| No hardcoded geo/ward/zone data, ever | RULE | standing user rule; cache holds live results only |
| Geo cache: 24h TTL, in-memory only, non-empty live results only (empty never cached) | VERIFIED RULE | same rule as existing `AddressService` |
| Upload endpoint, multipart fields (`attachmentType`, `attachmentSubType=-1`, `_csrf`, `files`), types 40/41 | VERIFIED | Network capture |
| Upload response shape (`files[0].url/id/attachmentTypeId`, `size: null`, `deleteType: DELETE`) | VERIFIED | samples for types 40 and 41 |
| Upload size limit ≤ 2MB, JPG/PNG | VERIFIED (caller contract) | existing engine rule |
| OTP send endpoint + param names (`appType`, `phone`, `email`, `officeId`, `personUbrn`, `relation`, `applicantName`, `applicantBrn`, `applicantDob`, `officeAddressType`) | VERIFIED | Network capture (names only) |
| OTP send response (`MESSAGE_SENT`, `success: true`, `payload: null` — no token/id) | VERIFIED | capture |
| Submit URL `/api/br/application/register` (+ `/api/application/receive` also present in page script) | URL VERIFIED | form page inline script |
| OTP verify URL `/api/otp/verify` (+ `/api/otp/sent-email` variant) | URL VERIFIED | form page inline script |
| Office lookup URLs (`/api/office/find-by-geo-id`, `/api/office/find-office-geo-projection-by-geo-id`) | URL ONLY VERIFIED | form page inline script |
| Success page shape (phrase, application number, office, masked mobile, print link `/admin/br/application/print`, deadline date) | VERIFIED | success page |
| TSPD layer (`/TSPD/?type=…`, WebGL-shader fingerprint code) | VERIFIED AS BOT PROTECTION, NOT FORM LOGIC | challenge page + `fpdefs`; engine handles the session it establishes, never parses the obfuscated code |
| Submit method + payload field list | **CANDIDATE — DERIVED, NOT LIVE-CAPTURED** | `buildSubmitPayload()`: POST (candidate method) with flat StepHandler field names (`personInfoForBirth.*`, `birthPlace*`, `permAddr*`, `prsntAddr*`, `relationWithApplicant`, `applicantName`, `declaration`, `email`, `phone`, `otp`, `officeId`, `officeAddressType`) + upload refs 40/41. Missing required fields throw `MISSING_SUBMIT_FIELD` (never a silent guess). |
| OTP verify request params (+ method) | **CANDIDATE — DERIVED, NOT LIVE-CAPTURED** | `buildVerifyPayload()`: POST (candidate method) with the verified otpSend param names + `otp`. Missing/non-6-digit OTP throws `OTP_REQUIRED` / `OTP_BAD_FORMAT`. |
| Submit/verify transport (headers, cookies, CSRF) | VERIFIED (same as every other API call) | `apiHeaders()` — cookies, CSRF header, XHR, referer, `client: bris` |
| **First-parent source** (observed chains start at parent 4; page script shows `bangladeshId=null`) | **UNPROVEN** | `walkGeoChain()` requires explicit `firstParentId`; `4` is not hardcoded as a fact |
| Office lookup query/payload shapes | UNVERIFIED | helpers take caller-supplied params verbatim and return JSON as-is |
| Success-page application-number format | UNVERIFIED | `parseSuccessPage()` checks only the phrase + print link |

## What is needed to finish (in order)

1. Live confirmation: the request method and payload field **names**
   for `/api/br/application/register` and the request method and
   parameter **names** for `/api/otp/verify`, from ONE live capture
   (names only — no values, cookies, tokens, or personal data).
   Compare them field by field with `buildSubmitPayload()` /
   `buildVerifyPayload()`; correct any mismatch, re-run the mock
   tests, and only then drop the CANDIDATE label for the confirmed
   fields.
2. First-parent source: where the chain's first `parentGeoId` comes
   from (page script, first geo call, or a fixed bootstrap value —
   whichever is actually observed, not assumed).
3. Only then: frontend wiring for `SUBMIT_HTTP_CHAIN` (the engine
   integration already exists, but it has NO live caller yet — see
   below), deploy, and measure a real session end-to-end
   (bootstrap → geo → upload → OTP send → verify → submit) in
   seconds. Until steps 1 and 3 land, do not describe this HTTP
   path as complete or realtime, and do not remove the Playwright
   fallback.

## Engine integration (2026-10-25, uncommitted, NOT live-verified)

`v2/services/HttpPathRunner.js` + the `SUBMIT_HTTP_CHAIN` executor
command in `v2/server.js` wire this client into the engine as an
OPT-IN path only (env `BDRIS_HTTP_PATH`, default OFF since
2026-10-25, safe-by-default: `on`/`1`/`true`/`yes`/`enabled` enable
it; unset, empty, `off`/`0`/`false`/`no`/`disabled`, or any other
value runs Playwright directly). Opt-in rationale: the submit/verify
payloads are candidate (derived, not live-captured), so an
unproven path must never become the live default by accident —
the proven Playwright pool path (live-verified ~5s session-ready)
stays the live path until a live capture confirms the candidates.
The runner accepts the
same combined draft the Playwright path receives (s1/s2/s2b/s3/
s4prep/otp/_chargeToken/docs) or the canonical shape, enforces the
SAME charge-token gate as Playwright submitS4 before any HTTP
attempt (a bad token blocks with no fallback, so payment can never
be bypassed), and falls back to the Playwright steps on any HTTP
failure, logging step + reason with the CANDIDATE label. One safety
exception: a submit with NO server response (outcome unknown) never
auto-retries via Playwright, to avoid a duplicate submission — it
returns SUBMIT_OUTCOME_UNKNOWN for a manual check. Frontend wiring
for `SUBMIT_HTTP_CHAIN` is STILL PENDING (frontend files untouched
here), so the live UI does not call this command yet — this
engine-default change alone changes NO live behaviour, because
there is no live caller for the command; the command is reachable
today only via ENGINE_COMMAND. Tests:
`v2/http/tests/http.test.js` (runner: success, geo-fallback,
gate-block, outcome-unknown, flag) and `v2/tests/unit.test.js`
(flag/label/normalizer). Nothing here was pushed, deployed, or
sent to live bdris.gov.bd.

## Probe vs execution contract (2026-10-25 fix — read before wiring)

What the disabled branch actually did before this fix (confirmed
from code, not assumed): when `BDRIS_HTTP_PATH` was not opted in,
`SUBMIT_HTTP_CHAIN` logged "running Playwright directly", AWAITED
the full Playwright chain (S0→S4, including submit) via the
session's page, and returned `{...playwrightResult,
httpPath:'disabled'}` — and threw if there was no browser session
at all. A frontend "probe, then run the old flow if disabled"
would therefore have double-executed Playwright. That behaviour
is gone, on purpose, and is a contract change: any caller that
relied on disabled-means-Playwright-runs must be updated.

- `HTTP_PATH_STATUS` (new, non-destructive probe): returns ONLY
  `{httpPath:'enabled'|'disabled', enabled, ready:true,
  candidate:true, candidateLabel}`. It never starts a session,
  sends OTP, uploads, submits, runs Playwright, logs, emits, or
  changes any state, and needs no session. `ready:true` means
  ONLY that the engine process answered the probe — not that
  bdris.gov.bd or a session is ready. Wiring rule: call the probe
  FIRST, with no `_commandId` (the executor caches by
  `_commandId`, so a reused id would return a stale status).
- `SUBMIT_HTTP_CHAIN` when disabled (default): returns
  `{ok:false, httpPath:'disabled', disabled:true,
  error:'HTTP_PATH_DISABLED', candidate:true, candidateLabel,
  message}` WITHOUT executing anything — no Playwright, no
  charge-gate check, no HTTP. The CALLER (the existing frontend
  Playwright flow) remains responsible for running Playwright
  itself. When enabled, behaviour is unchanged (full chain,
  charge gate first, fallback rules unchanged, candidate label
  unchanged).
- Still open (NOT implemented here, must not be guessed):
  (a) submit-only HTTP that reuses an already-sent OTP and
  already-uploaded docs instead of re-sending OTP; (b) an ack
  reference in the HTTP success result usable by `showDone()`;
  (c) live capture (names only) confirming the real submit
  method/field list and verify params; (d) first-parent source.

## Files

- `client.js` — `BdrisHttpClient`, `CookieJar`, `GeoCache`,
  `parseSuccessPage`. Node built-ins only, no new dependencies.
- `tests/http.test.js` — Node built-in test runner, local mock HTTP
  server only. No live `bdris.gov.bd` contact anywhere in tests.

## Run

From `~/workspace/abc-authentic-fixes`:

```
node --test engines/bdris-apply/v2/http/tests/http.test.js
```

(Note: the directory form `node --test …/http/tests/` does not resolve
in this Node v24.22.1 build — it errors MODULE_NOT_FOUND on the
directory itself. The explicit file form above is the verified command.)
