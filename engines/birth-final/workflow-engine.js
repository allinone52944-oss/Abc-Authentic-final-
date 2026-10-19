'use strict';
/**
 * workflow-engine.js - SAMPURNA WORKFLOW engine (existing logic reuse only,
 * kono purono logic-e haat deoa hoy na - shudhu notun file).
 * Full workflow engine (reuses existing logic only, touches nothing old).
 *
 *   const wf = require('./workflow-engine');
 *   const out = await wf.createRecord({ number, name?, url?, data? });
 *   // out.record      { number, name, key, keySource, code, verifyUrl }
 *   // out.certificate { html, png, pdf }      (replica-look, fresh render)
 *   // out.saved       { savedTo: 'oracle'|'file' }
 *
 *   const got = await wf.getRecord(number);   // stored + fresh engine codes
 *   // got.record { number, name, key, verifyUrl, payload, ... }
 *   // got.engine { key, code, verifyUrl, qr, barcode } (dataUrls included)
 */
const engine = require('./engine');
const store = require('./store');
const builder = require('./certificate-builder');

async function createRecord(input) {
    input = input || {};
    const number = String(input.number || '').trim();
    if (!number) throw new Error('number is required');
    const data = input.data || input.payload || {};

    // 1. engine codes (official URL thakle seta, nahole engine key)
    const built = await engine.build({ number, url: input.url });

    // 2. full certificate (replica layout, fresh render)
    const record = Object.assign({}, data, {
        brn: number,
        verificationUrl: built.verifyUrl,
        verificationCode: data.verificationCode || built.code
    });
    const certificate = await builder.buildCertificate(record);

    // 3. store (Oracle thakle Oracle, nahole file)
    const saved = await store.saveRecord({
        number,
        name: input.name || data.nameEn || null,
        key: built.key,
        verifyUrl: built.verifyUrl,
        keySource: built.keySource,
        payload: data
    });

    return {
        record: { number, name: input.name || data.nameEn || null, key: built.key,
                  keySource: built.keySource, code: data.verificationCode || built.code,
                  verifyUrl: built.verifyUrl },
        certificate,
        saved
    };
}

async function getRecord(number) {
    const rec = await store.getRecord(number);
    if (!rec) return null;
    const built = await engine.build({ number: rec.number, url: rec.verifyUrl || undefined });
    return { record: rec, engine: built };
}

module.exports = { createRecord, getRecord };
