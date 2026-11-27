const { lookupBdxNid } = require('../../lib/bdxNidClient');

const input = { type: 'backup', nid: '0000000000', dob: '1901-02-03', apiKey: 'test-only-key' };
const identity = { name: 'পরীক্ষার রেকর্ড', nationalId: input.nid, dateOfBirth: input.dob };
const addresses = { presentAddress: 'Current Sample Address', permanentAddress: 'Permanent Sample Address' };

function reply(response, httpStatus = 200, status = 200) {
  return new Response(JSON.stringify({ http_status: httpStatus, response }), { status });
}

describe('BD-X NID adapter', () => {
  test.each([
    ['backup', '/api-portal/api/s-v-becup.php'],
    ['premium', '/api-portal/api/of-sv-copy.php'],
    ['half', '/api-portal/api/sv-half.php'],
  ])('routes %s to the documented HTTPS endpoint', async (type, endpoint) => {
    const data = type === 'premium' ? { ...identity, ...addresses } : identity;
    const fetchImpl = jest.fn().mockResolvedValue(reply({ status: 'success', data }));
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

  test('enriches the Premium address line with useful structured fields and keeps both addresses separate', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ status: 'success', data: {
      ...identity,
      presentAddress: {
        addressLine: 'Current Sample Road, Current Sample District',
        villageOrRoad: 'Current Sample Road',
        district: 'Current Sample District',
        upazila: 'Current Sample Upazila',
        postOffice: 'Current Sample Post Office',
        postCode: '0000',
        mouzaMoholla: 'Current Sample Mouza',
        region: 'Current Sample Region',
      },
      permanentAddress: {
        villageOrRoad: 'Permanent Sample Road',
        upozila: 'Permanent Sample Upazila',
        district: 'Permanent Sample District',
      },
      photo: 'https://example.invalid/photo',
      religion: 'Private field',
    } }));
    const record = await lookupBdxNid({ ...input, type: 'premium' }, fetchImpl);
    expect(record.presentAddress).toContain('Current Sample Road, Current Sample District');
    expect(record.presentAddress.match(/Current Sample District/g)).toHaveLength(1);
    for (const part of ['Current Sample Upazila', 'Current Sample Post Office', '0000', 'Current Sample Mouza', 'Current Sample Region']) {
      expect(record.presentAddress).toContain(part);
    }
    for (const part of ['Permanent Sample Road', 'Permanent Sample Upazila', 'Permanent Sample District']) {
      expect(record.permanentAddress).toContain(part);
    }
    expect(record.presentAddress).not.toContain('Permanent Sample');
    expect(record.permanentAddress).not.toContain('Current Sample');
    expect(record).not.toHaveProperty('photo');
    expect(record).not.toHaveProperty('religion');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('keeps a complete Premium address line without adding the same postal code in another script', async () => {
    const addressLine = 'Sample Road, Sample Post Office ০০০০, Sample District';
    const fetchImpl = async () => reply({ status: 'success', data: {
      ...identity,
      ...addresses,
      presentAddress: {
        addressLine, villageOrRoad: 'Sample Road', postOffice: 'Sample Post Office',
        postCode: '0000', district: 'Sample District',
      },
    } });
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl))
      .resolves.toMatchObject({ presentAddress: addressLine });
  });

  test.each([
    ['presentAddress', null],
    ['permanentAddress', {}],
    ['presentAddress', '-'],
    ['permanentAddress', { addressLine: '—', district: 'N/A' }],
  ])('rejects an unavailable Premium %s %# without another provider call', async (field, value) => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ status: 'success', data: {
      ...identity, ...addresses, [field]: value,
    } }));
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).rejects.toMatchObject({ code: 'address_incomplete' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('checks Premium identity before returning the address result', async () => {
    const fetchImpl = async () => reply({ status: 'success', data: {
      ...identity, ...addresses, nationalId: '0000000001',
    } });
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).rejects.toMatchObject({ code: 'provider_unavailable' });
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
