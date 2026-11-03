# land-khatian — collection store (fallback, not primary)

## The goal, stated honestly

**"Our server keeps running even if the source goes off" is a
goal reached only when collection finishes — NOT a day-one
guarantee.** Until a mouza/survey pair has actually been
collected (by a live search, or by a batch import), there is
nothing stored for it, and a portal outage means that mouza
honestly reports "not collected yet". Nothing is ever
fabricated, and all-BD offline availability must never be
claimed before import coverage reaches it. The coverage
endpoint (below) is the honest measure of how far along that
goal is.

**Launch gate:** partial coverage is only a collection
phase, never the marketed product — a server running with
little data is the same as not running, as a service. The
offline/store service may be marketed or sold as all-BD
ONLY when coverage is 100%, OR with an explicitly
published district list — until then partial coverage is
collection phase only, not the product. Uncovered areas
must never be presented as available. This gate is a
product decision for Pankaj to enforce at launch; the
code's job is to make the coverage numbers impossible to
fudge (portal-derived denominator, percent unavailable
rather than invented, partial units never counted as
complete).

## Inventory first: what may be collected, in serial order

Collection order is governed by
`~/workspace/land-service/khatian-collection-inventory.md`
and is exactly this serial order — no new collection target
beyond this list:

**1. Cascade → 2. index list → 3. detail → 4. hal-sabek
(if present) → 5. map/PDF (ONLY after live proof — NOT in
this build).**

Per-step reconciliation applies at every serial step
(source count first, then collected count, mismatch flagged
open — see "Reconciliation" below).

### Field verification table (DLRMS re-verification 2026-11-03 + SPEC)

| Field / step | Status | Evidence |
|---|---|---|
| Cascade: divisions → districts → upazilas → mouzas/JL per survey, incl. the 8-survey list endpoint and SURVEY_ID filtering | PROVEN — collect | All HTTP 200 on 2026-11-03 re-verification |
| Index list per mouza: ID, KHATIAN_NO, OWNERS, NON_DELIVERABLE_MESSAGE_IDS | PROVEN — collect | 584 items for the Mirpur RS sample, 2026-11-03 |
| Detail per khatian: DAGS, TOTAL_LAND, KHATIAN_ENTRY_ID, area names | PROVEN — collect | Sample khatian 8 verified 2026-11-03 (DAGS 1237, TOTAL_LAND 0.0544) |
| Search keys: KHATIAN_NO server-filter; OWNER_NAME portal-ignored (engine filters locally); dag via detail DAGS string (engine-side) | PROVEN — collect | KHATIAN_NO filter returned 1 item; bogus OWNER_NAME still returned the whole mouza list |
| Hal-sabek (correction history) | CONDITIONAL — best-effort only, never required for completeness | Endpoint + full parameter set proven, but the sample returns 200 + EMPTY; a populated hal-sabek response is UNPROVEN |
| eporcha.tech PDF download | CLAIMED BUT UNPROVEN — do NOT collect, do NOT implement | Page claim only, contents unseen (summary vs copy unknown); also third-party, so no importer for it in any case |
| Mouza map PDF | CLAIMED BUT UNPROVEN — do NOT collect, do NOT implement | Free-map claim unverified; SPEC records a ৳545/sheet government fee |
| Mutation detail | CLAIMED BUT UNPROVEN — conditional passthrough only, never claim it works | MUTATION key accepted (200) but 0 items for the sample; detail fields unseen |
| Full written khatian (all dag classes/shares, full page) | NOT ON PUBLIC PATH — EXCLUDED, never collect, never build | Office entry system, login-gated |
| Certified / online QR copy | NOT ON PUBLIC PATH — EXCLUDED, never collect, never build here | Citizen login + ৳120 + cart — separate Phase 2 work |
| Records claimed absent from official sources | NOT ON PUBLIC PATH — EXCLUDED | Still example-unproven (no verified mouza + khatian + survey example from Pankaj) |

