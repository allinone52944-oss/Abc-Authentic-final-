'use strict';
/**
 * certificate-builder.js - SAMPURNA birth certificate builder engine.
 * Ekta record dao, puro certificate nao (HTML + PNG + PDF) - 1 call-e.
 * Give one record, get the complete certificate - in one call.
 *
 *   const builder = require('./certificate-builder');
 *   const out = await builder.buildCertificate(record);
 *   // out.html   - replica-look certificate HTML (Studio preview jeta dekhae)
 *   // out.png    - PNG preview (794x1123)
 *   // out.pdf    - A4 PDF buffer (VECTOR text, @page A4, ~486 KB)
 *   // out.engine - { key, code, verifyUrl, keySource } (shared cert-engine)
 *
 * record shape (shob optional; sample-payload.json dekho):
 *   { brn, office1, office2, verificationCode, verificationUrl,
 *     regDate, issueDate, dob, dobWords, sex,
 *     ...birth fields (nameBn/En, mother*, father*, pob*, perm*)... }
 * opts: { html=true, png=true, pdf=true }
 */
const puppeteer = require('puppeteer');
const engine = require('./engine');
const server = require('./server');

async function buildCertificate(record, opts) {
    record = record || {};
    opts = opts || {};
    const wantHtml = opts.html !== false;
    const wantPng = opts.png !== false;
    const wantPdf = opts.pdf !== false;

    const assets = await server.buildAssets(record);
    const html = server.buildCertificateHtml(record, assets);

    const brnText = String(record.brn || '').trim();
    const eng = brnText
        ? await engine.build({ number: brnText, url: record.verificationUrl || undefined })
        : { number: '', key: null, code: assets.code || '', keySource: null, verifyUrl: null };

    let png = null, pdf = null;
    if (wantPng || wantPdf) {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                // same rendering flags as the audited CLI renders (build.cmd):
                // grayscale text AA + sRGB, so outputs are pixel-identical
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
                       '--disable-lcd-text', '--force-color-profile=srgb']
            });
            const page = await browser.newPage();
            await page.setContent(html, { waitUntil: 'networkidle0' });
            if (wantPdf) {
                // VECTOR PDF — @page A4 (preferCSSPageSize), same as audited
                // deliverable birth-certificate.pdf (486 KB, selectable text).
                // Old 300 DPI raster embed = 3 MB file.
                pdf = await page.pdf({
                    printBackground: true,
                    preferCSSPageSize: true,
                    margin: { top: 0, right: 0, bottom: 0, left: 0 }
                });
            }
            if (wantPng) {
                await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 1 });
                png = await page.screenshot({ type: 'png' });
            }
        } finally {
            if (browser) await browser.close();
        }
    }

    return {
        html: wantHtml ? html : null,
        png, pdf,
        engine: { key: eng.key, code: eng.code || assets.code || '', verifyUrl: eng.verifyUrl, keySource: eng.keySource }
    };
}

module.exports = { buildCertificate };
