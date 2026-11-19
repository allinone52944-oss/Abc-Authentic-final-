/**
 * Birth-certificate output — 3 new logics (2026-11-19, user direction;
 * ager all logic bojay thakbe — previous behaviour unchanged):
 *
 * 1. FOREIGN COUNTRY: a birthplace that IS a country other than Bangladesh
 *    prints SINGLE — just that country's name alone, the city/place part
 *    is dropped ("London, United Kingdom" -> "United Kingdom").
 *    Bangladeshi places keep the existing suffix.
 * 2. FORM OVERRIDE + BILINGUAL: a birthplace changed in the form reaches
 *    the output through the SAME normalize path as BDRIS values (titleCase
 *    + country rule), and BOTH Bengali + English birthplace are carried.
 *    (The production form's old single 'pob' field wrote S.record.pob,
 *    which the server ignored — the edit was silently discarded.)
 * 3. NAME CASE AUTO: a name typed in any case in the form prints in the
 *    existing auto case logic (Title Case — NOT uppercase).
 *
 * All values below are synthetic test values (no real person).
 *
 * Run: node --test engines/birth-final/tests/birth-output-logics.test.js
 */
'use strict';

process.env.ABC_JWT_SECRET = 'test-birth-logics-secret';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { app, normalizeBdrisData, normalizePlaceOfBirthEn, normalizePlaceOfBirthBn, toTemplateFields } = require('../server');
const { mintRenderToken, RENDER_TOKEN_HEADER } = require('../../shared/render-token');

const ENGINE_SECRET_HEADER = 'x-engine-secret';
const ENGINE_SECRET = 'test-birth-logics-secret';

describe('logic 1 — foreign country gets no Bangladesh suffix (BDRIS path)', () => {
    it('whole foreign country (En): no suffix', () => {
        const out = normalizeBdrisData({ placeOfBirthEn: 'UNITED KINGDOM', placeOfBirthBn: 'যুক্তরাজ্য' });
        assert.equal(out.placeOfBirthEn, 'United Kingdom');
        assert.equal(out.placeOfBirthBn, 'যুক্তরাজ্য');
    });

    it('city + foreign country (En): SINGLE — only the country name remains', () => {
        const out = normalizeBdrisData({ placeOfBirthEn: 'LONDON, UNITED KINGDOM', placeOfBirthBn: 'লন্ডন, যুক্তরাজ্য' });
        assert.equal(out.placeOfBirthEn, 'United Kingdom');
        assert.equal(out.placeOfBirthBn, 'যুক্তরাজ্য');
    });

    it('other foreign countries (En + Bn): SINGLE country name only', () => {
        assert.equal(normalizePlaceOfBirthEn('INDIA'), 'India');
        assert.equal(normalizePlaceOfBirthEn('DUBAI, UNITED ARAB EMIRATES'), 'United Arab Emirates');
        assert.equal(normalizePlaceOfBirthEn('NEW YORK, UNITED STATES'), 'United States');
        assert.equal(normalizePlaceOfBirthBn('ভারত'), 'ভারত');
        assert.equal(normalizePlaceOfBirthBn('দুবাই, সংযুক্ত আরব আমিরাত'), 'সংযুক্ত আরব আমিরাত');
    });

    it('a bare foreign country acronym still gets no suffix', () => {
        // Title Case is the existing style ("USA" -> "Usa", same as "MD" -> "Md");
        // the rule only pins that no Bangladesh suffix is added.
        assert.equal(normalizePlaceOfBirthEn('USA'), 'Usa');
    });

    it('Bangladeshi places keep the existing suffix (unchanged)', () => {
        const out = normalizeBdrisData({ placeOfBirthEn: 'SIRAJGANJ', placeOfBirthBn: 'সিরাজগঞ্জ' });
        assert.equal(out.placeOfBirthEn, 'Sirajganj, Bangladesh');
        assert.equal(out.placeOfBirthBn, 'সিরাজগঞ্জ, বাংলাদেশ');
    });

    it('already suffixed: no double append; empty: no append', () => {
        assert.equal(normalizePlaceOfBirthEn('DHAKA, BANGLADESH'), 'Dhaka, Bangladesh');
        assert.equal(normalizePlaceOfBirthBn('ঢাকা, বাংলাদেশ'), 'ঢাকা, বাংলাদেশ');
        assert.equal(normalizePlaceOfBirthEn(''), '');
        assert.equal(normalizePlaceOfBirthBn(''), '');
    });
});

describe('logic 2 — form birthplace override + both languages (render path)', () => {
    it('form pobEn/pobBn override the BDRIS values and get the country rule', () => {
        const t = toTemplateFields({
            placeOfBirthEn: 'SIRAJGANJ', placeOfBirthBn: 'সিরাজগঞ্জ',
            pobEn: 'Chattogram', pobBn: 'চট্টগ্রাম',
        });
        assert.equal(t.pobEn, 'Chattogram, Bangladesh');
        assert.equal(t.pobBn, 'চট্টগ্রাম, বাংলাদেশ');
    });

    it('legacy single-field pob (old production form) reaches the output as SINGLE country', () => {
        const t = toTemplateFields({ placeOfBirthEn: 'SIRAJGANJ', pob: 'London, United Kingdom' });
        assert.equal(t.pobEn, 'United Kingdom');
    });

    it('legacy pob does not override an explicit pobEn', () => {
        const t = toTemplateFields({ pobEn: 'Chattogram', pob: 'London' });
        assert.equal(t.pobEn, 'Chattogram, Bangladesh');
    });

    it('form foreign birthplace: SINGLE country name in both languages', () => {
        const t = toTemplateFields({ pobEn: 'london, united kingdom', pobBn: 'লন্ডন, যুক্তরাজ্য' });
        assert.equal(t.pobEn, 'United Kingdom');
        assert.equal(t.pobBn, 'যুক্তরাজ্য');
    });

    it('form birthplace already a single country stays as-is', () => {
        const t = toTemplateFields({ pobEn: 'united kingdom', pobBn: 'যুক্তরাজ্য' });
        assert.equal(t.pobEn, 'United Kingdom');
        assert.equal(t.pobBn, 'যুক্তরাজ্য');
    });

    it('untouched BDRIS values still flow through the same rule', () => {
        const t = toTemplateFields({ placeOfBirthEn: 'SIRAJGANJ', placeOfBirthBn: 'সিরাজগঞ্জ' });
        assert.equal(t.pobEn, 'Sirajganj, Bangladesh');
        assert.equal(t.pobBn, 'সিরাজগঞ্জ, বাংলাদেশ');
    });
});