Left OUT of this build, confirmed: map/PDF collection,
full-written-khatian collection, certified-copy collection,
and eporcha-PDF collection — none of them has code, an
endpoint, or a store write anywhere in this change.

## Architecture: live primary, store fallback, index vs bulk

```
Customer search
  → 1. Live DLRMS (always tried first)
  → 2. Live SUCCESS (even 0 items) = truth. Store never consulted.
  → 3. Live FAILURE (transport/API error, the 502 path) → store consulted
  → 4. Store hit → delivered with stale flags (response + PDF + banner)
  → 5. Store empty for that mouza → 502 + storeEmpty, honest message,
        never a definitive not-found
  → 6. Store itself unreachable → 502 as before
```

- **Live DLRMS is primary.** The store never shadows a live
  answer, and a live not-found (422, ৳0) never falls back to
  the store — a live 0 is truth, and serving older stored
  records over it would be a lie.
- **Store-down → live.** If the separate store is down, the
  engine still works via live DLRMS. The store is never a
  hard dependency.
- **Index vs bulk split.** Production Postgres
  (`abc_authentic_new`) holds ONLY the index/metadata table
  `land_khatian_index` (migration
  `database/migrations/047_land_khatian_index.sql`): which
  `(mouza, survey)` pairs are collected, their record counts,
  and first/last collected timestamps. **Bulk records NEVER
  go into production Postgres** — that is what keeps the live
  site free of bulk load. Bulk records live in the separate
  store, read/written via an HTTP API
  (`backend/lib/khatianStore.js`).

## RAW-VERBATIM COLLECTION RULE (Pankaj, 2026-11-03)

**Source records are stored EXACTLY as the source site
returns them. Arranging/presenting happens later, at
delivery — never at import.**

- **At import time, nothing is changed, arranged, or
  rewritten into a new format.** No field is renamed,
  dropped, or reformatted. The stored record is:
  - `rawIndex` — the exact portal index item JSON, untouched
    (including fields the old display mapping dropped, e.g.
    `KHATIAN_ENTRY_ID`, area names, non-deliverable flags);
  - `rawDetail` — the exact portal detail item JSON, untouched;
  - `halSabek` — the exact hal-sabek rows (verbatim; `[]`
    when none/failed, best-effort only);
  - `meta` — collection metadata ONLY, kept separately:
    `source` (`'dlrms'`), `collectedAt` (ISO), `jlId`,
    `surveyKey`, `surveyName`. Metadata never rewrites a
    source field, and unit scope (`jlId`/`surveyKey`) is also
    carried by the unit itself (file name, PG unit row, index
    row) and is authoritative for delivery mapping.
- **Presentation/summary mapping happens ONLY at delivery
  time**, in `store-server/storeMapping.js`
  (`mapStoredToDisplay`): `id` from `rawIndex.ID`,
  `khatianNo` from `rawDetail.KHATIAN_NO` (falling back to
  `rawIndex.KHATIAN_NO` when the detail value is null/empty),
  `owners`/`dags`/`totalLand` from the detail, `surveyKey`/
  `surveyName`/`jlId` from unit context. Delivery filters
  (khatian exact, owner substring, dag substring) run on the
  mapped display rows, with Bengali-digit normalisation on
  BOTH sides at filter time — the stored payload is never
  rewritten to make a filter match.
