# Engines — Modular Service Engines

Each engine is a **permanent, self-contained module** that powers an
automated service (NID card generation, BDRIS auto-fill, Death
Registration, ...).

## How to add a new engine

1. Create a folder: `engines/<engine-id>/`
2. Add `engine.json` manifest:

```json
{
  "id": "nid",
  "name": "NID Card Engine",
  "version": "1.0.0",
  "entry": "index.js",
  "description": "Extracts NID data from PDF and generates card"
}
```

3. Add `index.js` exporting at minimum:

```js
module.exports = {
  // Called by the order pipeline when an order uses this engine
  async run(payload) {
    // payload: { order, user, service, files }
    // return: { ok: true, result: {...} }
  }
};
```

4. If the engine needs a service row, set the service's `engine_id`
   column to the engine id (see `database/schema.sql`).
5. Restart the backend — `backend/engines-loader.js` auto-discovers
   every folder with an `engine.json`.

## Rules (permanent architecture)

- No binaries or config in `/tmp` — everything lives inside the
  engine folder or a persistent path.
- No CDN runtime dependencies — bundle what you need.
- Engines must be restart-safe: no in-memory-only state that
  breaks on reboot.
- Never bypass government portal validation (no DOM manipulation
  to force submissions). Engines assist the operator; they do not
  falsify.

## Planned engines

- `nid` — NID PDF extraction + card generation
- `bdris` — BDRIS application auto-fill assistant
- `death-reg` — Death Registration engine (requested)
