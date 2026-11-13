// UNION-WARD (2026-11-13): "কক্সবাজার সদর" must be walked as the upazila,
// never as the shorter city/paurasava entry "কক্সবাজার" that loosely
// matches it — that mistake made every union's ward list fail.
// Run: node --test engines/bdris-apply/v2/tests/union-exact-upazila.test.js
'use strict';
const { it } = require('node:test');
const assert = require('node:assert');
const { HttpGeoService } = require('../services/HttpGeoService');

function client() {
  const t = {
    '1|1|1': [[{ id: 2, nameBn: 'চট্টগ্রাম' }], 2],
    '2|2|2': [[{ id: 22, nameBn: 'কক্সবাজার' }], 3],
    '22|3|8': [[{ id: 184, nameBn: 'কক্সবাজার' }], 5],
    '22|3|3': [[{ id: 900, nameBn: 'কক্সবাজার সদর' }], 4],
    '900|4|5': [[{ id: 901, nameBn: 'পি.এম.খালী' }], 7],
    '901|7|13': [[{ id: 902, nameBn: 'ওয়ার্ড নং-০১' }], 8],
  };
  return { bootstrapped: true, async bootstrap() {}, async getGeo(p, o, ty) {
    const r = t[[p, o, ty].join('|')];
    return r ? { entries: r[0], targetGeoOrder: r[1] } : { entries: [], targetGeoOrder: o + 1 };
  } };
}
const parents = { division: 'চট্টগ্রাম', district: 'কক্সবাজার', upazila: 'কক্সবাজার সদর', zone: 'পি.এম.খালী' };

it('exact upazila name wins over a loosely matching city entry', async () => {
  const r = await new HttpGeoService({ client: client() }).walkToUpazila(parents, 'birth');
  assert.strictEqual(r.upazilaEntry.id, 900);
  assert.strictEqual(r.isCityCorp, false);
});
it('a union under that upazila now returns its wards', async () => {
  const r = await new HttpGeoService({ client: client() }).getWardOptions(parents, 'birth');
  assert.deepStrictEqual(r.options.map((o) => o.name), ['ওয়ার্ড নং-০১']);
});