- **Where the rule is enforced:**
  - `engines/land-khatian/adapter.js` — live `search()`
    returns `rawItems` alongside display `items`; `importMouza()`
    returns raw stored records (its `indexItems` are
    reconciliation keys only, never stored).
  - `backend/routes/land-khatian.js` — `collectLiveResult`
    stores ONLY `result.rawItems` (grouped by `meta.jlId`/
    `meta.surveyKey`) and SKIPS collecting entirely when
    `rawItems` are absent, rather than storing display rows;
    the import route counts dags from `rawDetail.DAGS` and
    merge-prunes via a raw store search.
  - All three store implementations (app-side local store,
    store-server file backend, store-server PG backend) —
    upserts pass through `toStoredRecord` (raw payloads
    preserved exactly, non-payload keys dropped,
    `meta.collectedAt` stamped when missing); display search
    maps via `mapStoredToDisplay` then filters; raw search
    (`search(q, { raw: true })`, HTTP `raw=1`) returns stored
    records verbatim for the whole unit, with no mapping and
    no filters — it exists ONLY for the import merge-prune.
  - Dedupe/count key = `storedRecordId` = `String(rawIndex.ID)`
    (legacy display rows fall back to their own `id`).
- **Legacy rows:** display-shaped rows written before this
  rule (pre-rule test fixtures only — collection has NOT
  started, so no real records exist to migrate) pass through
  `toStoredRecord`/`mapStoredToDisplay` unchanged, so old
  reads keep working. NO new write may use the legacy shape.
- **Tests:** `backend/tests/lib/khatian-raw-rule.test.js`
  proves stored bytes deep-equal the source payload, delivery
  mapping equals the old normalize output for the same
  detail, and local/PG/HTTP round-trips in both modes.

## Stale-charge decision (Pankaj may overrule to free)

