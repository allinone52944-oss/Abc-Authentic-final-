'use strict';

// PostgreSQL store backend tests, against an in-memory fake
// `pg` Pool (no live database, no real credentials, no real
// person's data — synthetic records only). These tests prove
// the PG backend honours the SAME contract as the file
// backend: replace vs merge, empty-unit collection, search
// filters (incl. Bengali digits), jl-wins/mouza fallback,
// distinct counts, and schema separation from production.
const { createPgBackend, createPgPoolFromEnv, PG_SCHEMA_SQL } = require('../../../engines/land-khatian/store-server/pgStore');
const { createFakePool } = require('./khatianPgFakePool');

const AREA = { divisionBbs: '30', districtBbs: '26', upazilaBbs: '48', mouzaId: '72400', mouza: 'Test Mouza', jl: '33' };
const REC_A = { id: 900, khatianNo: '8', owners: 'Test One', dags: '1237', totalLand: '0.0544', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] };
const REC_B = { id: 901, khatianNo: '9', owners: 'Test Two', dags: '1240, 1241', totalLand: '0.1', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] };

describe('pgStore schema', () => {
  test('defines only the separate-store tables, never the production database', () => {
    expect(PG_SCHEMA_SQL).toContain('khatian_units');
    expect(PG_SCHEMA_SQL).toContain('khatian_records');
    expect(PG_SCHEMA_SQL).not.toContain('abc_authentic_new');
    expect(PG_SCHEMA_SQL).not.toContain('land_khatian_index');
  });
});

describe('pgStore backend (fake pool)', () => {
  let pool; let store;
  beforeEach(() => { pool = createFakePool(); store = createPgBackend(pool); });

  test('upsert replace: first write not updated, second write replaces and reports updated', async () => {
    const first = await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    expect(first).toMatchObject({ upserted: 2, updated: false, total: 2 });
    const second = await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A], source: 'dlrms' });
    expect(second).toMatchObject({ upserted: 1, updated: true, total: 1 });
    const r = await store.search({ mouzaId: '72400', surveyKey: 'RS' });
    expect(r.records).toHaveLength(1);
  });

  test('merge: keeps untouched records, overlays updated ones by id', async () => {
    await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    const out = await store.upsert({
      area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686,
      records: [{ ...REC_B, owners: 'Test Two Updated' }, { id: 902, khatianNo: '10', owners: 'Test Three', dags: '1250', totalLand: '0.2', surveyKey: 'RS', surveyName: 'RS', jlId: 238686, halSabek: [] }],
      source: 'dlrms', merge: true,
    });
    expect(out.total).toBe(3);
    const r = await store.search({ mouzaId: '72400', surveyKey: 'RS' });
    expect(r.records).toHaveLength(3);
    expect(r.records.find((x) => x.khatianNo === '9').owners).toBe('Test Two Updated');
    expect(r.records.find((x) => x.khatianNo === '8')).toBeTruthy();
  });

  test('empty unit still counts as collected; search filters incl. Bengali digits', async () => {
    await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [], source: 'dlrms' });
    let r = await store.search({ mouzaId: '72400', surveyKey: 'RS' });
    expect(r.mouzaCollected).toBe(true);
    expect(r.records).toHaveLength(0);
    await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    r = await store.search({ mouzaId: '72400', surveyKey: 'RS', khatian_no: '৮' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('8');
    r = await store.search({ mouzaId: '72400', surveyKey: 'RS', owner_name: 'Two' });
    expect(r.records).toHaveLength(1);
    r = await store.search({ mouzaId: '72400', surveyKey: 'RS', dag_no: '1241' });
    expect(r.records).toHaveLength(1);
    r = await store.search({ mouzaId: '72400', surveyKey: 'RS', khatian_no: '999' });
    expect(r.records).toHaveLength(0);
    expect(r.mouzaCollected).toBe(true);
  });

  test('jl_id wins over mouza_id; survey all spans surveys; no scope means not collected', async () => {
    await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A], source: 'dlrms' });
    await store.upsert({ area: { ...AREA, mouzaId: '72500' }, surveyKey: 'BS', surveyName: 'BS', jlId: 238687, mouzaId: '72500', records: [REC_B], source: 'dlrms' });
    let r = await store.search({ jlId: 238686, mouzaId: '72500', surveyKey: 'RS' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('8');
    r = await store.search({ jlId: 238686, surveyKey: 'all' });
    expect(r.records).toHaveLength(1);
    r = await store.search({ mouzaId: '72500', surveyKey: 'all' });
    expect(r.records).toHaveLength(1);
    r = await store.search({});
    expect(r).toMatchObject({ records: [], mouzaCollected: false, totalMatches: 0 });
  });

  test('search accepts snake_case server-contract keys as well as camelCase', async () => {
    await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    const snake = await store.search({ mouza_id: '72400', survey_key: 'RS', khatian_no: '8' });
    expect(snake.records).toHaveLength(1);
    const camel = await store.search({ mouzaId: '72400', surveyKey: 'RS', khatianNo: '8' });
    expect(camel.records).toHaveLength(1);
    expect(camel.records[0].khatianNo).toBe(snake.records[0].khatianNo);
  });

  test('countForUnit counts distinct records; missing args give 0; schema created once', async () => {
    await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A, REC_B], source: 'dlrms' });
    await store.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'RS', jlId: 238686, records: [REC_A], source: 'dlrms', merge: true });
    expect(await store.countForUnit({ jlId: 238686, surveyKey: 'RS' })).toMatchObject({ count: 2 });
    expect(await store.countForUnit({})).toMatchObject({ count: 0 });
    expect(await store.ping()).toMatchObject({ ok: true });
    expect(pool.queries.filter((q) => q.includes('CREATE TABLE')).length).toBe(1);
  });
});

describe('createPgPoolFromEnv errors', () => {
  const OLD_ENV = { ...process.env };
  afterEach(() => { process.env = OLD_ENV; });
  test('missing configuration throws env names only, never a credential value', () => {
    process.env = { ...OLD_ENV };
    delete process.env.STORE_PG_CONNECTION_STRING;
    delete process.env.STORE_PG_DATABASE;
    delete process.env.STORE_PG_USER;
    process.env.STORE_PG_PASSWORD = 'sentinel-password-must-not-leak';
    expect(() => createPgPoolFromEnv()).toThrow(/STORE_PG_CONNECTION_STRING/);
    try {
      createPgPoolFromEnv();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.message).not.toContain('sentinel-password-must-not-leak');
    }
  });
});

describe('resolveBackendName', () => {
  test('file default, postgres selection, unknown rejected', () => {
    const { resolveBackendName } = require('../../../engines/land-khatian/store-server/server');
    expect(resolveBackendName({})).toBe('file');
    expect(resolveBackendName({ STORE_BACKEND: 'postgres' })).toBe('postgres');
    expect(() => resolveBackendName({ STORE_BACKEND: 'bogus' })).toThrow(/file or postgres/);
  });
});
