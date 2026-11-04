// Adapter unit tests for engines/land-khatian/adapter.js.
// The land-core client is mocked — no real portal calls.
// All owner names below are synthetic placeholders, never
// values copied from a live portal response.
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
  ownerMatches: (owners, name) => String(owners || '').includes(String(name || '').trim()),
  sumLand: (ds) => Math.round(ds.reduce((a, d) => a + (parseFloat(d.TOTAL_LAND) || 0), 0) * 10000) / 10000,
}));

const client = require('../../../engines/land-core/client');
const adapter = require('../../../engines/land-khatian/adapter');

const AREA = { divisionBbs: '30', districtBbs: '26', upazilaBbs: '48' };

function offered(surveys) {
  client.surveys.mockResolvedValue(surveys);
  client.upazilaSurveys.mockResolvedValue(
    surveys.map((s) => ({ SURVEY_ID: s.ID, LOCAL_NAME: s.NAME }))
  );
}
function jl(rows) {
  client.jlNumbers.mockResolvedValue(rows);
}
function portalError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  client.halSabek.mockResolvedValue([]);
});

describe('khatianNo path', () => {
  test('index hit → detail → normalized item, hal-sabek attached', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400, MOUZA_NAME: 'পরীক্ষা মৌজা', JL_NUMBER: '33' }]);
    client.indexByKhatianNo.mockResolvedValue([{ ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক' }]);
    client.detail.mockResolvedValue({ ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক', DAGS: '1237', TOTAL_LAND: '0.0544' });
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', khatianNo: '8' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({
      id: 900, khatianNo: '8', owners: 'পরীক্ষক এক', dags: '1237',
      totalLand: '0.0544', surveyKey: 'RS', surveyName: 'আর এস', jlId: 238686, halSabek: [],
    });
    expect(r.capped).toBe(false);
  });

  test('survey key comes from the portal list, never the client hint', async () => {
    offered([{ ID: 9, KEY: 'ZZ', NAME: 'পরীক্ষা জরিপ' }]);
    jl([{ ID: 111, MOUZA_ID: 72400 }]);
    client.indexByKhatianNo.mockResolvedValue([{ ID: 901, KHATIAN_NO: '5', OWNERS: 'পরীক্ষক এক' }]);
    client.detail.mockResolvedValue({ ID: 901, KHATIAN_NO: '5', OWNERS: 'পরীক্ষক এক', DAGS: '10', TOTAL_LAND: '0.1' });
    const r = await adapter.search({ ...AREA, surveyId: 9, surveyKey: 'RS', mouzaId: '72400', khatianNo: '5' });
    expect(client.indexByKhatianNo).toHaveBeenCalledWith('ZZ', 111, '5');
    expect(r.items[0].surveyKey).toBe('ZZ');
  });

  test('survey not offered in this upazila → SURVEY_NOT_OFFERED', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    await expect(adapter.search({ ...AREA, surveyId: 3, mouzaId: '72400', khatianNo: '8' }))
      .rejects.toMatchObject({ code: 'SURVEY_NOT_OFFERED' });
  });

  test('jlId absent from the realtime list → JL_NOT_FOUND', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400 }]);
    await expect(adapter.search({ ...AREA, surveyId: 2, jlId: '999999', khatianNo: '8' }))
      .rejects.toMatchObject({ code: 'JL_NOT_FOUND' });
    expect(client.indexByKhatianNo).not.toHaveBeenCalled();
  });

  test('no criterion → NO_SEARCH_CRITERION, no portal index call', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    await expect(adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400' }))
      .rejects.toMatchObject({ code: 'NO_SEARCH_CRITERION' });
  });
});

