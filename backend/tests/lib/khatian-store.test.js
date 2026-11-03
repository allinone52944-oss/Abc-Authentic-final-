// Store client tests: local file store + HTTP client against
// the reference store server on an ephemeral port. Synthetic
// data only — no real person's name, NID, or mobile.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStoreClient } = require('../../lib/khatianStore');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kh-store-'));
}

const AREA = { divisionBbs: '30', districtBbs: '26', upazilaBbs: '48', mouzaId: '72400', mouza: 'Test Mouza', jl: '33' };
const REC_A = { id: 900, khatianNo: '8', owners: 'Test One', dags: '1237', totalLand: '0.0544', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] };
const REC_B = { id: 901, khatianNo: '9', owners: 'Test Two', dags: '1240, 1241', totalLand: '0.1', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] };

describe('local file store', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('upsert/search filters: khatian exact, owner substring, dag substring', async () => {
    const s = createStoreClient({ storeDir: dir });
    await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    let r = await s.search({ mouzaId: '72400', surveyKey: 'RS', khatianNo: '8' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('8');
    expect(r.totalMatches).toBe(1);
    expect(r.mouzaCollected).toBe(true);
    r = await s.search({ mouzaId: '72400', surveyKey: 'RS', ownerName: 'Two' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('9');
    r = await s.search({ mouzaId: '72400', surveyKey: 'RS', dagNo: '1241' });
    expect(r.records).toHaveLength(1);
    r = await s.search({ mouzaId: '72400', surveyKey: 'RS', khatianNo: '999' });
    expect(r.records).toHaveLength(0);
    expect(r.mouzaCollected).toBe(true); // stored data exists, query matched nothing
    r = await s.search({ mouzaId: '99999', surveyKey: 'RS' });
    expect(r.records).toHaveLength(0);
    expect(r.mouzaCollected).toBe(false);
  });

  test('Bengali digits in query match Latin stored values; collectedAt is max over returned', async () => {
    const s = createStoreClient({ storeDir: dir });
    await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [
      { ...REC_A, collectedAt: '2026-11-01T00:00:00.000Z' },
      { ...REC_B, collectedAt: '2026-11-02T00:00:00.000Z' },
    ], source: 'dlrms' });
    const r = await s.search({ mouzaId: '72400', surveyKey: 'RS', khatianNo: '৮' });
    expect(r.records).toHaveLength(1);
    const all = await s.search({ mouzaId: '72400', surveyKey: 'all' });
    expect(all.collectedAt).toBe('2026-11-02T00:00:00.000Z');
  });

  test('countForUnit counts distinct stored records, never a running increment', async () => {
    const s = createStoreClient({ storeDir: dir });
    await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    expect((await s.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(2);
    await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A], source: 'dlrms' });
    expect((await s.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(1);
  });

  test('merge upsert keeps previously stored records (live-search subset must not destroy a full unit)', async () => {
    const s = createStoreClient({ storeDir: dir });
    await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    const up = await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A], source: 'dlrms', merge: true });
    expect(up.total).toBe(2);
    expect((await s.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(2);
  });

  test('write leaves no tmp leftovers', async () => {
    const s = createStoreClient({ storeDir: dir });
    await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A], source: 'dlrms' });
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toHaveLength(0);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });
});

describe('HTTP client against the reference server', () => {
  let dir; let server; let port;
  const OLD_ENV = { ...process.env };
  beforeAll(async () => {
    dir = tmpDir();
    process.env.STORE_DATA_DIR = dir;
    process.env.STORE_API_KEY = 'test-key-123';
    jest.resetModules();
    const srv = require('../../../engines/land-khatian/store-server/server');
    server = srv.server;
    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = OLD_ENV;
  });

  test('upsert/search/health/count round-trip', async () => {
    const s = createStoreClient({ storeUrl: 'http://127.0.0.1:' + port, storeKey: 'test-key-123' });
    expect(await s.ping()).toMatchObject({ ok: true });
    const up = await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    expect(up.upserted).toBe(2);
    expect(up.total).toBe(2);
    const r = await s.search({ mouzaId: '72400', surveyKey: 'RS', ownerName: 'One' });
    expect(r.records).toHaveLength(1);
    expect((await s.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(2);
  });

  test('wrong key → STORE_UNREACHABLE (never a raw error)', async () => {
    const s = createStoreClient({ storeUrl: 'http://127.0.0.1:' + port, storeKey: 'wrong-key' });
    await expect(s.ping()).rejects.toMatchObject({ code: 'STORE_UNREACHABLE' });
    await expect(s.search({ mouzaId: '72400' })).rejects.toMatchObject({ code: 'STORE_UNREACHABLE' });
  });

  test('unreachable server → STORE_UNREACHABLE', async () => {
    const s = createStoreClient({ storeUrl: 'http://127.0.0.1:1', storeKey: 'x' });
    await expect(s.ping()).rejects.toMatchObject({ code: 'STORE_UNREACHABLE' });
  });
});
