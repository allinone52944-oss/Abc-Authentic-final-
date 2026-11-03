# land-khatian — খতিয়ান অনুসন্ধান (SPEC Phase 1: login-free search + summary only)

## Source

DLRMS public channel only, through `engines/land-core/client.js`
(guest cookies, no citizen/office login). This adapter wraps that
client — it implements no HTTP/token logic of its own.

## What it does

`adapter.search()` finds khatian records for one mouza:

- by **khatian number** — server-side `KHATIAN_NO` filter, then
  `detail` for each hit;
- by **owner name and/or dag number** — whole-mouza `indexList`,
  filtered **locally** (`ownerMatches` for names — the portal
  ignores `OWNER_NAME` server-side; `DAGS` contains for dags,
  applied on the detail record);
- across surveys: `surveyId` = one numeric survey id, `'all'`
  (every survey the portal offers in the upazila), or
  `'mutation'` (see below).

Survey keys come **only** from the portal's `surveys` /
`upazilaSurveys` lists — nothing is hardcoded here. A
client-supplied `jlId` is validated against the realtime
`jlNumbers` list for that area + survey, never trusted blindly.
Detail fetches are capped at 50; when candidates exceed the cap
the result reports `totalCandidates` + `capped: true`.

Hal-sabek is **best-effort only** via `client.halSabek`: failure
or an empty list still returns the summary.

## Mutation — conditional / unproven

`surveyId: 'mutation'` is a passthrough attempt with index key
`MUTATION` against the same JL entries the offered surveys
resolve. DLRMS re-verification (2026-11-03) found the key
accepted (HTTP 200) but returning **0 items** for the Mirpur
sample, with and without `KHATIAN_NO=8`; keys `NAMJARI`,
`MUTATION_SURVEY`, `HAL_SABEK` return 400 `Survey Is Not
Valid`, and `jl-numbers` rows carry `MUTATION_SURVEY_ID =
null`. So: an empty mutation result means **not-found, no
charge** — never a claim that mutation lookup works. Do not
hardcode a mutation JL mapping.

## Charge rule (route `backend/routes/land-khatian.js`)

Charge **only when ≥ 1 record is found** (services-table price
+ per-user override; insufficient balance → 402, no record
leaked). Not-found records a ৳0 failed order with a receipt.
Same `idempotency_key` replays the stored outcome, never a
second charge. The summary PDF is stored on the order and
delivered through History (`/api/orders/:id/documents/:fn`),
exactly like `/api/land`.

## Customer PDF limits

The summary PDF (`backend/lib/khatianSummaryPdf.js`) carries
**no watermark, no source site name/link/branding**, and states
plainly in Bengali that it is a **summary, NOT a certified
copy**, NOT ownership/title/possession proof, and must be
verified at the government portal if needed for official work.

## Collection store (fallback, not primary)

Live DLRMS is always tried first; the store is consulted
only when live fails. Production Postgres holds only the
index/metadata table `land_khatian_index` (migration 047) —
bulk records live in a **separate store** reached via
`backend/lib/khatianStore.js` (HTTP remote when
`LAND_KHATIAN_STORE_URL` is set, ephemeral local file store
otherwise). The separate store server also has a
PostgreSQL backend (`STORE_BACKEND=postgres`, separate
database only — never production) and a no-rebuild
transfer procedure (dump/restore + URL change), both
documented in **`STORE.md**`. A store hit is delivered with stale flags in
the response, the PDF, and a page banner — and charged
exactly like a normal found result (Pankaj may overrule
that to free; see `STORE.md`). Admin batch import
(`POST /api/land-khatian/admin/import`: one survey, up to
5 mouzas / 3000 records per call, cursor continuation) and
coverage (`GET /api/land-khatian/admin/coverage`: imported
pairs vs the portal's own lists, percent unavailable —
never invented — when the portal is unreachable) are
documented in full in **`STORE.md`**, including hosting
options and the provision-before-collection warning. The
"server keeps running if the source goes off" goal holds
only for data already collected — never claimed for
uncollected areas. **Raw-verbatim collection rule (Pankaj,
2026-11-03):** source records are stored EXACTLY as the
source returns them — `rawIndex` + `rawDetail` + verbatim
hal-sabek rows + separate collection metadata — and
presentation mapping runs only at delivery time
(`storeMapping.js`); full rule, enforcement points, and
tests in **`STORE.md`**. Import never renames, drops, or
reformats a source field.

## What is NOT built

No login, no payment step, no cart, no certified-copy or
mutation application, no geo cascade duplication (the frontend
uses the existing `/api/land/geo/*` endpoints), no eporcha.tech
in any form.

## Still unproven

- A populated hal-sabek response (sample returned 200 + empty).
- Mutation lookup returning a real record anywhere.
- Live portal behaviour on the day of any future deploy
  (re-verified 2026-11-03; the portal can change).
- Upazila nuance for the frontend: the upazilas endpoint mixes
  revenue circles (`IS_CIRCLE=1`) and real upazilas
  (`IS_CIRCLE=0`); e.g. Mirpur must be addressed as
  `UPAZILA_BBS_CODE` 48 (Mirpur Revenue Circle). Nothing here
  filters circles out.
