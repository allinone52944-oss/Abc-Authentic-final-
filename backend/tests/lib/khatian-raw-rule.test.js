'use strict';

// RAW-VERBATIM COLLECTION RULE tests.
// Source records must be stored EXACTLY as the source
// site returns them — no renaming, dropping, or
// reformatting at import time. Presentation mapping runs
// only at delivery time (storeMapping.js). Synthetic data
// only — no real person's name, NID, or mobile.
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
  // Test double mirrors the real ownerMatches: whole-token match
  // inside ONE comma-separated owner entry (audit #7), not a raw
  // substring — 'দুই' still finds 'পরীক্ষক দুই', 'আল' must not
  // find 'আলী'.
  ownerMatches: (owners, name) => {
    const toks = (s) => String(s || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const q = toks(name);
    if (!q.length) return false;
    return String(owners || '').split(',').some((e) => {
      const et = toks(e);
      return q.every((t) => et.includes(t));
    });
  },
  sumLand: (ds) => Math.round(ds.reduce((a, d) => a + (parseFloat(d.TOTAL_LAND) || 0), 0) * 10000) / 10000,
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const client = require('../../../engines/land-core/client');
const adapter = require('../../../engines/land-khatian/adapter');
const { createStoreClient } = require('../../lib/khatianStore');
const { createPgBackend } = require('../../../engines/land-khatian/store-server/pgStore');
const { createFakePool } = require('./khatianPgFakePool');
const {
  toStoredRecord, mapStoredToDisplay, storedRecordId, storedCollectedAt,
} = require('../../../engines/land-khatian/store-server/storeMapping');

const AREA = { divisionBbs: '30', districtBbs: '26', upazilaBbs: '48' };
const UNIT = { surveyKey: 'RS', surveyName: 'আর এস', jlId: 238686 };

// A source payload with EXTRA fields the old normalize()
// dropped (entry key, area names, non-deliverable flags):
// the raw rule keeps all of them, byte for byte.
const INDEX_HIT = {
  ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক',
  NON_DELIVERABLE_MESSAGE_IDS: [11], EXTRA_INDEX_FIELD: 'keep-me',
};
const DETAIL = {
  ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক', DAGS: '1237',
  TOTAL_LAND: '0.0544', KHATIAN_ENTRY_ID: 'ENT-900',
  DIVISION_NAME: 'ঢাকা', DISTRICT_NAME: 'ঢাকা', UPAZILA_NAME: 'মিরপুর',
  MOUZA_NAME: 'পরীক্ষা মৌজা', EXTRA_DETAIL_FIELD: { nested: [1, 2] },
};
const HAL_ROWS = [{ SABEK: 'পুরনো', HAL: 'নতুন' }];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kh-raw-'));
}
function offered(surveys) {
  client.surveys.mockResolvedValue(surveys);
  client.upazilaSurveys.mockResolvedValue(
    surveys.map((s) => ({ SURVEY_ID: s.ID, LOCAL_NAME: s.NAME })),
  );
}
function jl(rows) {
  client.jlNumbers.mockResolvedValue(rows);
}

beforeEach(() => {
  jest.clearAllMocks();
  client.halSabek.mockResolvedValue([]);
});