describe('logic 3 — form-typed names get the existing Title Case (render path)', () => {
    it('lowercase / uppercase / mixed names all print Title Case', () => {
        const t = toTemplateFields({
            nameEn: 'rahim uddin',
            motherEn: 'fatema begum',
            fatherEn: 'ABDUL KARIM',
        });
        assert.equal(t.nameEn, 'Rahim Uddin');
        assert.equal(t.motherEn, 'Fatema Begum');
        assert.equal(t.fatherEn, 'Abdul Karim');
    });

    it('long BDRIS names also normalize (pick + titleCase)', () => {
        const t = toTemplateFields({ motherNameEn: 'FATEMA BEGUM', fatherNameEn: 'abdul karim' });
        assert.equal(t.motherEn, 'Fatema Begum');
        assert.equal(t.fatherEn, 'Abdul Karim');
    });

    it('names are Title Case, never UPPERCASE; Bengali names untouched', () => {
        const t = toTemplateFields({ nameEn: 'RAHIM UDDIN', nameBn: 'মোঃ রহিম উদ্দিন' });
        assert.equal(t.nameEn, 'Rahim Uddin');
        assert.notEqual(t.nameEn, 'RAHIM UDDIN');
        assert.equal(t.nameBn, 'মোঃ রহিম উদ্দিন');
    });
});

describe('integration — /api/preview renders the normalized form values', () => {
    let base;
    let server;

    before(async () => {
        await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        base = 'http://127.0.0.1:' + server.address().port;
    });

    after(async () => {
        await new Promise((resolve) => server.close(resolve));
    });

    const formPayload = (over) => Object.assign({
        office1: 'Test Union Parishad', office2: 'Test, District',
        nameBn: 'মোঃ রহিম উদ্দিন', nameEn: 'rahim uddin',
        dob: '03/01/2000', sex: 'male',
        regDate: '30/09/2026', issueDate: '30/09/2026',
        motherBn: 'মোছাঃ ফাতেমা বেগম', motherEn: 'fatema begum',
        fatherBn: 'মোঃ আব্দুল করিম', fatherEn: 'ABDUL KARIM',
        motherNatBn: 'বাংলাদেশী', motherNatEn: 'Bangladeshi',
        fatherNatBn: 'বাংলাদেশী', fatherNatEn: 'Bangladeshi',
        pobBn: 'লন্ডন, যুক্তরাজ্য', pobEn: 'london, united kingdom',
        permBn: 'পরীক্ষা ঠিকানা', permEn: 'test address',
        verificationCode: 'TEST',
    }, over || {});

    async function postPreview(body) {
        const tok = mintRenderToken('birth', 'u1', 'att-1');
        return fetch(base + '/api/preview', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [ENGINE_SECRET_HEADER]: ENGINE_SECRET, [RENDER_TOKEN_HEADER]: tok },
            body: JSON.stringify(body),
        });
    }

    it('foreign birthplace + lowercase names: HTML shows SINGLE country in both languages', async () => {
        const r = await postPreview(formPayload());
        assert.strictEqual(r.status, 200);
        const b = await r.json();
        assert.strictEqual(b.success, true);
        assert.ok(b.html.includes('United Kingdom'), 'English birthplace present');
        assert.ok(!b.html.includes('London'), 'city part dropped — SINGLE country only');
        assert.ok(!b.html.includes('United Kingdom, Bangladesh'), 'no Bangladesh suffix on foreign birthplace');
        assert.ok(b.html.includes('যুক্তরাজ্য'), 'Bengali birthplace present');
        assert.ok(!b.html.includes('লন্ডন'), 'Bengali city part dropped');
        assert.ok(!b.html.includes('যুক্তরাজ্য, বাংলাদেশ'), 'no বাংলাদেশ suffix on foreign birthplace');
        assert.ok(b.html.includes('Rahim Uddin'), 'name Title Cased');
        assert.ok(b.html.includes('Fatema Begum'), 'mother name Title Cased');
        assert.ok(b.html.includes('Abdul Karim'), 'father name Title Cased');
    });

    it('Bangladeshi birthplace: HTML shows both languages with the suffix', async () => {
        const r = await postPreview(formPayload({ pobEn: 'sirajganj', pobBn: 'সিরাজগঞ্জ' }));
        assert.strictEqual(r.status, 200);
        const b = await r.json();
        assert.ok(b.html.includes('Sirajganj, Bangladesh'), 'English birthplace suffixed');
        assert.ok(b.html.includes('সিরাজগঞ্জ, বাংলাদেশ'), 'Bengali birthplace suffixed');
    });
});