describe('owner-name / dag local filters', () => {
  function listSetup() {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400 }]);
    client.indexList.mockResolvedValue([
      { ID: 1, KHATIAN_NO: '1', OWNERS: 'পরীক্ষক এক' },
      { ID: 2, KHATIAN_NO: '2', OWNERS: 'পরীক্ষক দুই' },
      { ID: 3, KHATIAN_NO: '3', OWNERS: 'পরীক্ষক এক, পরীক্ষক তিন' },
    ]);
    client.detail.mockImplementation(async (key, id) => ({
      1: { ID: 1, KHATIAN_NO: '1', OWNERS: 'পরীক্ষক এক', DAGS: '100', TOTAL_LAND: '0.2' },
      2: { ID: 2, KHATIAN_NO: '2', OWNERS: 'পরীক্ষক দুই', DAGS: '200', TOTAL_LAND: '0.3' },
      3: { ID: 3, KHATIAN_NO: '3', OWNERS: 'পরীক্ষক এক, পরীক্ষক তিন', DAGS: '300', TOTAL_LAND: '0.4' },
    }[id]));
  }

  test('owner filter is local: only matching index rows get detail', async () => {
    listSetup();
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', ownerName: 'পরীক্ষক এক' });
    expect(r.items.map((i) => i.khatianNo)).toEqual(['1', '3']);
    expect(client.detail).toHaveBeenCalledTimes(2);
  });

  test('dag filter applies on the detail record', async () => {
    listSetup();
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', dagNo: '200' });
    expect(r.items.map((i) => i.khatianNo)).toEqual(['2']);
  });

  test('dag filter is an EXACT token match: a part-number never matches (2026-11-04)', async () => {
    listSetup();
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', dagNo: '20' });
    expect(r.items).toEqual([]);
  });

  test('dag filter normalizes Bengali digits before the exact match', async () => {
    listSetup();
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', dagNo: '২০০' });
    expect(r.items.map((i) => i.khatianNo)).toEqual(['2']);
  });

  test('owner + dag combined', async () => {
    listSetup();
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', ownerName: 'পরীক্ষক এক', dagNo: '300' });
    expect(r.items.map((i) => i.khatianNo)).toEqual(['3']);
  });

  test('detail cap 50: 60 candidates → 50 items, capped, totalCandidates 60', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400 }]);
    const rows = Array.from({ length: 60 }, (_, i) => ({ ID: 100 + i, KHATIAN_NO: String(i + 1), OWNERS: 'পরীক্ষক এক' }));
    client.indexList.mockResolvedValue(rows);
    client.detail.mockImplementation(async (key, id) => ({
      ID: id, KHATIAN_NO: String(id - 99), OWNERS: 'পরীক্ষক এক', DAGS: '1', TOTAL_LAND: '0.1',
    }));
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', ownerName: 'পরীক্ষক এক' });
    expect(r.items).toHaveLength(50);
    expect(r.capped).toBe(true);
    expect(r.totalCandidates).toBe(60);
    expect(client.detail).toHaveBeenCalledTimes(50);
  });
});

describe('all-surveys iteration', () => {
  test('khatian found only in the second offered survey', async () => {
    offered([{ ID: 1, KEY: 'CS', NAME: 'সি এস' }, { ID: 4, KEY: 'BS', NAME: 'বি এস' }]);
    client.jlNumbers.mockImplementation(async (d, u, sid) => [{ ID: 500 + sid, MOUZA_ID: 72400 }]);
    client.indexByKhatianNo.mockImplementation(async (key) => (key === 'BS' ? [{ ID: 950, KHATIAN_NO: '7', OWNERS: 'পরীক্ষক এক' }] : []));
    client.detail.mockResolvedValue({ ID: 950, KHATIAN_NO: '7', OWNERS: 'পরীক্ষক এক', DAGS: '55', TOTAL_LAND: '1.0' });
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', khatianNo: '7' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ surveyKey: 'BS', khatianNo: '7' });
    expect(r.surveysTried).toEqual(['CS', 'BS']);
  });
});

describe('hal-sabek best-effort', () => {
  test('hal-sabek failure still returns the summary', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400 }]);
    client.indexByKhatianNo.mockResolvedValue([{ ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক' }]);
    client.detail.mockResolvedValue({ ID: 900, KHATIAN_NO: '8', OWNERS: 'পরীক্ষক এক', DAGS: '1237', TOTAL_LAND: '0.0544' });
    client.halSabek.mockRejectedValue(portalError('LAND_API_ERROR'));
    const r = await adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', khatianNo: '8' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].halSabek).toEqual([]);
  });
});

describe('mutation passthrough (conditional, unproven)', () => {
  test('portal returns 0 items → empty, not-found, no error', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400 }]);
    client.indexByKhatianNo.mockResolvedValue([]);
    const r = await adapter.search({ ...AREA, surveyId: 'mutation', mouzaId: '72400', khatianNo: '8' });
    expect(r.items).toEqual([]);
    expect(r.mutationAttempted).toBe(true);
    expect(r.mutationUnsupported).toBe(false);
    expect(client.indexByKhatianNo).toHaveBeenCalledWith('MUTATION', 238686, '8');
  });

  test("portal 400 'Survey Is Not Valid' → empty + mutationUnsupported", async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400 }]);
    client.indexByKhatianNo.mockRejectedValue(new Error("LAND_API_ERROR (HTTP 400): 'Survey Is Not Valid'"));
    const r = await adapter.search({ ...AREA, surveyId: 'mutation', mouzaId: '72400', khatianNo: '8' });
    expect(r.items).toEqual([]);
    expect(r.mutationUnsupported).toBe(true);
  });
});

describe('portal errors propagate typed', () => {
  test('index failure → LAND_UNREACHABLE (route turns it into 502, no charge)', async () => {
    offered([{ ID: 2, KEY: 'RS', NAME: 'আর এস' }]);
    jl([{ ID: 238686, MOUZA_ID: 72400 }]);
    client.indexByKhatianNo.mockRejectedValue(portalError('LAND_UNREACHABLE'));
    await expect(adapter.search({ ...AREA, surveyId: 'all', mouzaId: '72400', khatianNo: '8' }))
      .rejects.toMatchObject({ code: 'LAND_UNREACHABLE' });
  });
});