describe('storeMapping: verbatim storage, mapping only at delivery', () => {
  test('toStoredRecord keeps raw payloads deep-equal, drops junk keys, stamps meta', () => {
    const stored = toStoredRecord({
      rawIndex: INDEX_HIT, rawDetail: DETAIL, halSabek: HAL_ROWS,
      meta: { source: 'dlrms', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' },
      junkKey: 'must-not-survive', id: 999, khatianNo: 'WRONG',
    }, '2026-11-03T00:00:00.000Z');
    expect(stored.rawIndex).toEqual(INDEX_HIT);
    expect(stored.rawDetail).toEqual(DETAIL);
    expect(stored.halSabek).toEqual(HAL_ROWS);
    expect(stored.meta).toEqual({
      source: 'dlrms', collectedAt: '2026-11-03T00:00:00.000Z',
      jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস',
    });
    expect(stored).not.toHaveProperty('junkKey');
    expect(stored).not.toHaveProperty('id');
    expect(stored).not.toHaveProperty('khatianNo');
    // The source objects themselves are never mutated.
    expect(INDEX_HIT).toEqual({
      ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক',
      NON_DELIVERABLE_MESSAGE_IDS: [11], EXTRA_INDEX_FIELD: 'keep-me',
    });
  });

  test('toStoredRecord stamps collectedAt when meta has none, defaults source to dlrms', () => {
    const stored = toStoredRecord({ rawIndex: INDEX_HIT, rawDetail: DETAIL }, '2026-11-03T01:00:00.000Z');
    expect(stored.meta.collectedAt).toBe('2026-11-03T01:00:00.000Z');
    expect(stored.meta.source).toBe('dlrms');
    expect(stored.rawDetail).toBe(DETAIL);
    expect(stored.halSabek).toEqual([]);
  });

  test('legacy display-shaped rows pass through untouched (pre-rule fixtures only)', () => {
    const legacy = { id: 900, khatianNo: '8', owners: 'পরীক্ষক এক', dags: '1237', totalLand: '0.0544' };
    expect(toStoredRecord(legacy, '2026-11-03T00:00:00.000Z')).toEqual(legacy);
    expect(toStoredRecord(legacy, '2026-11-03T00:00:00.000Z')).not.toHaveProperty('meta');
  });

  test('mapStoredToDisplay equals the old normalize output for the same detail', () => {
    const stored = toStoredRecord({
      rawIndex: INDEX_HIT, rawDetail: DETAIL, halSabek: HAL_ROWS,
      meta: { source: 'dlrms', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' },
    }, '2026-11-03T00:00:00.000Z');
    expect(mapStoredToDisplay(stored, UNIT)).toEqual({
      id: 900, khatianNo: '8', owners: 'পরীক্ষক এক', dags: '1237',
      totalLand: '0.0544', surveyKey: 'RS', surveyName: 'আর এস',
      jlId: 238686, halSabek: HAL_ROWS,
    });
  });

  test('mapStoredToDisplay falls back to the index khatian number when detail is empty', () => {
    const stored = toStoredRecord({
      rawIndex: INDEX_HIT, rawDetail: { ID: 900, KHATIAN_NO: '', OWNERS: '', DAGS: '', TOTAL_LAND: null },
      halSabek: [],
      meta: { source: 'dlrms', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' },
    }, '2026-11-03T00:00:00.000Z');
    expect(mapStoredToDisplay(stored, UNIT).khatianNo).toBe('8');
    expect(mapStoredToDisplay(stored, UNIT).owners).toBe('');
  });

  test('mapStoredToDisplay passes legacy rows through unchanged', () => {
    const legacy = { id: 900, khatianNo: '8', owners: 'পরীক্ষক এক', dags: '1237' };
    expect(mapStoredToDisplay(legacy, UNIT)).toEqual(legacy);
  });

  test('storedRecordId / storedCollectedAt: raw meta first, legacy fallback', () => {
    const raw = toStoredRecord({
      rawIndex: INDEX_HIT, rawDetail: DETAIL,
      meta: { source: 'dlrms', collectedAt: '2026-11-03T02:00:00.000Z', jlId: 238686, surveyKey: 'RS' },
    }, '2026-11-03T00:00:00.000Z');
    expect(storedRecordId(raw)).toBe('900');
    expect(storedCollectedAt(raw)).toBe('2026-11-03T02:00:00.000Z');
    expect(storedRecordId({ id: 901 })).toBe('901');
    expect(storedCollectedAt({ collectedAt: '2026-11-01T00:00:00.000Z' })).toBe('2026-11-01T00:00:00.000Z');
    expect(storedRecordId({})).toBe('');
    expect(storedCollectedAt({})).toBe(null);
  });
});

describe('adapter: rawItems alongside display items', () => {
  test('search (khatian path) returns raw payloads verbatim, hal-sabek on both', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400, MOUZA_NAME: 'পরীক্ষা মৌজা', JL_NUMBER: '33' }]);
    client.indexByKhatianNo.mockResolvedValue([INDEX_HIT]);
    client.detail.mockResolvedValue(DETAIL);
    client.halSabek.mockResolvedValue(HAL_ROWS);
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', khatianNo: '8' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ id: 900, khatianNo: '8', halSabek: HAL_ROWS });
    expect(r.rawItems).toHaveLength(1);
    expect(r.rawItems[0].rawIndex).toEqual(INDEX_HIT);
    expect(r.rawItems[0].rawDetail).toEqual(DETAIL);
    expect(r.rawItems[0].halSabek).toEqual(HAL_ROWS);
    expect(r.rawItems[0].meta).toEqual({ source: 'dlrms', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' });
    // Display items must NOT carry the dropped extra fields.
    expect(r.items[0]).not.toHaveProperty('KHATIAN_ENTRY_ID');
    expect(r.items[0]).not.toHaveProperty('rawDetail');
  });

  test('importMouza returns raw records; indexItems stay reconciliation keys only', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400, MOUZA_NAME: 'পরীক্ষা মৌজা', JL_NUMBER: '33' }]);
    client.indexList.mockResolvedValue([INDEX_HIT, { ID: 901, KHATIAN_NO: '9', OWNERS: 'পরীক্ষক দুই' }]);
    client.detail.mockImplementation(async (key, id) => (id === 900 ? DETAIL : null));
    const imp = await adapter.importMouza({ ...AREA, surveyId: 2, mouzaId: '72400' });
    expect(imp.expected).toBe(2);
    expect(imp.indexItems).toEqual([{ id: 900, khatianNo: '8' }, { id: 901, khatianNo: '9' }]);
    expect(imp.records).toHaveLength(1);
    expect(imp.records[0].rawIndex).toEqual(INDEX_HIT);
    expect(imp.records[0].rawDetail).toEqual(DETAIL);
    expect(imp.records[0].meta).toMatchObject({ source: 'dlrms', jlId: 238686, surveyKey: 'RS' });
    // The null detail is a failed detail, never a guessed record.
    expect(imp.failedDetails).toHaveLength(1);
    expect(imp.failedDetails[0].indexId).toBe(901);
  });
});

