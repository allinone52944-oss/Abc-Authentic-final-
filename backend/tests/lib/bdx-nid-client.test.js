const { lookupBdxNid } = require('../../lib/bdxNidClient');

const input = { type: 'backup', nid: '0000000000', dob: '1901-02-03', apiKey: 'test-only-key' };
const identity = { name: 'পরীক্ষার রেকর্ড', nationalId: input.nid, dateOfBirth: input.dob };
const addresses = { presentAddress: 'Current Sample Address', permanentAddress: 'Permanent Sample Address' };

function reply(response, httpStatus = 200, status = 200, metadata = {}) {
  return new Response(JSON.stringify({ ...metadata, http_status: httpStatus, response }), { status });
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
  ])('keeps the other Premium address when %s is unavailable %#', async (field, value) => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ status: 'success', data: {
      ...identity, ...addresses, [field]: value,
    } }, 200, 200, { charged: false, amount: 0 }));
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).resolves.toMatchObject({
      nationalId: input.nid, dateOfBirth: input.dob, ...addresses, [field]: '',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('returns verified Premium identity data from cache without any address', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({ status: 'success', data: identity }, 200, 200, {
      charged: false, from_cache: true, amount: 0,
    }));
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).resolves.toMatchObject({
      nationalId: input.nid, dateOfBirth: input.dob, presentAddress: '', permanentAddress: '',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('queries the previous Premium endpoint once after an explicitly free miss using the same deadline', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(reply({ status: 'not_found', data: null }, 404, 404, { charged: false, amount: 0 }))
      .mockResolvedValueOnce(reply({ status: 'success', data: {
        ...identity, presentAddress: { villageOrRoad: 'Fallback Sample Road', upazila: 'Fallback Sample Upazila' },
      } }, 200, 200, { charged: true, amount: 24 }));
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).resolves.toMatchObject({
      nationalId: input.nid, presentAddress: 'Fallback Sample Road, Fallback Sample Upazila', permanentAddress: '',
    });
    expect(fetchImpl.mock.calls.map(([url]) => url.pathname)).toEqual([
      '/api-portal/api/of-sv-copy.php', '/api-portal/api/sv-copy.php',
    ]);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(url.origin).toBe('https://api.bd-x.com');
      expect(Object.fromEntries(url.searchParams)).toEqual({ key: input.apiKey, nid: input.nid, dob: input.dob });
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', signal: fetchImpl.mock.calls[0][1].signal });
      expect(options.signal).toBe(fetchImpl.mock.calls[0][1].signal);
    }
  });

  test.each([true, false])('returns the fallback miss with its own debit status %s and makes no third call', async charged => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(reply({ status: 'not_found' }, 200, 200, { charged: false }))
      .mockResolvedValueOnce(reply({ status: 'not_found' }, 404, 404, { charged }));
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).rejects.toMatchObject({
      code: 'record_not_found', providerCharged: charged,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test.each([
    [{ status: 'not_found' }, {}, 200, 'record_not_found'],
    [{ status: 'not_found' }, { charged: 'false' }, 200, 'record_not_found'],
    [{ status: 'not_found' }, { charged: false, amount: 24 }, 200, 'record_not_found'],
    [{ status: 'not_found', data: identity }, { charged: false }, 200, 'record_not_found'],
    [{ status: 'not_found', ...identity }, { charged: false }, 200, 'record_not_found'],
    [{ status: 'not_found', presentAddress: 'Partial Sample Address' }, { charged: false }, 200, 'record_not_found'],
    [{ status: 'error' }, { charged: false }, 503, 'provider_unavailable'],
    [{ status: 'success', data: { ...identity, nationalId: '0000000001' } }, { charged: false }, 200, 'provider_unavailable'],
  ])('does not fall back after an ambiguous or unavailable Premium result %#', async (response, metadata, status, code) => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(reply(response, status, status, metadata));
    const failed = lookupBdxNid({ ...input, type: 'premium' }, fetchImpl);
    await expect(failed).rejects.toMatchObject({ code });
    await expect(failed).rejects.not.toHaveProperty('providerCharged');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('checks Premium identity before returning the address result', async () => {
    const fetchImpl = async () => reply({ status: 'success', data: {
      ...identity, ...addresses, nationalId: '0000000001',
    } });
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  test.each([
    [200, 200, 'record_not_found'],
    [404, 404, 'record_not_found'],
    [502, 500, 'provider_unavailable'],
  ])('confirms Premium debit on HTTPS %s with provider status %s without leaking the response', async (status, httpStatus, code) => {
    const fetchImpl = jest.fn().mockResolvedValue(reply({
      status: 'not_found', message: 'Private response body',
    }, httpStatus, status, { charged: true, from_cache: false, amount: 24 }));
    const failed = lookupBdxNid({ ...input, type: 'premium' }, fetchImpl);
    await expect(failed).rejects.toMatchObject({ message: code, code, providerCharged: true });
    await expect(failed).rejects.not.toHaveProperty('cause');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('confirms a Premium debit without returning an unmatched record', async () => {
    const fetchImpl = async () => reply({ status: 'success', data: {
      ...identity, ...addresses, nationalId: '0000000001',
    } }, 200, 200, { charged: true });
    await expect(lookupBdxNid({ ...input, type: 'premium' }, fetchImpl)).rejects.toMatchObject({
      message: 'provider_unavailable', code: 'provider_unavailable', providerCharged: true,
    });
  });

  test.each([
    { http_status: 502, response: {}, charged: false },
    { http_status: 502, response: {}, charged: 'true' },
    { http_status: 502, response: {}, charged: true, from_cache: true },
    { http_status: 502, response: {}, charged: true, amount: 0 },
    { http_status: '502', response: {}, charged: true },
    { http_status: 502, charged: true },
  ])('does not confirm a Premium debit from ambiguous or malformed envelopes %#', async payload => {
    const fetchImpl = async () => new Response(JSON.stringify(payload), { status: 502 });
    const failed = lookupBdxNid({ ...input, type: 'premium' }, fetchImpl);
    await expect(failed).rejects.toThrow(/^provider_unavailable$/);
    await expect(failed).rejects.not.toHaveProperty('providerCharged');
  });

  test('does not confirm a Premium debit from unreadable JSON or a failed connection', async () => {
    const malformed = lookupBdxNid({ ...input, type: 'premium' }, async () =>
      new Response('{"charged":true', { status: 502 }));
    const disconnected = lookupBdxNid({ ...input, type: 'premium' }, async url => {
      throw new Error('Connection failed: ' + url);
    });
    for (const failed of [malformed, disconnected]) {
      await expect(failed).rejects.toThrow(/^provider_unavailable$/);
      await expect(failed).rejects.not.toHaveProperty('providerCharged');
    }
  });

  test.each(['backup', 'half'])('retains the existing %s error contract even if the provider reports a debit', async type => {
    const fetchImpl = async () => reply({ status: 'not_found' }, 404, 404, { charged: true });
    const failed = lookupBdxNid({ ...input, type }, fetchImpl);
    await expect(failed).rejects.toThrow(/^record_not_found$/);
    await expect(failed).rejects.not.toHaveProperty('providerCharged');
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