A stale (store) delivery is **charged exactly like a normal
found result**: same price from the services table, same
order, same PDF delivery, same idempotency. This matches the
shop's stored-data model (the mouza engine: stored data is a
delivered service, not a free preview). Staleness is never
hidden: it is visible in the API response (`source: 'store'`,
`stale: true`, `collectedAt`), in the PDF
("সংরক্ষিত তথ্য — শেষ আপডেট: … — লাইভ পোর্টাল থেকে যাচাই
করা হয়নি"), and in the frontend banner. **If Pankaj
decides stale deliveries should be free, that is a one-line
policy change in the route's `succeed()` path — it is NOT
silently free now, and staleness is NOT hidden.**

## Store client (`backend/lib/khatianStore.js`)

Chosen by env, no new dependencies:

- **HTTP remote** when `LAND_KHATIAN_STORE_URL` is set.
  Auth header `X-Store-Key` from `LAND_KHATIAN_STORE_KEY`
  only (never logged, never in the repo). 10 s timeout.
  Any failure becomes typed `STORE_UNREACHABLE`, never a raw
  error to the customer.
- **Local file store** when no URL is set: one JSON file per
  `(jl_id, survey_key)` under `LAND_KHATIAN_STORE_DIR`
  (default a tmp dir — NOT inside the repo). Ephemeral,
  local-dev only. Writes are atomic (tmp + rename).

Methods: `upsert({area, surveyKey, surveyName, jlId,
records, source: 'dlrms'})` (REPLACES the unit's record
set — callers that must not lose data read-merge-write
first; see below),
`search({jlId, surveyKey | 'all', khatianNo, ownerName,
dagNo}) → {records, collectedAt, totalMatches,
mouzaCollected}` (local filtering: khatian exact, owner
substring, dag substring on `DAGS`; `collectedAt` is the max
over returned records; `mouzaCollected` means a stored file
exists for the mouza/survey scope even if the filters
matched nothing),
`countForUnit({jlId, surveyKey}) → {count}` (distinct
stored records for one unit, counted from the store
itself — this is what the index row's `collected_count`
must always equal, never a running increment),
`ping()`.

Merge discipline: a live-search upsert passes `merge: true`
and the store merges by record id server-side — a live
search returns only the searched subset, and replacing the
unit with it would destroy a previously imported full unit.
Merging server-side also means the live path never CALLS
store.search: a live success never consults the store for
its answer. An import upsert merge-prunes: the route reads
the stored set, keeps rows still in the fresh index list,
overlays the run's collected rows, prunes rows the portal
no longer lists, and replaces the unit with that set.

The search accepts `jlId` OR `mouzaId` (`jlId` wins when
given) because the customer frontend sends `mouza_id` only.

## Reference store server (`store-server/`)

Zero-dependency Node HTTP server — what a second small
server runs. Full contract in `store-server/README.md`:

- `POST /v1/records/upsert` → `{upserted, updated}`
  (replaces the unit's record set)
- `GET /v1/records/count?jl_id=&survey_key=` → `{count}`
  (distinct stored records for one unit)
- `GET /v1/records/search?jl_id=&mouza_id=&survey_key=&khatian_no=&owner_name=&dag_no=`
  → `{records, collectedAt, totalMatches, mouzaCollected}`
- `GET /v1/health` → `{ok: true}`
- Optional API-key check when `STORE_API_KEY` is set
  (client sends it as `X-Store-Key`).

Run: `STORE_DATA_DIR=./data STORE_API_KEY=<secret>
PORT=3101 node engines/land-khatian/store-server/server.js`
(data dir is git-ignored; back it up like any data store —
losing it only loses the fallback copy).

## PostgreSQL backend for the separate store

The file backend above is the dev default. For a real
deployment the same store server runs against a **separate**
PostgreSQL database (see `store-server/pgStore.js` +
`store-server/README.md`):

- Select with `STORE_BACKEND=postgres` plus either
  `STORE_PG_CONNECTION_STRING` or the component form
  (`STORE_PG_HOST` / `STORE_PG_PORT` / `STORE_PG_DATABASE` /
  `STORE_PG_USER` / `STORE_PG_PASSWORD`, optional
  `STORE_PG_POOL_MAX`, `STORE_PG_SSL`). Values come from
  env only — never in code, logs, or docs.
- Schema (auto-created on first use, in the separate
  database only): `khatian_units` (one row per jl ×
  survey) + `khatian_records` (one row per stored record,
  keyed by jl × survey × record id). **Bulk records NEVER
  go into production Postgres** — the production database
  still holds only `land_khatian_index`.
- The HTTP contract is identical to the file backend, so
  the app-side client (`backend/lib/khatianStore.js`) needs
  no change: the app still talks HTTP to the store server,
  and the store server alone talks SQL to its database. A
  managed Postgres therefore needs **no API shim** — the
  store server connects to it directly.
- Interim form (Pankaj, 2026-11-03): a separate database
  on the existing Oracle server for now — never the
  production database, never a code file. The later move
  to a new Oracle account is the transfer below.

## Transfer to another Oracle account (no engine rebuild)

Goal: move the bulk store to a new Oracle account (for
example, in Pankaj's brother's name) later, without
rebuilding the engine. The engine is untouched throughout
— it talks to the store only over the HTTP contract, so
only the store's home and the app's store URL change:

1. **Provision** on the new account: a server (same region
   as the app server if possible) + a PostgreSQL database.
   Install the store server there (`npm install` in
   `store-server/`) and start it with
   `STORE_BACKEND=postgres` + the new database's env
   connection values + a `STORE_API_KEY`.
2. **Pause imports** during cutover (admin import calls),
   so no record lands in the old store mid-move.
3. **Dump the old store database** (schema + data) from
   the old store server, e.g. with `pg_dump` using the
   old connection env value, and copy the dump file to
   the new server over a secure channel.
4. **Restore** into the new database (e.g. `psql` with
   the new connection env value). The schema is the same
   (`khatian_units` + `khatian_records`), so a plain
   dump/restore works; no data conversion.
5. **Verify before switching:** per-unit counts from the
   new store (`/v1/records/count`) match the production
   index table's `collected_count` for spot-checked units,
   and the coverage endpoint output is unchanged (the
   index table itself never moves — it is metadata, not
   bulk data).
6. **Switch the app:** set `LAND_KHATIAN_STORE_URL` to
   the new store server's URL (and
   `LAND_KHATIAN_STORE_KEY` to match the new server's
   `STORE_API_KEY` if the key was rotated), then restart
   the app. Verify the new store answers
   `GET /v1/health` from the app server.
7. **Keep the old store running (read-only)** until the
   new one is verified in production, then decommission
   it. If verification fails, switch the URL back — the
   old store is untouched by the move.

No app code, no engine, and no index-table change is
needed at any step. The transfer moves bulk data only.

## Reconciliation (the unit rule — governs the importer)

Unit = ONE (mouza JL × survey). Per unit, in this exact
order:

1. **Fetch the FULL index list FIRST** and record the
   SOURCE count (`expected` = index items count) BEFORE
   loading any detail. Never mark anything complete without
   that source count beside the loaded count.
2. **Then fetch details** for each item; `collected` =
   details successfully stored. A detail failure does NOT
   abort the unit: the item lands in `failedDetails`
   (index id + khatian number + reason) and the unit goes
   partial.
3. **Dag totals** come from the collected details' DAGS
   strings only. Exact splitting method
   (`adapter.countDags`): Bengali digits → Latin, split on
   `,` or `;`, trim each token, drop empties; a token
   counts ONLY if it matches `/^\d+$/`. If any token in a
   record's DAGS string is unparseable, that record is
   flagged in issues (`DAGS_UNPARSEABLE`) and the unit goes
   partial — a dag count is NEVER guessed. An empty/missing
   DAGS string counts as 0, not unparseable. Note honestly:
   an *expected* dag total cannot come from the index (it
   carries no dag count), so dag reconciliation is
   collected-counts plus a flag whenever any detail failed.
4. **Reconcile before marking complete:** a unit is
   `complete` ONLY if `collected == expected` AND zero
   failed details AND zero unparseable records. A single
   stored record proves loading works, never completeness.
   Any mismatch, failed detail, or unreadable record →
   status `partial` with the missing khatian_nos + reasons
   kept OPEN in the index row's `issues` JSONB (capped at
   200 entries, with a truncation note if huge) — never
   synthesized, never silently skipped.