describe('local store: raw in, display out, raw out on request', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const RAW_A = {
    rawIndex: INDEX_HIT, rawDetail: DETAIL, halSabek: [],
    meta: { source: 'dlrms', collectedAt: '2026-11-01T00:00:00.000Z', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' },
  };
  const RAW_B = {
    rawIndex: { ID: 901, KHATIAN_NO: '9', OWNERS: 'পরীক্ষক দুই' },
    rawDetail: { ID: 901, KHATIAN_NO: '9', OWNERS: 'পরীক্ষক দুই', DAGS: '১২৪০, 1241', TOTAL_LAND: '0.1' },
    halSabek: [],
    meta: { source: 'dlrms', collectedAt: '2026-11-02T00:00:00.000Z', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' },
  };
  const FULL_AREA = { ...AREA, mouzaId: '72400', mouza: 'পরীক্ষা মৌজা', jl: '33' };

  test('display search maps at serve time and filters; raw search returns verbatim, filters ignored', async () => {
    const s = createStoreClient({ storeDir: dir });
    await s.upsert({ area: FULL_AREA, surveyKey: 'RS', surveyName: 'আর এস', jlId: 238686, records: [RAW_A, RAW_B], source: 'dlrms' });
    let r = await s.search({ mouzaId: '72400', surveyKey: 'RS', khatianNo: '8' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ id: 900, khatianNo: '8', owners: 'পরীক্ষক এক', dags: '1237', totalLand: '0.0544' });
    expect(r.records[0]).not.toHaveProperty('rawDetail');
    r = await s.search({ mouzaId: '72400', surveyKey: 'RS', ownerName: 'দুই' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('9');
    // Bengali-digit dag query matches the stored Bengali-digit DAGS string.
    r = await s.search({ mouzaId: '72400', surveyKey: 'RS', dagNo: '১২৪০' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('9');
    // And a Latin-digit query matches the same Bengali-digit stored value.
    r = await s.search({ mouzaId: '72400', surveyKey: 'RS', dagNo: '1240' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].khatianNo).toBe('9');
    // Raw mode: whole unit, verbatim, even with a filter that would match nothing.
    r = await s.search({ mouzaId: '72400', surveyKey: 'RS', khatianNo: '999' }, { raw: true });
    expect(r.records).toHaveLength(2);
    expect(r.records[0]).toEqual(RAW_A);
    expect(r.records[1]).toEqual(RAW_B);
    expect(r.collectedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(r.mouzaCollected).toBe(true);
  });

  test('countForUnit counts distinct rawIndex.ID; merge keeps previously stored rows', async () => {
    const s = createStoreClient({ storeDir: dir });
    await s.upsert({ area: FULL_AREA, surveyKey: 'RS', surveyName: 'আর এস', jlId: 238686, records: [RAW_A, RAW_B], source: 'dlrms' });
    expect((await s.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(2);
    // Live subset upsert (merge) must not drop the other record.
    await s.upsert({ area: FULL_AREA, surveyKey: 'RS', surveyName: 'আর এস', jlId: 238686, records: [RAW_A], source: 'dlrms', merge: true });
    expect((await s.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(2);
  });
});

describe('postgres backend (fake pool): raw round-trip', () => {
  test('upsert raw → display search, raw search, count by rawIndex.ID', async () => {
    const backend = createPgBackend(createFakePool());
    const RAW_A = {
      rawIndex: INDEX_HIT, rawDetail: DETAIL, halSabek: [],
      meta: { source: 'dlrms', collectedAt: '2026-11-01T00:00:00.000Z', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' },
    };
    await backend.upsert({
      area: AREA, surveyKey: 'RS', surveyName: 'আর এস', jlId: 238686,
      mouzaId: '72400', jlNumber: '33', records: [RAW_A], source: 'dlrms',
    });
    let r = await backend.search({ jl_id: '238686', survey_key: 'RS' });
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ id: 900, khatianNo: '8', owners: 'পরীক্ষক এক' });
    expect(r.records[0]).not.toHaveProperty('rawDetail');
    r = await backend.search({ jl_id: '238686', survey_key: 'RS' }, { raw: true });
    expect(r.records).toHaveLength(1);
    expect(r.records[0].rawIndex).toEqual(INDEX_HIT);
    expect(r.records[0].rawDetail).toEqual(DETAIL);
    expect((await backend.countForUnit({ jlId: 238686, surveyKey: 'RS' })).count).toBe(1);
    await backend.close();
  });
});

describe('HTTP raw mode through the store server (postgres fake pool)', () => {
  let server; let port;
  const OLD_ENV = { ...process.env };
  beforeAll(async () => {
process.env.STORE_API_KEY = 'raw-test-key-123';
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

  test('client raw search returns stored records verbatim over HTTP', async () => {
    const s = createStoreClient({ storeUrl: 'http://127.0.0.1:' + port, storeKey: 'raw-test-key-123' });
    const RAW_A = {
      rawIndex: INDEX_HIT, rawDetail: DETAIL, halSabek: [],
      meta: { source: 'dlrms', collectedAt: '2026-11-01T00:00:00.000Z', jlId: 238686, surveyKey: 'RS', surveyName: 'আর এস' },
    };
    await s.upsert({ area: AREA, surveyKey: 'RS', surveyName: 'আর এস', jlId: 238686, mouzaId: '72400', records: [RAW_A], source: 'dlrms' });
    const display = await s.search({ mouzaId: '72400', surveyKey: 'RS' });
    expect(display.records).toHaveLength(1);
    expect(display.records[0]).toMatchObject({ id: 900, khatianNo: '8' });
    const raw = await s.search({ mouzaId: '72400', surveyKey: 'RS' }, { raw: true });
    expect(raw.records).toHaveLength(1);
    expect(raw.records[0].rawIndex).toEqual(INDEX_HIT);
    expect(raw.records[0].rawDetail).toEqual(DETAIL);
    expect(raw.records[0].meta.collectedAt).toBe('2026-11-01T00:00:00.000Z');
  });
});
