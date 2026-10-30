// Mouza wizard rate card (GET /api/land/mouza-rates): the whole
// mouza's rates in ONE call, structured miss reasons, thana
// question flow. The single-class /mouza-rate endpoint keeps
// working unchanged (regression test at the end). No portal,
// no real money — mocked DB like land-mouza-batch1.test.js.
jest.mock('../../db', () => require('../helpers/mockDb').createDbMock());
jest.mock('../../../engines/land-core/client', () => ({
  divisions: jest.fn(), districts: jest.fn(), upazilas: jest.fn(),
  surveys: jest.fn(), upazilaSurveys: jest.fn(), jlNumbers: jest.fn(),
  indexList: jest.fn(), indexByKhatianNo: jest.fn(), detail: jest.fn(),
  halSabek: jest.fn(),
}));
jest.mock('../../utils/whatsapp', () => ({
  notifyServiceCompleted: jest.fn().mockResolvedValue({ ok: true }),
  notifyServiceFailed: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../../utils/push', () => ({
  notifyAdmins: jest.fn().mockResolvedValue({ ok: true }),
  notifyUser: jest.fn().mockResolvedValue({ ok: true }),
}));

const express = require('express');
const request = require('supertest');
const auth = require('../../auth');
const landRouter = require('../../routes/land');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/land', landRouter);
  return a;
}
const token = () => auth.signAccess({ id: 'u1', role: 'user' });
const withUser = (req) => req.set('Authorization', 'Bearer ' + token());
const card = (office, mouza, thana) =>
  '/api/land/mouza-rates?office=' + encodeURIComponent(office) +
  '&mouza=' + encodeURIComponent(mouza) +
  (thana ? '&thana=' + encodeURIComponent(thana) : '');

describe('GET /api/land/mouza-rates: whole-mouza rate card', () => {
  test('full card for a covered mouza: all classes, nulls where the table has none', async () => {
    const r = await withUser(request(app()).get(card('boalkhali', 'কধুরখীল')));
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(true);
    expect(r.body.officeName).toBe('বোয়ালখালী');
    expect(r.body.period).toBe('2025-2026');
    expect(r.body.rates['নাল'].rate).toBe(121421);
    expect(r.body.rates['বাড়ী'].rate).toBe(157248);
    expect(r.body.rates['ভিটা'].rate).toBe(140752);
    expect(r.body.rates['বাগান'].rate).toBe(147838);
    expect(r.body.rates['পুকুর'].rate).toBe(109707);
    expect(r.body.rates['ডোবা'].rate).toBe(100000);
    expect(r.body.rates['ডোবা'].p).toBe(true);
    // বাণিজ্যিক has no lookup rate anywhere — null, never 0.
    expect(r.body.rates['বাণিজ্যিক'].rate).toBeNull();
  });

  test('class with no table rate is null (not 0) while siblings work', async () => {
    const r = await withUser(request(app()).get(card('rangunia', 'পোমরা')));
    expect(r.body.found).toBe(true);
    expect(r.body.rates['বাড়ী'].rate).toBeNull();
    expect(r.body.rates['নাল'].rate).toBe(158896);
    expect(r.body.rates['ভিটা'].rate).toBe(262475);
  });

  test('Sandwip pouro value rides on the পুকুর entry, gram stays the rate', async () => {
    const r = await withUser(request(app()).get(card('sandwip', 'কাহিয়াপাড়')));
    expect(r.body.found).toBe(true);
    expect(r.body.rates['পুকুর'].rate).toBe(39902);
    expect(r.body.rates['পুকুর'].pouroPukur).toBe(59266);
    expect(r.body.rates['পুকুর'].pouroNote).toContain('59266');
    // Other classes carry no pouro note.
    expect(r.body.rates['নাল'].pouroPukur).toBeUndefined();
  });

  test('ambiguous mouza without thana → options; with thana → exact card', async () => {
    const amb = await withUser(request(app()).get(card('chandgaon', 'বাকলিয়া')));
    expect(amb.body.found).toBe(false);
    expect(amb.body.ambiguous).toBe(true);
    expect(amb.body.options.sort()).toEqual(['চান্দগাঁও', 'বদর', 'পাঁচলাইশ'].sort());
    const one = await withUser(request(app()).get(card('chandgaon', 'বাকলিয়া', 'বদর')));
    expect(one.body.found).toBe(true);
    expect(one.body.thana).toBe('বদর');
    expect(one.body.rates['নাল'].rate).toBe(693896);
    expect(one.body.rates['ডোবা'].rate).toBeNull();
  });

  test('uncovered office → OFFICE_NOT_COVERED, never an error', async () => {
    const r = await withUser(request(app()).get(card('sadar', 'কোনো মৌজা')));
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(false);
    expect(r.body.miss).toBe('OFFICE_NOT_COVERED');
    expect(r.body.message).toContain('তালিকা এখনো যোগ হয়নি');
  });

  test('covered office + unknown mouza → MOUZA_NOT_IN_TABLE', async () => {
    const r = await withUser(request(app()).get(card('boalkhali', 'শাকপুরা')));
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(false);
    expect(r.body.miss).toBe('MOUZA_NOT_IN_TABLE');
    expect(r.body.message).toContain('তালিকায় নেই');
  });

  test('thana matching no variant → THANA_NOT_MATCHED', async () => {
    const r = await withUser(request(app()).get(card('chandgaon', 'বাকলিয়া', 'ভুল থানা')));
    expect(r.body.found).toBe(false);
    expect(r.body.miss).toBe('THANA_NOT_MATCHED');
  });

  test('missing params → 400', async () => {
    const r = await withUser(request(app()).get('/api/land/mouza-rates?office=boalkhali'));
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('BAD_INPUT');
  });

  test('old single-class /mouza-rate endpoint still works unchanged', async () => {
    const r = await withUser(request(app()).get(
      '/api/land/mouza-rate?office=boalkhali&mouza=' + encodeURIComponent('কধুরখীল') + '&class=' + encodeURIComponent('নাল')));
    expect(r.status).toBe(200);
    expect(r.body.found).toBe(true);
    expect(r.body.rate).toBe(121421);
    const miss = await withUser(request(app()).get(
      '/api/land/mouza-rate?office=boalkhali&mouza=' + encodeURIComponent('কধুরখীল') + '&class=' + encodeURIComponent('বাণিজ্যিক')));
    expect(miss.body.found).toBe(false);
  });
});
