'use strict';

// HTTP contract test: the app-side client
// (backend/lib/khatianStore.js) talking to the store
// server backed by PostgreSQL (fake pool) — proving the
// HTTP API is unchanged, so the client needs NO change.
// Synthetic data only.
const { createStoreClient } = require('../../lib/khatianStore');
const { createPgBackend } = require('../../../engines/land-khatian/store-server/pgStore');
const { createFakePool } = require('./khatianPgFakePool');

const AREA = { divisionBbs: '30', districtBbs: '26', upazilaBbs: '48', mouzaId: '72400', mouza: 'Test Mouza', jl: '33' };
const REC_A = { id: 900, khatianNo: '8', owners: 'Test One', dags: '1237', totalLand: '0.0544', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] };
const REC_B = { id: 901, khatianNo: '9', owners: 'Test Two', dags: '1240, 1241', totalLand: '0.1', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] };

describe('store server over postgres backend (fake pool)', () => {
  let server; let port;
  const OLD_ENV = { ...process.env };
  beforeAll(async () => {
    process.env.STORE_API_KEY = 'pg-test-key-123';
    jest.resetModules();
    const srv = require('../../../engines/land-khatian/store-server/server');
    server = srv.createServer(createPgBackend(createFakePool()));
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    process.env = OLD_ENV;
  });

  test('upsert/search/health/count round-trip through the unchanged HTTP API', async () => {
    const s = createStoreClient({ storeUrl: 'http://127.0.0.1:' + port, storeKey: 'pg-test-key-123' });
    expect(await s.ping()).toMatchObject({ ok: true });
    const up = await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    expect(up.upserted).toBe(2);
    expect(up.total).toBe(2);
    const r = await s.search({ mouzaId: '72400', surveyKey: 'RS', ownerName: 'One' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('8');
    expect((await s.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(2);
  });

  test('wrong key → STORE_UNREACHABLE (never a raw error)', async () => {
    const s = createStoreClient({ storeUrl: 'http://127.0.0.1:' + port, storeKey: 'wrong-key' });
    await expect(s.ping()).rejects.toMatchObject({ code: 'STORE_UNREACHABLE' });
  });
});
