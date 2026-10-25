# BDRIS HTTP-first client — design note (first version, partial)

Status: **PARTIAL, NOT COMPLETE.** This module covers the verified HTTP
steps (session, geo, documents, OTP send). It does **not** cover OTP
verify or final submit, because their request shapes are still unobserved
(see below). Until those are observed, the current Playwright v2 path
remains the fallback for exactly those two steps.

## Hybrid fallback, in words

```
User flow
   │
   ├─ Geo cascade ───────────────► HTTP client (this module)
   │   division → district → zone → ward, via targetGeoOrder
   ├─ Document upload (40, 41) ──► HTTP client (this module)
   ├─ OTP send ───────────────────► HTTP client (this module)
   ├─ OTP verify ─────────────────► Playwright v2 (fallback, NOT here)
   │   reason: /api/otp/verify params unobserved
   └─ Final submit ───────────────► Playwright v2 (fallback, NOT here)
       reason: /api/br/application/register method + payload unobserved
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
| **Submit method + payload field list** | **UNOBSERVED — DO NOT GUESS** | `submitApplication()` throws `NOT_IMPLEMENTED_SUBMIT_PAYLOAD` |
| **OTP verify request params (+ method)** | **UNOBSERVED — DO NOT GUESS** | `verifyOtp()` throws `NOT_IMPLEMENTED_VERIFY_PARAMS` |
| **First-parent source** (observed chains start at parent 4; page script shows `bangladeshId=null`) | **UNPROVEN** | `walkGeoChain()` requires explicit `firstParentId`; `4` is not hardcoded as a fact |
| Office lookup query/payload shapes | UNVERIFIED | helpers take caller-supplied params verbatim and return JSON as-is |
| Success-page application-number format | UNVERIFIED | `parseSuccessPage()` checks only the phrase + print link |

## What is needed to finish (in order)

1. Submit: the request method and payload field **names** for
   `/api/br/application/register` (names only — no values, cookies,
   tokens, or personal data).
2. Verify: the request method and parameter **names** for
   `/api/otp/verify` (same rule: names only).
3. First-parent source: where the chain's first `parentGeoId` comes
   from (page script, first geo call, or a fixed bootstrap value —
   whichever is actually observed, not assumed).
4. Only then: implement `verifyOtp()` and `submitApplication()` in
   `client.js`, add mock-server tests for both against the observed
   shapes, and re-check the hybrid diagram above. Until step 1–2 land,
   do not describe this HTTP path as complete, and do not remove the
   Playwright fallback.

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