5. **Re-run reopens:** a later import re-run re-fetches the
   fresh expected count and REOPENS a unit to `partial` if
   it finds a gap — including source rows read but never
   entered (they appear as failed/missing in that run's
   issues). A previously `complete` unit can therefore go
   back to `partial` on a later run; only a clean run (zero
   failed, collected == fresh expected) marks it `complete`
   again.
6. **Live-search upserts NEVER set a unit `complete` and
   NEVER downgrade a `complete` unit to `partial`** — they
   refresh `collected_count` (from the store count) and
   dates only, leaving status, expected_count, and issues
   untouched. A brand-new live-only row starts `partial`
   with a `LIVE_SEARCH_ONLY` issue, so it is never mistaken
   for a verified-complete unit.
7. **Hal-sabek never affects completeness** (best-effort
   only — see the verification table). Mutation is never
   imported: the offered-surveys list contains no mutation
   survey, so import cannot select it; the conditional
   passthrough stays search-only.

### Sampling audit (lightweight, no separate sampler)

Any batch claiming complete units is audited by **re-running
import for a sample unit** (a single-mouza import call for
that JL × survey), which re-reconciles fresh expected vs
stored and reopens the unit to `partial` on any gap. The
re-run rule above IS the mechanism — no separate sampler is
built. A working lookup does not prove every source row
arrived; only the re-reconciled counts do.

## Collection: import endpoint + coverage

### `POST /api/land-khatian/admin/import` (admin only)

Body: `{division_bbs, district_bbs, upazila_bbs,
survey_id | 'all', mouza_id | jl_id (optional: single
mouza), cursor?}` plus optional `*_name` fields for the
index rows.

- **One call imports ONE survey** for **up to 5 mouzas**
  (or **3000 records**, whichever first — a mouza already
  in progress always finishes whole; the cap stops
  *starting* new mouzas). Import uses the full index list +
  detail per mouza via `adapter.importMouza` (reusing the
  live client, never a criterion search).
