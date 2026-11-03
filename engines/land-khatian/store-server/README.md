# Khatian collection store — reference server

Zero-dependency Node HTTP server holding the **bulk** khatian
records for the land-khatian engine. Production Postgres holds
only the index/metadata table `land_khatian_index` — never
these records. See `../STORE.md` for the full architecture.

## Run

```sh
cd engines/land-khatian/store-server
STORE_DATA_DIR=./data STORE_API_KEY=your-secret-key PORT=3101 node server.js
```

`STORE_DATA_DIR` defaults to `./data` under this directory
(git-ignored — data never enters the repo). `STORE_API_KEY`
is optional in dev; when set, every request must carry header
`X-Store-Key` with that value, or the server answers 401.

Point the app server at it:

```sh
LAND_KHATIAN_STORE_URL=http://127.0.0.1:3101
LAND_KHATIAN_STORE_KEY=your-secret-key   # same value as STORE_API_KEY
```

Without `LAND_KHATIAN_STORE_URL` the app uses its ephemeral
local file store instead (tmp dir, local dev only).

## PostgreSQL backend (separate database, never production)

The file backend above is the dev default. For a real
deployment, run the same server against a **separate**
PostgreSQL database — never the production database
(`abc_authentic_new` holds only the index table):

```sh
cd engines/land-khatian/store-server
npm install   # installs the pg dependency (package.json)
STORE_BACKEND=postgres \
STORE_PG_CONNECTION_STRING=<connection-string-from-env> \
STORE_API_KEY=your-secret-key PORT=3101 node server.js
```

Or the component form instead of a connection string:
`STORE_PG_HOST`, `STORE_PG_PORT` (default 5432),
`STORE_PG_DATABASE`, `STORE_PG_USER`, `STORE_PG_PASSWORD`,
plus optional `STORE_PG_POOL_MAX` (default 10) and
`STORE_PG_SSL` (`true` for verified TLS, `insecure` for
dev only). The schema (`khatian_units` + `khatian_records`,
see `pgStore.js`) is created automatically on first use,
in that separate database only. The HTTP contract is
identical to the file backend, so the app-side client
needs no change — point `LAND_KHATIAN_STORE_URL` at this
server exactly as above. Connection values come from env
only and are never logged.

Transferring the store later (for example to a new Oracle
account) is a database dump/restore plus a URL change —
no engine rebuild; see the transfer procedure in
`../STORE.md`.

## API contract

All requests/responses are JSON. When `STORE_API_KEY` is set,
every request needs `X-Store-Key: <key>`.

### `GET /v1/health` → `{ ok: true }`

### `POST /v1/records/upsert`

Request:

```json
{
  "area": { "divisionBbs": "30", "districtBbs": "26", "upazilaBbs": "48",
            "mouzaId": "72400", "mouza": "Test Mouza", "jl": "33" },
  "surveyKey": "RS", "surveyName": "আর এস",
  "jlId": "238686", "mouzaId": "72400", "jlNumber": "33",
  "records": [ {
    "rawIndex": { "ID": 900, "KHATIAN_NO": "8", "OWNERS": "…" },
    "rawDetail": { "ID": 900, "KHATIAN_NO": "8", "OWNERS": "…",
                   "DAGS": "1237", "TOTAL_LAND": "0.0544" },
    "halSabek": [],
    "meta": { "source": "dlrms", "jlId": "238686",
              "surveyKey": "RS", "surveyName": "আর এস" }
  } ],
  "source": "dlrms"
}
```

Stored records are RAW (see `../STORE.md`, "RAW-VERBATIM
COLLECTION RULE"): the exact portal index + detail JSON,
verbatim hal-sabek rows, and separate collection metadata.
`source` carries `dlrms` only. Response: `{ upserted: <n>,
updated: <bool>, total: <n> }` (`updated` is true when a
file for that `(jlId, surveyKey)` already existed; `total`
is the stored record count for the unit after the write).
Upsert replaces the whole record set for that `(jlId,
surveyKey)` — unless `"merge": true` is passed, in which
case the incoming records are merged by record id with the
existing file (live-search upserts use this, so a searched
subset never destroys a previously imported full unit).

### `GET /v1/records/count?jl_id=&survey_key=` → `{count}`

Distinct stored records for one unit (mouza JL × survey),
counted from the files themselves. The app's index row
`collected_count` must always equal this number, never a
running increment.

### `GET /v1/records/search?jl_id=&mouza_id=&survey_key=&khatian_no=&owner_name=&dag_no=`

- `jl_id` wins when given; `mouza_id` is the fallback
  (the customer frontend sends `mouza_id` only).
- `survey_key` is one survey key, or `all`/omitted for all.
- Filters: `khatian_no` exact, `owner_name` substring,
  `dag_no` substring on `DAGS`. Filters run on delivery-
  mapped rows (see `storeMapping.js`); stored payloads are
  never rewritten to match a filter.
- `raw=1` (import merge-prune ONLY): returns the stored
  records verbatim for the whole unit, with NO delivery
  mapping and NO filters. Default (absent) = display mode.

Response:

```json
{
  "records": [ … ],
  "collectedAt": "2026-11-03T…Z",
  "totalMatches": 1,
  "mouzaCollected": true
}
```

`collectedAt` is the max over returned records.
`mouzaCollected` is true when ANY stored file exists for
that mouza/survey scope, even if the filters matched none
or the stored record list is empty (a mouza genuinely
holding 0 khatians in this survey) — the app uses it to
tell "no stored data for this mouza yet" (502 +
`storeEmpty`) apart from "stored data exists but this
query matched nothing" (also 502 while live is down,
never a definitive not-found from partial stored data).

## Notes

- No eporcha.tech endpoint, import, or data anywhere here.
- If this server is down, the engine still works via live
  DLRMS — the store is a fallback, never a hard dependency.
- Back this server's data dir up like any other data store;
  its loss only loses the fallback copy (live DLRMS remains
  primary, and the index table still knows what was collected).
