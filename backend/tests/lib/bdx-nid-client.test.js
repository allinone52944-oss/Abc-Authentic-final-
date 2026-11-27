const { lookupBdxNid } = require('../../lib/bdxNidClient');

const input = { type: 'backup', nid: '0000000000', dob: '1901-02-03', apiKey: 'test-only-key' };
const identity = { name: 'পরীক্ষার রেকর্ড', nationalId: input.nid, dateOfBirth: input.dob };

function reply(response, httpStatus = 200, status = 200) {
  return new Response(JSON.stringify({ http_status: httpStatus, response }), { status });
}

describe('BD-X NID adapter', () => {
  test.each([
    ['backup', '/api-portal/api/s-v-becup.php'],
    ['premium', '/api-portal/api/sv-copy.php'],
    ['half', '/api-portal/api/sv-half.php'],
  ])('routes %s to the documented HTTPS endpoint', async (type, endpoint) => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ status: 'success', data: identity }));
    await expect(lookupBdxNid({ ...input, type }, fetchImpl)).resolves.toMatchObject({
      nationalId: input.nid,
      dateOfBirth: input.dob,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [[url, opts]] = fetchImpl.mock.calls;
    expect(url.origin).toBe('https://api.bd-x.com');
    expect(url.pathname).toBe(endpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({ key: input.apiKey, nid: input.nid, dob: input.dob });
    expect(opts).toMatchObject({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) });
  });

  test('normalizes the nested record and exposes only the allowed fields', async () => {
    const fetchImpl = async () => reply({ status: 'success', data: {
      ...identity,
      nameEn: 'Example Record',
      father: 'Fictional Father',
      mother: 'Fictional Mother',
      dateOfBirth: '০৩-০২-১৯০১',
      presentAddress: { addressLine: 'Example Address', district: 'Unused' },
      permanentAddress: { villageOrRoad: 'Example Road', district: 'Example District' },
      photo: 'https://example.invalid/photo',
      religion: 'Private field',
    } });
    await expect(lookupBdxNid(input, fetchImpl)).resolves.toEqual({
      nameBn: identity.name,
      nameEn: 'Example Record',
      fatherName: 'Fictional Father',
      motherName: 'Fictional Mother',
      nationalId: input.nid,
      pin: '',
      dateOfBirth: input.dob,
      gender: '',
      presentAddress: 'Example Address',
      permanentAddress: 'Example Road, Example District',
    });
  });

  test('accepts the documented flat record matched by PIN and omits half-copy addresses', async () => {
    const fetchImpl = async () => reply({
      nameBn: identity.name, fatherName: 'Example', nationalId: '0000000001',
      pin: '00000000000000000', dateOfBirth: input.dob, presentAddress: 'Private address',
    });
    const result = await lookupBdxNid({ ...input, type: 'half', nid: '00000000000000000' }, fetchImpl);
    expect(result).toMatchObject({ nameBn: identity.name, pin: '00000000000000000' });
    expect(result).not.toHaveProperty('presentAddress');
    expect(result).not.toHaveProperty('permanentAddress');
  });

  test.each([
    { nationalId: '0000000001' },
    { dateOfBirth: '1901-02-04' },
    { name: '' },
  ])('rejects unmatched or incomplete data %#', async invalid => {
    const fetchImpl = async () => reply({ status: 'success', data: { ...identity, ...invalid } });
    await expect(lookupBdxNid(input, fetchImpl)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  test('separates an explicit no-record response from unknown provider errors', async () => {
    await expect(lookupBdxNid(input, async () => reply({ status: 'not_found' }, 404, 404)))
      .rejects.toMatchObject({ code: 'record_not_found' });
    await expect(lookupBdxNid(input, async () => reply({ status: 'error' })))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  test('does not forward the credential or lookup values in failed request errors', async () => {
    const failure = lookupBdxNid(input, async url => { throw new Error(`Request failed ${url}`); });
    await expect(failure).rejects.toThrow(/^provider_unavailable$/);
    await expect(failure).rejects.not.toHaveProperty('cause');
  });

  test('rejects an over-limit body even when content-length is absent', async () => {
    const oversized = new Response(new Uint8Array(4 * 1024 * 1024 + 1));
    await expect(lookupBdxNid(input, async () => oversized))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  test('never calls the provider for an unrecognized product or invalid date', async () => {
    const fetchImpl = jest.fn();
    await expect(lookupBdxNid({ ...input, type: '__proto__' }, fetchImpl))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    await expect(lookupBdxNid({ ...input, dob: '1901-02-29' }, fetchImpl))
      .rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