- **Per-mouza failure is counted, never aborts the call**
  (`failedMouzas[]`). Mouzas with no JL entry in the survey
  are skipped (`skippedMouzas[]`), cursor still advances.
- **Continuation:** response carries `nextCursor` (opaque
  base64url `{s: surveyIndex, m: mouzaOffset}` within the
  portal's offered-survey list); `done: true` when the scope
  is exhausted. Call repeatedly with the returned cursor.
- **District-wide import = repeated upazila calls.** There
  is deliberately **no whole-country scope** — a request
  without division/district/upazila is rejected (400), and
  no country-wide endpoint exists to add later by accident.
- **Per-batch report** (never "complete" when partly
  complete): `batchStatus` (`complete` only when every
  attempted mouza completed; anything else → `partial`),
  `batch: {mouzasAttempted, mouzasCompleted,
  mouzasPartial, mouzasFailed, mouzasSkipped,
  khatiansExpected, khatiansCollected, dagsCollected}`,
  per-mouza `reconciliation[]` lines (mouza, JL, survey,
  expected, collected, status, dagsCollected, failedDetails,
  issues), `dataset` totals for the upazila scope (so
  per-unit errors that offset each other still surface),
  and the `openUnits` list for the scope.
- Response also carries the legacy totals
  (`importedMouzas, totalMouzasInScope, recordsUpserted,
  failedMouzas, skippedMouzas, nextCursor, surveyKey,
  surveyName, surveyIndex, totalSurveys`) plus
  `coverage: {upazila, district}`, `coverageNote`, and
  `launchGateNote`.

### Coverage — percent definition (used everywhere)

```json
{ "totalUnits": 120, "completeUnits": 42, "partialUnits": 9,
  "notStartedUnits": 69, "percentComplete": 35.0,
  "coverageAvailable": true, "openUnits": [ … ] }
```

- **percentComplete = completeUnits / totalUnits × 100.**
  Partial units are shown separately and NEVER counted as
  complete.
- **Denominator:** `totalUnits` = (mouza, survey)
  combinations **as listed by the portal's own lists**
  (offered surveys × `jlNumbers` per upazila, distinct
  mouza per survey — the portal presents one JL per mouza
  per survey; district scope walks every upazila in the
  district). **Never invented.**
- **Percent unavailable:** if the portal lists are
  unreachable when coverage is queried, the response still
  reports the counts and sets `totalUnits: null`,
  `percentComplete: null`, `coverageAvailable: false` —
  never a guessed denominator.
- **Open/partial list:** `openUnits` (capped at 100, with
  `openUnitsTotal` + `openUnitsTruncated`) lists every
  partial unit in scope with expected vs collected and its
  issues.
- Every coverage output also carries `coverageNote`
  (stored data covers only what is already collected) and
  `launchGateNote` (the gate above).

### `GET /api/land-khatian/admin/coverage?district_bbs=&upazila_bbs=` (admin only, read-only)

Index rows for the scope (mouza, survey, expected,
collected, status, issues, last collected) plus the
coverage objects above for the upazila (when given) and
the district.

### `GET /api/land-khatian/coverage` (public, requireAuth — NOT admin-only)

- **Without scope params: deliberately CHEAP — index rows
  only**, grouped by district (`districts[]` with
  complete/partial units, record counts, last collected).
  No portal walk happens here, so the denominator is not
  known and `percentComplete` is null/unavailable (never
  invented) — with a `percentNote` saying so.
- **With `?district_bbs=&upazila_bbs=`:** the full scoped
  coverage (same definition as the admin endpoint,
  including the portal-walk denominator).
- Either way the response carries `collectionPhase: true`,
  `isAllBd: false`, `coverageNote`, and `launchGateNote` —
  the stored service is in its collection phase and is NOT
  an all-BD service. The customer page calls this endpoint
  on load and shows its box from it (see below).

## Store-hit honesty: surveysPresent

Every store-served search response includes `surveysPresent`
— the survey keys actually present in the stored records
for that JL. The frontend stale banner shows ONLY those
surveys as stored ("সংরক্ষিত জরিপ: RS, BS — এর বাইরের
জরিপ সংরক্ষিত নয়"), never implying uncollected surveys
are covered. A live-down + store-empty case NEVER returns
200 with records or a success-shaped answer — it is 502 +
`storeEmpty` only, with no charge and no order. A genuine
live 0-result stays a 422 not-found — an uncollected mouza
is never shown as found.

### Timeline method (no fixed number, ever)

**No timeline for full all-BD coverage is estimated as a
fixed number in code or docs.** The method is: measure the
first district batch's actual rate — mouzas/hour and
records/sec, as observed on a real import run — then
extrapolate from that measurement (remaining pairs ÷
measured rate). Until that first batch is measured, any
date would be a guess, so none is given.

## Hosting options for the separate store

The separate store **must be provisioned BEFORE production
collection starts** — collecting into the ephemeral local
file store on the app server and migrating later is how
data gets lost. Two options:

| | Second small server (reference server) | Managed DB (via an API shim) |
|---|---|---|
| Cost | Cheapest: smallest VPS/container; JSON files, no DB licence | DB instance cost + shim hosting; scales with data |
| Ops | One more service to monitor/restart; deploy = copy `server.js` | Managed backups/patching; still needs the shim (the app talks HTTP, not SQL) |
| Backup | Back up the data dir (rsync/snapshot); restore = copy files back | Point-in-time restore built in; test restore before relying on it |
| Latency | Same-region VPS ≈ local; cross-region adds ~100 ms+ per store call (only on fallback path, so tolerable) | Same-region managed DB ≈ local; the shim adds one hop |
| Auth | `STORE_API_KEY` → `X-Store-Key` header; put it behind a firewall/VPN so only the app server reaches it | Same header auth on the shim + DB credentials only on the shim; never expose the DB publicly |
| Failure mode | Server down → fallback path 502s, live still works | Same: shim/DB down → fallback path 502s, live still works |

Recommended default: the **second small server** in the same
region as the app server — simplest, cheapest, and its
failure mode is identical to the managed option (live still
works). Whichever is chosen, the app server's env
(`LAND_KHATIAN_STORE_URL` + `LAND_KHATIAN_STORE_KEY`)
points at it, and the index table stays in production
Postgres either way.

## What is deliberately NOT built

- No bulk records table in production Postgres (index only).
- No eporcha.tech fetch/import code, data, or endpoint of
  any kind. The `source` field carries `dlrms` only.
- No whole-country import scope, no background import job,
  no cron — import is admin-driven, step by step, so a run
  can be watched and stopped.
- No map/PDF collection, no full-written-khatian
  collection, no certified-copy collection, no
  eporcha-PDF collection (see the verification table) —
  none of them has code, an endpoint, or a store write
  anywhere in this change.
- No separate sampling auditor — the import re-run rule
  (above) is the audit mechanism.

## eporcha.tech — future target only (docs note)

`eporcha.tech` records are a **FUTURE collection target,
pending a verified example (mouza + khatian number + survey
type) from Pankaj**. Until such an example verifies that the
site actually holds records worth collecting, nothing is
built or imported from it. Even then, only records truly
retrieved (never invented) would be collected, only into
the **separate store** (never production Postgres), and
only with their provenance recorded honestly. This paragraph
is the only place eporcha.tech appears in the store design.

## Still unproven

- Live portal behaviour on the day of any real import run
  (the portal can change; import re-resolves everything
  from its live lists, so a change surfaces as an error,
  not silent wrong data).
- A real separate-store deployment (the reference server is
  tested locally against an ephemeral port, not deployed).
- A real import run's measured rate (mouzas/hour,
  records/sec) — the timeline method needs it, and it does
  not exist yet.
- Store fallback against the real portal being down (only
  mocked in tests).
