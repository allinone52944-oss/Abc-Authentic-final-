'use strict';
/* death-verify-server.js — STANDALONE death-number (DRN) verification tool.
   BDRIS Scrapper-er sathe KONO somporko nei (death alada rakha hoyeche).
   Zero npm deps (Node 18+ built-in fetch + system Chrome for PDF).
   Run : node death-verify-server.js   (ba start-verify.bat double-click)
   UI  : http://localhost:3104 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
let CE; try { CE = require('../shared/cert-engine-standalone.js'); } catch (_) { CE = require('./cert-engine-standalone.js'); }

// everify.bdris.gov.bd-er TLS 1.3 handshake kichu network-e bhange
// ("bad ecpoint") — tai shob HTTPS call TLS 1.2 diye.
require('node:tls').DEFAULT_MAX_VERSION = 'TLSv1.2';

const EVERIFY = 'https://everify.bdris.gov.bd';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const PORT = parseInt(process.env.DEATH_ENGINE_PORT || '3104', 10);
const SESSION_TTL_MS = 5 * 60 * 1000;
// "Auto Calculate" button-er jonno (optional) — start-verify.bat-e set hoy.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const sessions = new Map();
setInterval(() => {
    const now = Date.now();
    for (const [k, s] of sessions) if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(k);
}, 60000).unref();
const CHROME_CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome'
];
const CHROME = CHROME_CANDIDATES.find(p => fs.existsSync(p)) || 'chrome';


/* ===== proven pieces from the audited death replica builder ===== */

let _fontsCss = null;
function fontsCss() {
    if (_fontsCss === null) {
        _fontsCss = fs.readFileSync(path.join(__dirname, 'assets', 'fonts.css'), 'utf8');
    }
    return _fontsCss;
}

function storeCookies(setCookieHeaders, jar) {
    if (!setCookieHeaders) return;
    for (const h of setCookieHeaders) {
        const pair = h.split(';')[0];
        const eq = pair.indexOf('=');
        if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }
}

function jarHeader(jar) {
    return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function eGet(path, jar, extraHeaders) {
    const r = await fetch(EVERIFY + path, {
        signal: AbortSignal.timeout(30000),
        headers: {
            'User-Agent': UA,
            'Cookie': jarHeader(jar),
            'Accept': 'text/html,image/avif,image/webp,image/apng,image/*,*/*',
            'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
            'Cache-Control': 'no-cache',
            ...(extraHeaders || {})
        }
    });
    storeCookies(r.headers.getSetCookie ? r.headers.getSetCookie() : [], jar);
    return r;
}

function parseFormPage(html) {
    const tok = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    const det = html.match(/name="CaptchaDeText"[^>]*value="([^"]+)"/);
    const img = html.match(/src="(\/DefaultCaptcha\/Generate\?t=[^"]+)"/);
    if (!tok || !det || !img) throw new Error('Could not parse verification page.');
    return { token: tok[1], captchaDeText: det[1], imgUrl: img[1] };
}

function extractRows(html) {
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(html)) !== null) {
        const cells = [];
        const tdRe = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;   // <th>-e label holeo nay
        let td;
        while ((td = tdRe.exec(tr[1])) !== null) {
            const t = td[2]
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/&amp;/gi, '&')
                .replace(/&lt;/gi, '<')
                .replace(/&gt;/gi, '>')
                .replace(/&quot;/gi, '"')
                .replace(/&#39;/g, "'")
                .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
                .replace(/\s+/g, ' ')
                .trim();
            cells.push(t);
        }
        if (cells.length) rows.push(cells);
    }
    return rows;
}

function mapResultData(html) {
    const data = {};
    const rows = extractRows(html);

    // 1) header sentence (single colspan cell):
    // "Given Death registration number <b>19681517411127048</b> and  Date of
    //  Death is <b>19 November 2022</b> are belonged to  <b> JAHANGIR ALAM</b>
    //  with the following particulars:"
    for (const cells of rows) {
        for (const t of cells) {
            if (!/death registration number/i.test(t) || !/belonged to/i.test(t)) continue;
            const n = t.match(/registration number\s*(\d{8,20})/i);
            if (n) data.brn = n[1];
            const d = t.match(/date of death is\s*(.+?)\s+are belonged to/i);
            if (d) data.dod = d[1].trim();
            const nm = t.match(/belonged to\s*(.+?)\s+with the following particulars/i);
            if (nm) data.nameEn = nm[1].trim();
            break;
        }
        if (data.brn) break;
    }

    // 2) data rows: [bnLabel][bnValue][enLabel][enValue]
    //    (labels rendered uppercase via CSS - always match case-insensitively)
    for (const cells of rows) {
        if (cells.length < 4) continue;
        const bnL = cells[0], bnV = cells[1], enL = cells[2], enV = cells[3];
        const en = String(enL || '').toLowerCase();
        const bn = String(bnL || '');
        if (en.includes('dead person') || en.includes('deceased') || en.includes('registered person') || bn.includes('মৃত ব্যক্তির নাম')) {
            data.nameEn = data.nameEn || enV;
            data.nameBn = data.nameBn || bnV;
        } else if (en.includes('place of death') || bn === 'মৃত্যুস্থান') {
            data.placeOfDeathEn = data.placeOfDeathEn || enV;
            data.placeOfDeathBn = data.placeOfDeathBn || bnV;
        } else if ((en.includes('mother') && !en.includes('nationality')) || bn === 'মাতার নাম') {
            data.motherNameEn = data.motherNameEn || enV;
            data.motherNameBn = data.motherNameBn || bnV;
        } else if ((en.includes('father') && !en.includes('nationality')) || bn === 'পিতার নাম') {
            data.fatherNameEn = data.fatherNameEn || enV;
            data.fatherNameBn = data.fatherNameBn || bnV;
        } else if (bn === 'মাতার জাতীয়তা' || (en.includes('mother') && en.includes('nationality'))) {
            data.motherNationalityEn = data.motherNationalityEn || enV;
            data.motherNationalityBn = data.motherNationalityBn || bnV;
        } else if (bn === 'পিতার জাতীয়তা' || (en.includes('father') && en.includes('nationality'))) {
            data.fatherNationalityEn = data.fatherNationalityEn || enV;
            data.fatherNationalityBn = data.fatherNationalityBn || bnV;
        } else if (en.includes('date of death')) {
            data.dod = data.dod || enV;
        } else if (en.includes('registration number') || bn.includes('নিবন্ধন নম্বর')) {
            const mm = String(enV || bnV).match(/\d{8,20}/);
            if (mm) data.brn = data.brn || mm[0];
        } else if (en.includes('cause of death')) {
            data.causeOfDeathEn = data.causeOfDeathEn || enV;
            data.causeOfDeathBn = data.causeOfDeathBn || bnV;
        } else if (en.includes('date of birth')) {
            // death certificate-e nije "Date of Birth" row thake (mool scan-eo ache)
            data.dob = data.dob || enV;
        } else if (en === 'sex') {
            data.sex = data.sex || enV;
        } else if (en.includes('registration date') || en.includes('date of registration')) {
            data.registrationDate = data.registrationDate || enV;
        } else if (en.includes('issuance')) {
            data.issuanceDate = data.issuanceDate || enV;
        } else if (en.includes('registration office')) {
            data.registrationOffice = data.registrationOffice || enV;
        } else if (en.includes('location of the register office') && !data.officeLocationRaw) {
            data.officeLocationRaw = enV;
        }
    }

    // 3) safety net (new record variant): DRN = the only 16-18 digit run on the
    //    page. Runs only when header/label parse missed it.
    if (!data.brn) {
        const m = html.replace(/<[^>]+>/g, ' ').match(/\d{16,18}/);
        if (m) data.brn = m[0];
    }
    return data;
}

/* birth-result page (/UBRNVerification/Search): same record-er full data —
   header grid-e REGISTRATION DATE | REGISTRATION OFFICE | ISSUANCE DATE /
   DATE OF BIRTH | BIRTH REGISTRATION NUMBER | SEX (label-row + value-row, ba
   pair layout — dui ta-i tolerate kore). 4-col rows mapResultData-i ney. */
function mapBirthResultData(html) {
    const data = mapResultData(html);
    const text = String(html)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, '|');
    const cells = text.split('|').map(s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim()).filter(Boolean);
    // Tolerant alias match — label spelling/case/space/punctuation drift jeneo.
    const nlab = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
        .replace(/[\s]*[:：.,]+$/, '').trim();
    const LAB = {
        registrationDate: ['registration date', 'date of registration', 'reg date', 'reg. date',
            'নিবন্ধনের তারিখ', 'নিবন্ধন তারিখ'],
        issuanceDate: ['issuance date', 'date of issuance', 'issue date', 'date of issue',
            'issued date', 'ইস্যুর তারিখ', 'প্রদানের তারিখ'],
        registrationOffice: ['registration office', 'register office', 'office of the registrar',
            'reg office', 'নিবন্ধন কার্যালয়', 'নিবন্ধনকার্যালয়'],
        dob: ['date of birth', 'birth date', 'dob', 'জন্ম তারিখ'],
        brn: ['birth registration number', 'birth registration no', 'birth reg no',
            'ubrn', 'registration number', 'নিবন্ধন নম্বর'],
        sex: ['sex', 'gender', 'লিঙ্গ'],
    };
    const fieldOf = (c) => {
        const n = nlab(c);
        for (const f of Object.keys(LAB)) if (LAB[f].includes(n)) return f;
        return '';
    };
    const isLabel = (c) => !!fieldOf(c);
    const VALID = {
        registrationDate: v => /\d/.test(v) && /\d{4}/.test(v),
        issuanceDate: v => /\d/.test(v) && /\d{4}/.test(v),
        dob: v => /\d/.test(v) && /\d{4}/.test(v),
        brn: v => /\d{8,}/.test(v),
        sex: v => /^(male|female|other|others)\b/i.test(v) || /পুরুষ|নারী|অন্যান্য/.test(v),
        registrationOffice: v => v.replace(/\s/g, '').length > 3 && !/\d{4}/.test(v),
    };
    // grid layout (labels row + values row) OTHAO pair layout (label|value) —
    // label-group porer same-length value-group e map hoy (strict positional,
    // khaali value hole position thake — na hole porer row-e value soriye jay).
    const grid = {};
    const used = new Set();
    for (let i = 0; i < cells.length; i++) {
        const f0 = fieldOf(cells[i]);
        if (!f0) continue;
        let j = i;
        while (j + 1 < cells.length && isLabel(cells[j + 1])) j++;
        const len = j - i + 1;
        for (let k = 0; k < len; k++) {
            const f = fieldOf(cells[i + k]);
            if (!f || grid[f]) continue;
            const v = cells[j + 1 + k];
            if (!v || isLabel(v)) continue;
            const ok = VALID[f];
            if (ok && !ok(v)) continue;      // validator fail -> fallback niche try hobe
            grid[f] = v;
            used.add(v);
        }
        i = j;
    }
    // fallback: run/positional miss hole (khaali cell, extra wrapper) — label-er
    // porer unused valid value nay. ek-i value dui field-e jabe na.
    const fwd = (field) => {
        const ok = VALID[field] || (() => true);
        for (let i = 0; i < cells.length; i++) {
            if (fieldOf(cells[i]) !== field) continue;
            for (let j = i + 1; j < cells.length; j++) {
                const v = cells[j];
                if (!v || isLabel(v) || used.has(v)) continue;
                if (ok(v)) return v;
            }
        }
        return '';
    };
    for (const f of Object.keys(LAB)) if (!grid[f]) { const v = fwd(f); if (v) { grid[f] = v; used.add(v); } }

    // GRID VALUE AUTHORITATIVE: mapResultData (death 4-col) birth-er label-row ke
    // [bnL][bnV][enL][enV] bhore nilo bole issuanceDate='DATE OF BIRTH' mis-set
    // hoyechilo — grid-e thakle grid-i jebe.
    const set = (dst, src) => { if (src) data[dst] = src; };
    set('registrationDate', grid.registrationDate);
    set('registrationOffice', grid.registrationOffice);
    set('issuanceDate', grid.issuanceDate);
    set('dob', grid.dob);
    const brn = grid.brn;
    if (brn) { const mm = brn.match(/\d{10,20}/); if (mm) data.brn = mm[0]; }
    set('sex', grid.sex);
    // NB footer: Location of the Register office : A, B, C. everify...
    const plain = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
    const loc = plain.match(/Location of the Register office\s*:\s*([\s\S]+?)\.\s*everify/i);
    if (loc && !data.officeLocationRaw) data.officeLocationRaw = 'Location of the Register office: ' + loc[1].replace(/\s+/g, ' ').trim();

    // sanitizer: je value-i label (ba date field-e date na) — sheta data theke
    // narao. 4-col row parse label-row ke value dhore neile eta-i bachabe.
    for (const f of ['registrationDate', 'issuanceDate', 'dob', 'registrationOffice']) {
        const v = data[f];
        if (!v) continue;
        const asLabel = fieldOf(v);
        const badDate = (f === 'registrationDate' || f === 'issuanceDate' || f === 'dob')
            && !(VALID[f] && VALID[f](String(v)));
        if (asLabel || badDate) delete data[f];
    }
    return data;
}

function normalizeBdrisData(data) {
    const out = { ...data };

    // Strip stray artifacts: backticks, quotes from API data
    const clean = (s) => String(s || '').replace(/[`'"‘’“”]/g, '').trim();
    for (const k of Object.keys(out)) {
        if (typeof out[k] === 'string') out[k] = clean(out[k]);
    }
    // --- Title Case: "MANSURA AKHTER" -> "Mansura Akhter" ---
    const titleCase = (s) => String(s || '').toLowerCase()
        .split(/(\s+)/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');

    // --- Date: "29 September 2026" -> "29/09/2026" ---
    const months = { january: '01', february: '02', march: '03', april: '04', may: '05', june: '06', july: '07', august: '08', september: '09', october: '10', november: '11', december: '12' };
    const toDDMMYYYY = (s) => {
        s = String(s || '').trim();
        if (!s) return s;
        // already DD/MM/YYYY
        let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
        // "29 September 2026"
        m = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
        if (m && months[m[2].toLowerCase()]) return `${m[1].padStart(2, '0')}/${months[m[2].toLowerCase()]}/${m[3]}`;
        // "2026-09-29" or "2026/09/29"
        m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
        if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
        return s;
    };

    out.registrationDate = toDDMMYYYY(out.registrationDate);
    out.issuanceDate = toDDMMYYYY(out.issuanceDate);
    out.dob = toDDMMYYYY(out.dob);
    out.dod = toDDMMYYYY(out.dod); // death only

    // --- English names/places: Title Case ---
    // NOTE: causeOfDeathEn is intentionally NOT title-cased - BDRIS prints it
    // in CAPS (e.g. "STROKE") and the death replica keeps it that way.
    for (const k of ['nameEn', 'motherNameEn', 'fatherNameEn', 'placeOfDeathEn', 'registrationOffice']) {
        if (out[k]) out[k] = titleCase(out[k]);
    }
    // Nationality: "BANGLADESHI" -> "Bangladeshi"
    for (const k of ['motherNationalityEn', 'fatherNationalityEn']) {
        if (out[k]) out[k] = titleCase(out[k]);
    }

    // Names: strip stray trailing DB artifacts (e.g. "Abdul Rezzak Khondokar `")
    for (const k of ['nameEn', 'nameBn', 'motherNameEn', 'motherNameBn', 'fatherNameEn', 'fatherNameBn']) {
        if (out[k]) out[k] = String(out[k]).replace(/[\u0060\u00B4\u2018\u2019\u201C\u201D'"`]+$/g, '').trim();
    }

    // Registration office: drop any "NB: ... Database. Location of the
    // Register office:" preamble, keep the FULL address, split line1 / rest.
    // (tolerates the BDRIS "retrived" typo, spacing/punctuation variants,
    //  or a bare "NB: <first sentence>. <address>" shape)
    if (out.registrationOffice) {
        let cleaned = String(out.registrationOffice).trim();
        const loc = cleaned.search(/location of the register office/i);
        if (loc >= 0) {
            cleaned = cleaned.slice(loc).replace(/^location of the register office\s*:?/i, '').trim();
        } else {
            const fullNB = cleaned.match(/^NB:?\s*this record is retrie?ved from birth and death registration database\s*\.\s*(location of the register office\s*:?)?/i);
            if (fullNB) {
                cleaned = cleaned.slice(fullNB[0].length).trim();
            } else {
                const anyNB = cleaned.match(/^NB:?\s*.*?\.\s+/i);
                if (anyNB) cleaned = cleaned.slice(anyNB[0].length).trim();
            }
        }
        out.registrationOffice = cleaned;
        // a sentence-final period is punctuation, never part of the address
        cleaned = cleaned.replace(/[.。]+$/, '').trim();
        const parts = cleaned.split(',').map(x => x.trim()).filter(Boolean);
        // PERMANENT office rule: office1 is the FULL table office name, never
        // truncated to the first comma part (e.g. "Zone - 8, Dhaka South City
        // Corporation", not just "Zone - 8"). office2 is the location, set
        // below from the NB location when present, else from the table rest.
        out.office1 = cleaned;
        out.office2 = parts.length > 1 ? parts.slice(1).join(', ') : '';
    }

    // Separate NB/location cell: office2 is the NB location. Drop the NB
    // first token ONLY if it equals office1's first comma part (e.g. NB
    // "Zone - 8, Dhaka South City Corporation, Dhaka" with office1
    // "Zone - 8, Dhaka South City Corporation" -> "Dhaka South City
    // Corporation, Dhaka"). Otherwise keep the full NB location.
    // NB sets office2 when it is empty, or when it extends the table
    // office2; a wholly different NB location never overrides the table.
    // Single-token location + no office1 -> office1 (kokhono data harabe na).
    if (out.officeLocationRaw) {
        const lm = String(out.officeLocationRaw).match(/location of the register office\s*:?\s*([\s\S]+)$/i);
        if (lm) {
            let loc = String(lm[1]).split(/[.。]\s*(https?:|everify|www\.)/i)[0].replace(/[.。]+$/, '').trim();
            const lp = loc.split(',').map(x => x.trim()).filter(Boolean);
            if (lp.length > 1) {
                if (out.office1) {
                    const firstPart = String(out.office1).split(',')[0].trim().toLowerCase();
                    const locParts = firstPart === lp[0].toLowerCase() ? lp.slice(1) : lp;
                    const cand = titleCase(locParts.join(', '));
                    if (!out.office2 || cand.toLowerCase() === String(out.office2).toLowerCase() || cand.toLowerCase().startsWith(String(out.office2).toLowerCase() + ', ')) {
                        out.office2 = cand;
                    }
                } else if (!out.office2) {
                    out.office2 = titleCase(lp.slice(1).join(', '));
                    out.office1 = titleCase(lp[0]);
                }
            } else if (lp.length === 1 && !out.office1) {
                out.office1 = titleCase(lp[0]);
            }
        }
        delete out.officeLocationRaw;
    }

    // --- office name EKBAR (sample-certificate layout): header line1 = office1,
    // line2 = office2. registrationOffice = split er ager copy — output-e duplicate
    // (office name 2 bar dekhato). office1/office2 thakle registrationOffice sorao.
    // (parse/validation level-e registrationOffice still kaj kore — shudhu response theke bad.)
    if (out.registrationOffice && out.office1) {
        delete out.registrationOffice;
    }

    // --- Place of Death: dedupe BDRIS's doubled token + ", Bangladesh" suffix ---
    // (API sometimes repeats the word: "munsiganj munsiganj" - printed cert has
    //  it once; then adds country like replica "Munshiganj, Bangladesh")
    const dedupeRep = (s) => {
        if (!s) return s;
        const tok = String(s).trim().split(/\s+/);
        const keep = [];
        for (const t of tok) {
            if (keep.length && keep[keep.length - 1].toLowerCase() === t.toLowerCase()) continue;
            keep.push(t);
        }
        return keep.join(' ');
    };
    out.placeOfDeathEn = dedupeRep(out.placeOfDeathEn);
    out.placeOfDeathBn = dedupeRep(out.placeOfDeathBn);
    if (out.placeOfDeathEn && !/bangladesh/i.test(out.placeOfDeathEn)) {
        out.placeOfDeathEn += ', Bangladesh';
    }
    if (out.placeOfDeathBn && !/বাংলাদেশ/.test(out.placeOfDeathBn)) {
        out.placeOfDeathBn += ', বাংলাদেশ';
    }

    // --- Sex: "MALE" -> "Male" ---
    if (out.sex) out.sex = titleCase(out.sex);

    return out;
}

const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function buildDeathCertificateHtml(d, assets) {
    // collapse-proof spaces (replica uses &nbsp; for the double space in dodWords)
    const N = (s) => esc(s).replace(/ {2,}/g, (m) => '&nbsp;'.repeat(m.length));
    const brnText = String(d.brn == null ? '' : d.brn);

    return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="utf-8">
<title>Death Registration Certificate - ${esc(brnText)}</title>
<style>
  @page { size: A4; margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #777;
    font-family: "Nirmala UI", "SolaimanLipi", "Nikosh", "Noto Sans Bengali", Arial, sans-serif;
    color: #000;
  }
  .sheet {
    position: relative;
    width: 210mm; height: 297mm;
    margin: 0 auto;
    background: #fff;
    overflow: hidden;
  }
  .sheet .el { position: absolute; white-space: nowrap; line-height: 1.15; }
  .seal { position: absolute; left: 26.9mm; top: 84.95mm; width: 149.8mm; z-index: 0; }
  .sheet .txt { z-index: 1; }
  .qr   { position: absolute; left: 17.7mm; top: 20.4mm; width: 29.3mm; height: 29.3mm; z-index: 1; }
  .qhhi { position: absolute; left: 17.62mm; top: 51.86mm; width: 29.0mm; z-index: 1; line-height: 1;
           text-align: center; font-size: 11.2pt; color: #787373; letter-spacing: 0.15px;
           font-family: Arial, sans-serif; font-weight: normal; }
  .logo { position: absolute; left: 86.7mm; top: 10.0mm; width: 22.1mm; z-index: 1; }
  .bar  { position: absolute; left: 134.2mm; top: 21.1mm; width: 48.5mm; height: 7.8mm; z-index: 1; }
  .hc { position: absolute; left: 0; width: 210mm; text-align: center; z-index: 1; white-space: nowrap; line-height: 1.15; }
  .f11 { font-size: 11pt; } .f115 { font-size: 11.5pt; } .f105 { font-size: 10.5pt; }
  .bn { font-family: 'SutonnyOMJ'; font-size: 11.5pt; }
  .b { font-weight: bold; } .it { font-style: italic; }
  @media print {
    body { background: #fff; }
    .sheet { margin: 0; }
  }
</style>
<style>${fontsCss()}</style>
</head>
<body>
<div class="sheet">

  <img class="seal" src="${assets.seal}" alt="">
  <img class="qr" src="${assets.qr}" alt="">
  <div class="qhhi">${esc(assets.code)}</div>
  <img class="logo" src="${assets.logo}" alt="">
  <img class="bar" src="${assets.barcode}" alt="">

  <!-- header -->
  <div class="hc f11 txt" style="top:34.1mm; font-family:Verdana, sans-serif; font-size:13.11pt; letter-spacing:0.15px; padding-left:11.34mm; transform:scaleX(0.984);">Government of the People&#8217;s Republic of Bangladesh</div>
  <div class="hc f115 txt" style="top:41.9mm; padding-left:11.07mm; font-family:Verdana, sans-serif; font-size:10.81pt; letter-spacing:0.30px; transform:scaleX(0.989);">Office of the Registrar, Birth and Death Registration</div>
  <div class="hc f115 txt" style="top:47.8mm; padding-left:11.06mm; font-family:Calibri, sans-serif; font-size:13.40pt; letter-spacing:0.15px;">${esc(d.office1)}</div>
  <div class="hc f115 txt" style="top:54.57mm; padding-left:10.80mm; font-family:Calibri, sans-serif; font-size:13.34pt; letter-spacing:0.45px;">${esc(d.office2)}</div>
  <div class="hc f105 txt" style="top:60.76mm; padding-left:11.06mm; font-family:Verdana, sans-serif; font-size:8.75pt; letter-spacing:0.2px;">(Rule 11, 12)</div>
  <div class="el txt b" style="left:51.91mm; top:66.24mm; font-size:15pt; line-height:1; font-family:'SutonnyOMJ'; transform:scaleX(1.0); transform-origin:left bottom">মৃত্যু নিবন্ধন সনদ</div>
  <div class="el txt b" style="left:82.6mm; top:65.3mm; font-size:16.8pt; line-height:1; font-family:Constantia, 'Times New Roman', serif;">/ Death Registration Certificate</div>

  <!-- meta -->
  <div class="el txt f11" style="left:22.86mm; top:78.54mm; font-family:Candara, sans-serif; font-size:10.74pt; letter-spacing:0.15px;">Date of Registration</div>
  <div class="el txt f11" style="left:22.90mm; top:84.11mm; font-family:Arial, sans-serif; font-size:9.15pt; letter-spacing:1.05px;">${esc(d.regDate)}</div>
  <div class="el txt f11" style="left:1.82mm; width:204.2mm; text-align:center; top:78.87mm; font-family:Verdana, sans-serif; font-size:10.89pt; letter-spacing:0.60px;">Death Registration Number</div>
  <div class="el txt b" style="left:0mm; width:207.6mm; text-align:center; top:83.7mm; font-size:12.5pt; font-family:'Trebuchet MS', sans-serif; transform:scaleX(1.016);">${esc(brnText)}</div>
  <div class="el txt f11" style="left:146.14mm; top:78.54mm; font-size:10.56pt; letter-spacing:0.15px;">Date of Issuance</div>
  <div class="el txt f11" style="left:146.15mm; top:84.11mm; font-family:Arial, sans-serif; font-size:9.15pt; letter-spacing:1.05px;">${esc(d.issueDate)}</div>

  <!-- dob / dod / in word -->
  <div class="el txt f11" style="left:22.86mm; top:98.33mm; font-family:Verdana, sans-serif; font-size:11pt;">Date of Birth</div>
  <div class="el txt f11" style="left:53.52mm; top:97.94mm;">:</div>
  <div class="el txt f11" style="left:56.43mm; top:98.02mm; font-family:Arial, sans-serif; font-weight:normal; font-size:12.04pt; letter-spacing:0.60px;">${esc(d.dob)}</div>
  <div class="el txt f11" style="left:134.14mm; top:98.08mm; font-family:Verdana, sans-serif;">Sex</div>
  <div class="el txt f11" style="left:143.09mm; top:97.94mm;">:</div>
  <div class="el txt f11" style="left:148.55mm; top:98.20mm; font-family:Verdana, sans-serif;">${esc(d.sex)}</div>
  <div class="el txt f11" style="left:22.86mm; top:104.69mm; font-family:Verdana, sans-serif; font-size:11pt;">Date of Death</div>
  <div class="el txt f11" style="left:53.49mm; top:104.30mm;">:</div>
  <div class="el txt f11" style="left:56.30mm; top:104.55mm; font-family:Arial, sans-serif; font-weight:normal; font-size:12.04pt; letter-spacing:0.60px;">${esc(d.dod)}</div>
  <div class="el txt f11" style="left:22.75mm; top:111.27mm; font-size:12.7pt;">In Word</div>
  <div class="el txt f11" style="left:53.52mm; top:111.16mm;">:</div>
  <div class="el txt f11 it" style="left:55.81mm; top:111.27mm; transform:scaleX(1.155); transform-origin:left center;">${N(d.dodWords)}</div>

  <!-- column standard (forensic-locked, do NOT drift):
       BN label ~23.0 | BN ':' 53.52 | BN value 55.93 || EN label 103.25 | EN ':' 134.75 | EN value 137.47.
       Cause row follows same columns. Khali value = blank thake, layout nore na. -->
  <!-- row 1 -->
  <div class="el txt bn" style="left:23.15mm; top:126.03mm; transform:scaleX(0.995); transform-origin:left bottom">নাম</div>
  <div class="el txt f11" style="left:53.52mm; top:123.88mm;">:</div>
  <div class="el txt bn" style="left:55.93mm; top:125.54mm; transform:scaleX(1.091); transform-origin:left bottom">${esc(d.nameBn)}</div>
  <div class="el txt f11" style="left:103.25mm; top:124.28mm; font-family:Verdana, sans-serif; transform:scaleX(1.0); transform-origin:left center;">Name</div>
  <div class="el txt f11" style="left:134.75mm; top:123.88mm;">:</div>
  <div class="el txt f11" style="left:137.47mm; top:124.28mm; font-family:Tahoma, sans-serif; letter-spacing:1.0px; transform:scaleX(1.0); transform-origin:left center;">${esc(d.nameEn)}</div>

  <!-- row 2 -->
  <div class="el txt bn" style="left:22.92mm; top:135.16mm; transform:scaleX(1.117); transform-origin:left bottom">মাতা</div>
  <div class="el txt f11" style="left:53.52mm; top:133.27mm;">:</div>
  <div class="el txt bn" style="left:55.93mm; top:135.26mm; transform:scaleX(1.135); transform-origin:left bottom">${esc(d.motherBn)}</div>
  <div class="el txt f11" style="left:103.25mm; top:133.67mm; font-family:Verdana, sans-serif; transform:scaleX(1.0); transform-origin:left center;">Mother</div>
  <div class="el txt f11" style="left:134.75mm; top:133.27mm;">:</div>
  <div class="el txt f11" style="left:137.47mm; top:133.67mm; font-family:Tahoma, sans-serif; letter-spacing:1.94px; transform:scaleX(1.0); transform-origin:left center;">${esc(d.motherEn)}</div>

  <!-- row 3 -->
  <div class="el txt bn" style="left:22.89mm; top:143.79mm; transform:scaleX(1.110); transform-origin:left bottom">মাতার জাতীয়তা</div>
  <div class="el txt f11" style="left:53.52mm; top:142.34mm;">:</div>
  <div class="el txt bn" style="left:55.93mm; top:143.77mm; transform:scaleX(1.062); transform-origin:left bottom">${esc(d.motherNatBn)}</div>
  <div class="el txt f11" style="left:103.25mm; top:142.74mm; font-family:Verdana, sans-serif; transform:scaleX(1.0); transform-origin:left center;">Nationality</div>
  <div class="el txt f11" style="left:134.75mm; top:142.34mm;">:</div>
  <div class="el txt f11" style="left:137.47mm; top:142.74mm; font-family:Tahoma, sans-serif; letter-spacing:1.35px; transform:scaleX(1.0); transform-origin:left center;">${esc(d.motherNatEn)}</div>

  <!-- row 4 -->
  <div class="el txt bn" style="left:23.15mm; top:153.65mm; transform:scaleX(1.065); transform-origin:left bottom">পিতা</div>
  <div class="el txt f11" style="left:53.52mm; top:152.08mm;">:</div>
  <div class="el txt bn" style="left:55.93mm; top:153.86mm; transform:scaleX(1.080); transform-origin:left bottom">${esc(d.fatherBn)}</div>
  <div class="el txt f11" style="left:103.25mm; top:152.48mm; font-family:Verdana, sans-serif; transform:scaleX(1.0); transform-origin:left center;">Father</div>
  <div class="el txt f11" style="left:134.75mm; top:152.08mm;">:</div>
  <div class="el txt f11" style="left:137.47mm; top:152.48mm; font-family:Tahoma, sans-serif; letter-spacing:1.2px; transform:scaleX(1.0); transform-origin:left center;">${esc(d.fatherEn)}</div>

  <!-- row 5 -->
  <div class="el txt bn" style="left:23.15mm; top:162.80mm; transform:scaleX(1.101); transform-origin:left bottom">পিতার জাতীয়তা</div>
  <div class="el txt f11" style="left:53.52mm; top:160.75mm;">:</div>
  <div class="el txt bn" style="left:55.92mm; top:162.66mm; transform:scaleX(1.052); transform-origin:left bottom">${esc(d.fatherNatBn)}</div>
  <div class="el txt f11" style="left:103.25mm; top:161.15mm; font-family:Verdana, sans-serif; transform:scaleX(1.0); transform-origin:left center;">Nationality</div>
  <div class="el txt f11" style="left:134.75mm; top:160.75mm;">:</div>
  <div class="el txt f11" style="left:137.47mm; top:161.15mm; font-family:Tahoma, sans-serif; letter-spacing:1.4px; transform:scaleX(1.0); transform-origin:left center;">${esc(d.fatherNatEn)}</div>

  <!-- row 6 place of death -->
  <div class="el txt bn" style="left:22.89mm; top:171.61mm; transform:scaleX(1.010); transform-origin:left bottom">মৃত্যুস্থান</div>
  <div class="el txt f11" style="left:53.49mm; top:171.09mm;">:</div>
  <div class="el txt bn" style="left:56.20mm; top:172.63mm; transform:scaleX(1.091); transform-origin:left bottom">${esc(d.pobBn)}</div>
  <div class="el txt f11" style="left:103.25mm; top:171.49mm; font-family:Verdana, sans-serif; transform:scaleX(1.0); transform-origin:left center;">Place of Death</div>
  <div class="el txt f11" style="left:134.75mm; top:171.09mm;">:</div>
  <div class="el txt f11" style="left:137.47mm; top:171.49mm; font-family:Tahoma, sans-serif; letter-spacing:1.15px; transform:scaleX(1.0); transform-origin:left center;">${esc(d.pobEn)}</div>

  <!-- row 7 cause of death -->
  <div class="el txt bn" style="left:22.89mm; top:186.97mm; transform:scaleX(1.007); transform-origin:left bottom">মৃত্যুর কারণ</div>
  <div class="el txt f11" style="left:53.52mm; top:185.40mm;">:</div>
  <div class="el txt bn" style="left:55.93mm; top:187.15mm; transform:scaleX(1.091); transform-origin:left bottom">${esc(d.codBn)}</div>
  <div class="el txt f11" style="left:103.25mm; top:187.84mm; font-family:Verdana, sans-serif; transform:scaleX(1.0); transform-origin:left center;">Cause of Death</div>
  <div class="el txt f11" style="left:134.75mm; top:187.44mm;">:</div>
  <div class="el txt f11" style="left:137.47mm; top:187.84mm; font-family:Tahoma, sans-serif; letter-spacing:1.1px; transform:scaleX(1.0); transform-origin:left center;">${esc(d.codEn)}</div>
  <div class="el txt" style="left:23.1mm; top:193.61mm; font-family:'SutonnyOMJ'; font-size:7pt; transform:scaleX(0.85); transform-origin:left center;">(আই সি ডি ভার্সন অনুসারে)</div>
  <div class="el txt" style="left:103.23mm; top:193.71mm; font-size:5.2pt; transform:scaleX(1.052); transform-origin:left center;">(As per ICD Version)</div>

  <!-- signatures -->
  <div class="el txt f11" style="left:-7.4mm; width:90mm; text-align:center; top:226.45mm; font-family:Verdana, sans-serif; font-size:11pt; letter-spacing:0px;">Seal &amp; Signature</div>
  <div class="el txt f11 b" style="left:-7.4mm; width:90mm; text-align:center; top:231.56mm; letter-spacing:0.4px; transform:scale(0.985,0.94);">Assistant to Registrar</div>
  <div class="el txt f105" style="left:-7.4mm; width:90mm; text-align:center; top:237.45mm; letter-spacing:0px; font-family:Arial, sans-serif; font-size:9.8pt; font-weight:bold;">(Preparation, Verification)</div>
  <div class="el txt f11" style="left:125.37mm; width:75mm; text-align:center; top:226.45mm; font-family:Verdana, sans-serif; font-size:11pt; letter-spacing:0px;">Seal &amp; Signature</div>
  <div class="el txt f11 b" style="left:125.70mm; width:75mm; text-align:center; top:232.05mm; letter-spacing:0px; font-family:Arial, sans-serif;">Registrar</div>

  <!-- footer -->
  <div class="el txt" style="left:-0.62mm; width:208.6mm; text-align:center; padding-right:4.4mm; top:261.17mm; font-size:8.32pt; letter-spacing:0.15px;">This certificate is generated from bdris.gov.bd, and to verify this certificate, please scan the above QR Code &amp; Bar Code.</div>

</div>
</body>
</html>`;
}


/* ---------------- assets: seal/logo + engine QR/barcode -------------------
   Known ground-truth records: official key (QR = bdris.gov.bd verify URL,
   passes real verify) + official printed caption (ZTZQQ, BDRIS-er nije-
   generate code - key theke derive hoy na). Unknown records: engine key
   (scan hoy, official verify-e pass korbe na) + 4-char engine fallback. */
const KNOWN_DEATH = {
    '19681517411127048': {
        key: 'VvhyRT3BnUPZyENQKzkPyMdq1iSQiS5uvHfLbt6xCfrbo+BqkrdNuIIrPDwDJQZ2',
        code: 'ZTZQQ',
        // birth-enrichment-er jonno DOB (birth endpoint-e date required);
        // display format DD/MM/YYYY
        dob: '01/01/1968'
        // other enrichment (birth page theke auto): office1, office2,
        // registrationDate, issuanceDate, sex, causeOfDeath*, *Nationality*
    }
};

async function buildAssets(d) {
    const sealBase64 = fs.readFileSync(path.join(__dirname, 'assets', 'seal.jpg')).toString('base64');
    const logoBase64 = fs.readFileSync(path.join(__dirname, 'assets', 'logo.png')).toString('base64');
    const brnText = String(d.brn == null ? '' : d.brn).trim();
    const knownRec = KNOWN_DEATH[brnText];
    let qrDataUrl = '', barcodeDataUrl = '';
    let code = String(d.verificationCode || (knownRec && knownRec.code) || '').trim();
    if (brnText) {
        const built = await CE.build({
            number: brnText,
            url: d.verificationUrl || undefined,
            keys: knownRec ? { [brnText]: knownRec.key } : undefined
        });
        qrDataUrl = (built.qr && built.qr.dataUrl) || '';
        barcodeDataUrl = (built.barcode && built.barcode.dataUrl) || '';
        if (!code) code = built.code || '';
    }
    return {
        seal: 'data:image/jpeg;base64,' + sealBase64,
        logo: 'data:image/png;base64,' + logoBase64,
        qr: qrDataUrl,
        barcode: barcodeDataUrl,
        code: code
    };
}

/* ---------------- helpers ---------------- */
function json(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
    res.end(b);
}
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            try { resolve(Buffer.concat(chunks).toString('utf8')); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}
async function readJson(req) {
    const t = await readBody(req);
    try { return t ? JSON.parse(t) : {}; } catch (_) { return {}; }
}
function serveFile(res, file, type) {
    if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
    const b = fs.readFileSync(file);
    // no-store: browser jate kono din cached (purano) UI serve na kore
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': b.length, 'Cache-Control': 'no-store' });
    res.end(b);
}

/* ---------------- captcha auto-solve (optional "Auto Calculate") ------------
   Zero npm deps — Gemini REST api direct fetch diye (birth Scrapper-er
   @google/generative-ai package er identical behavior, package chara). */
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-flash-latest'];
async function solveCaptchaWithGemini(captchaB64, mimeType) {
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'PASTE_YOUR_KEY_HERE')
        throw new Error('GEMINI_API_KEY is not set (start-verify.bat-e key bosan).');
    const prompt = "Solve the math problem shown in this image. If it's a math problem like '92-48=?', return only the final calculated number (e.g. 44). If it is just a string of random letters and numbers, return those exactly. ONLY return the final answer without any explanation or extra text. Make sure you calculate correctly.";
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        for (const modelName of GEMINI_MODELS) {
            try {
                const r = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
                    {
                        method: 'POST',
                        signal: AbortSignal.timeout(45000),
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts: [
                                { text: prompt },
                                { inline_data: { mime_type: mimeType || 'image/png', data: captchaB64 } }
                            ]}]
                        })
                    }
                );
                if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
                const j = await r.json();
                const txt = j && j.candidates && j.candidates[0] &&
                    j.candidates[0].content && j.candidates[0].content.parts &&
                    j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text;
                if (!txt) throw new Error('empty model response');
                return txt.trim();
            } catch (e) {
                lastErr = e;
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }
    throw lastErr || new Error('Captcha auto-solve failed.');
}

/* Python auto-detect: env override -> PATH -> Windows installer dirs.
   Candidate valid only if `import cv2, ddddocr` succeeds (solver deps). */
let _pyCmd; // undefined = not tried, null = none found
function findPython() {
    if (_pyCmd !== undefined) return _pyCmd;
    const cands = [];
    if (process.env.PYTHON_PATH) cands.push([process.env.PYTHON_PATH]);
    cands.push(['python'], ['python3'], ['py', '-3']);
    try {
        const dirs = [];
        const lp = process.env.LOCALAPPDATA;
        if (lp && fs.existsSync(path.join(lp, 'Programs', 'Python'))) {
            for (const d of fs.readdirSync(path.join(lp, 'Programs', 'Python'))) dirs.push(path.join(lp, 'Programs', 'Python', d, 'python.exe'));
        }
        const pf = process.env.ProgramFiles;
        if (pf && fs.existsSync(pf)) {
            for (const d of fs.readdirSync(pf)) if (/^Python/i.test(d)) dirs.push(path.join(pf, d, 'python.exe'));
        }
        if (fs.existsSync('C:\\')) {
            for (const d of fs.readdirSync('C:\\')) if (/^Python/i.test(d)) dirs.push(path.join('C:\\', d, 'python.exe'));
        }
        for (const d of dirs) cands.push([d]);
    } catch (e) {}
    for (const c of cands) {
        try {
            const r = spawnSync(c[0], c.slice(1).concat(['-c', 'import cv2, ddddocr']), { windowsHide: true, timeout: 25000 });
            if (r.status === 0) { _pyCmd = c; return _pyCmd; }
        } catch (e) {}
    }
    _pyCmd = null;
    return null;
}

async function solveCaptchaLocal(captchaB64, mimeType) {
    // solve_local.py: opencv geometry + ddddocr ensemble, fully offline.
    const sharedScript = path.join(__dirname, '..', 'shared', 'solve_local.py');
    const script = fs.existsSync(sharedScript) ? sharedScript : path.join(__dirname, 'solve_local.py');
    if (!fs.existsSync(script)) return null;
    const pyCmd = findPython();
    if (!pyCmd) return null;
    const ext = (mimeType || '').indexOf('png') >= 0 ? '.png' : '.gif';
    const tmp = path.join(os.tmpdir(), 'dv_cap_' + crypto.randomBytes(6).toString('hex') + ext);
    try {
        fs.writeFileSync(tmp, Buffer.from(captchaB64, 'base64'));
        const out = await new Promise((resolve) => {
            let buf = '', err = '';
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            let py;
            try {
                py = spawn(pyCmd[0], pyCmd.slice(1).concat([script, tmp]), { windowsHide: true });
            } catch (e) { return finish(null); }
            const killer = setTimeout(() => { try { py.kill(); } catch (_) {} finish(null); }, 120000);
            py.stdout.on('data', d => { buf += d; });
            py.stderr.on('data', d => { err += d; });
            py.on('error', () => { clearTimeout(killer); finish(null); });
            py.on('close', code => {
                clearTimeout(killer);
                if (code !== 0) return finish(null);
                try {
                    const j = JSON.parse(buf.trim().split('\n').pop());
                    if (j && j.answer != null && String(j.answer).length) finish(String(j.answer));
                    else finish(null);
                } catch (e) { finish(null); }
            });
        });
        return out;
    } catch (e) {
        return null;
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

async function routeSolveCaptcha(req, res) {
    const body = await readJson(req);
    const s = sessions.get((body || {}).sessionId);
    if (!s) return json(res, 400, { success: false, error: 'Session expire hoyeche — notun captcha anun.' });
    if (!s.captchaB64) return json(res, 400, { success: false, error: 'Captcha image session-e nei — notun captcha anun.' });
    // 1) LOCAL offline solver (solve_local.py — opencv + ddddocr, zero API).
    const local = await solveCaptchaLocal(s.captchaB64, s.captchaMime);
    if (local) return json(res, 200, { success: true, answer: local, method: 'local' });
    // 2) Gemini fallback (optional — key thakle).
    try {
        const answer = await solveCaptchaWithGemini(s.captchaB64, s.captchaMime);
        json(res, 200, { success: true, answer, method: 'gemini' });
    } catch (e) {
        json(res, 500, { success: false, error: 'Auto-solve failed (local + gemini) — captcha manually likhun.' });
    }
}

/* ---------------- birth-page enrichment (curl based) ----------------
   Undici/Node fetch er TLS ei endpoint-e (DefaultCaptcha/Generate) flaky
   (ERR_SSL_BAD_ECPOINT) — curl.exe shob request stably kore. Multipart form
   curl-er -F/--form-string diye. */
function shCurl(args) {
    return new Promise((resolve) => {
        let out = '', err = '';
        let cp;
        try { cp = spawn('curl.exe', args, { windowsHide: true }); }
        catch (e) { return resolve({ ok: false, out: '', err: e.message }); }
        const killer = setTimeout(() => { try { cp.kill(); } catch (_) {} resolve({ ok: false, out, err: 'timeout' }); }, 45000);
        cp.stdout.on('data', d => { out += d; });
        cp.stderr.on('data', d => { err += d; });
        cp.on('error', e => { clearTimeout(killer); resolve({ ok: false, out, err: e.message }); });
        cp.on('close', code => { clearTimeout(killer); resolve({ ok: code === 0, out, err, code }); });
    });
}

/* Same number diye /UBRNVerification/Search (birth endpoint) → full record
   HTML. BirthDate REQUIRED (server-side validation) — dobYMD 'yyyy-MM-dd'.
   captcha wrong hole 3 attempt. Success → html, na → null. */
async function fetchBirthRecord(drn, dobYMD) {
    const rnd = crypto.randomBytes(6).toString('hex');
    const jarF = path.join(os.tmpdir(), 'dv_bjar_' + rnd + '.txt');
    const imgF = path.join(os.tmpdir(), 'dv_bcap_' + rnd + '.gif');
    const resF = path.join(os.tmpdir(), 'dv_bres_' + rnd + '.html');
    const dobVal = /^\d{4}-\d{2}-\d{2}$/.test(String(dobYMD || '')) ? String(dobYMD) : '';
    try {
        for (let att = 1; att <= 3; att++) {
            const g = await shCurl(['-s', '-L', '--max-time', '25', '-A', UA, '-c', jarF, EVERIFY + '/UBRNVerification']);
            if (!g.ok || g.out.length < 500) continue;
            let f;
            try { f = parseFormPage(g.out); } catch (_) { continue; }
            await shCurl(['-s', '-L', '--max-time', '25', '-A', UA, '-b', jarF, '-c', jarF,
                '-e', EVERIFY + '/UBRNVerification', '-o', imgF, EVERIFY + f.imgUrl]);
            const imgBuf = fs.existsSync(imgF) ? fs.readFileSync(imgF) : Buffer.alloc(0);
            if (imgBuf.length < 500) continue;
            // 1) local solver, 2) gemini fallback
            let ans = await solveCaptchaLocal(imgBuf.toString('base64'), 'image/gif');
            if (!ans && GEMINI_API_KEY && GEMINI_API_KEY !== 'PASTE_YOUR_KEY_HERE') {
                try { ans = await solveCaptchaWithGemini(imgBuf.toString('base64'), 'image/gif'); } catch (_) {}
            }
            if (!ans) continue;
            const p = await shCurl(['-s', '-L', '--max-time', '25', '-A', UA, '-b', jarF, '-c', jarF,
                '-e', EVERIFY + '/UBRNVerification',
                '--form-string', 'UBRN=' + drn,
                '--form-string', 'BirthDate=' + dobVal,
                '--form-string', 'CaptchaDeText=' + f.captchaDeText,
                '--form-string', 'CaptchaInputText=' + ans,
                '--form-string', '__RequestVerificationToken=' + f.token,
                '-o', resF, EVERIFY + '/UBRNVerification/Search']);
            const html = fs.existsSync(resF) ? fs.readFileSync(resF, 'utf8') : '';
            if (!html || html.length < 500) continue;
            try { fs.writeFileSync(path.join(__dirname, '_last-birth.html'), html); } catch (_) {}
            if (html.includes('Captcha is not valid') || html.includes('Does not match')) continue;
            if (html.includes('Error in Data retriving')) continue;
            if (html.includes('input-validation-error')) continue;
            if (html.includes('No record found')) return null;
            // positive-result guard: record page-e grid header thaktei hobe
            if (!/REGISTRATION DATE/i.test(html)) continue;
            return html;
        }
        return null;
    } finally {
        for (const f of [jarF, imgF, resF]) { try { fs.unlinkSync(f); } catch (_) {} }
    }
}

/* ---------------- captcha (UDRNVerification page) ---------------- */
async function routeCaptcha(res) {
    const pagePath = '/UDRNVerification';
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const jar = {};
            const pageRes = await eGet(pagePath, jar);
            const html = await pageRes.text();
            const { token, captchaDeText, imgUrl } = parseFormPage(html);

            const imgRes = await eGet(imgUrl, jar, {
                'Referer': EVERIFY + pagePath,
                'Sec-Fetch-Dest': 'image',
                'Sec-Fetch-Mode': 'no-cors',
                'Sec-Fetch-Site': 'same-origin'
            });
            const buf = Buffer.from(await imgRes.arrayBuffer());
            if (!buf.length) throw new Error('Empty captcha image.');
            if (buf.slice(0, 6).toString('ascii').indexOf('GIF') !== 0)
                throw new Error('Chobi thikmoto asheni — abar cheshta korun.');
            const bhash = crypto.createHash('sha256').update(buf).digest('hex');
            if (bhash === '7021ec2d5a98f5d470fd25303948246c1603ebe65a6c2bf07d58a644a8974536')
                throw new Error('BDRIS captcha deni (lal X) — abar cheshta korun.');

            const id = crypto.randomBytes(16).toString('hex');
            sessions.set(id, {
                jar, token, captchaDeText,
                captchaB64: buf.toString('base64'),
                captchaMime: (imgRes.headers.get('content-type') || 'image/png').split(';')[0],
                createdAt: Date.now()
            });
            setTimeout(() => sessions.delete(id), SESSION_TTL_MS);

            const mime = (imgRes.headers.get('content-type') || 'image/png').split(';')[0];
            return json(res, 200, {
                success: true,
                sessionId: id,
                image: `data:${mime};base64,${buf.toString('base64')}`,
                diag: `HTTP ${imgRes.status} · ${mime} · ${buf.length} bytes · GIF ok`
            });
        } catch (e) {
            lastErr = e;
            await new Promise(r => setTimeout(r, 1200));
        }
    }
    json(res, 500, { success: false, error: 'Could not load captcha: ' + (lastErr && lastErr.message) });
}

/* ---------------- verify (POST /UDRNVerification/Search) ---------------- */
async function routeVerify(req, res) {
    const body = await readJson(req);
    const { sessionId, drn, dod, captcha } = body || {};
    const s = sessions.get(sessionId);
    if (!s) return json(res, 400, { success: false, error: 'Session expire hoyeche — notun captcha anun.' });
    if (!drn || !dod || !captcha)
        return json(res, 400, { success: false, error: 'Death number, motrittu tarikh o captcha — sob dorkar.' });
    sessions.delete(sessionId); // one-shot

    // DD/MM/YYYY | D-M-YYYY | yyyy-MM-dd -> yyyy-MM-dd (BDRIS field: BirthDate)
    let dobFmt = String(dod).trim().replace(/\//g, '-');
    const dm = dobFmt.match(/^(\d{1,4})-(\d{1,2})-(\d{1,4})$/);
    if (dm) {
        if (dm[1].length === 4) dobFmt = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
        else if (dm[3].length === 4) dobFmt = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    }

    try {
        const p = new URLSearchParams({
            __RequestVerificationToken: s.token,
            CaptchaDeText: s.captchaDeText,
            ubrn: String(drn).trim(),
            BirthDate: dobFmt,
            CaptchaInputText: String(captcha).trim()
        });
        const r = await fetch(EVERIFY + '/UDRNVerification/Search', {
            method: 'POST',
            signal: AbortSignal.timeout(60000),
            headers: {
                'User-Agent': UA,
                'Cookie': jarHeader(s.jar),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': EVERIFY + '/UDRNVerification'
            },
            body: p
        });
        const html = await r.text();

        // debug copy: structure dekhar jonno
        try { fs.writeFileSync(path.join(__dirname, '_last-result.html'), html); } catch (_) {}

        if (html.includes('Captcha is not valid') || html.includes('Does not match'))
            return json(res, 200, { success: false, error: 'Captcha bhul — notun captcha anun abar cheshta korun.' });
        if (html.includes('No record found'))
            return json(res, 200, { success: false, error: 'Ei death number + tarikhe kono record pawa jayni.' });
        if (/error in data retr/i.test(html))
            return json(res, 200, { success: false, error: 'BDRIS error: Error in Data retrieving. Please retry another time.' });

        const data = normalizeBdrisData(mapResultData(html));
        data.recordType = 'death';
        // auto: DRN shobhosho digits-e ane (space/dash thakleo)
        if (data.brn != null && data.brn !== '') data.brn = String(data.brn).replace(/\D/g, '');

        const verifyUrlMatch = html.match(/https:\/\/bdris\.gov\.bd\/certificate\/verify\?key=[A-Za-z0-9+\/=%_-]+/);
        if (verifyUrlMatch) data.verificationUrl = verifyUrlMatch[0];
        const knownRec = KNOWN_DEATH[data.brn];
        if (knownRec && !data.verificationUrl)
            data.verificationUrl = 'https://bdris.gov.bd/certificate/verify?key=' + knownRec.key;

        // known-record enrichment: BDRIS search page je field drop kore (short
        // variant), oi field map-e ache thakle boshao — LIVE value ke kokhono
        // override NA (sudhu khali field fill).
        if (knownRec) {
            for (const k of Object.keys(knownRec)) {
                if (k === 'key' || k === 'code') continue;
                if ((data[k] == null || data[k] === '') && knownRec[k]) data[k] = knownRec[k];
            }
        }

        // birth-page enrichment: death search-e jodi reg/issue/DOB/sex/office
        // na ashe — same number diye /UBRNVerification/Search (birth) theke
        // full data ashe (BDRIS-er nijer verify page). Non-fatal — fail hole
        // short data-i thakbe.
        if (!data.registrationDate || !data.issuanceDate || !data.dob || !data.sex || !data.office1) {
            try {
                let dobYMD = '';
                const dm2 = String(data.dob || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
                if (dm2) dobYMD = `${dm2[3]}-${dm2[2].padStart(2, '0')}-${dm2[1].padStart(2, '0')}`;
                const bhtml = await fetchBirthRecord(data.brn, dobYMD);
                if (bhtml) {
                    const b = normalizeBdrisData(mapBirthResultData(bhtml));
                    for (const k of Object.keys(b)) {
                        if (k === 'brn') continue;
                        if ((data[k] == null || data[k] === '') && b[k]) data[k] = b[k];
                    }
                }
            } catch (_) {}
        }

        if (!data.brn || data.brn.length < 10 || !data.nameEn)
            return json(res, 200, { success: false, error: 'Result pora jayni — _last-result.html save hoyeche (path dekhte parben).', debug: extractRows(html).slice(0, 20) });

        // Missing-field diagnostic — consumer ki ki pabe / ki miss hocche janbe.
        const miss = ['registrationDate', 'issuanceDate', 'office1', 'office2']
            .filter(k => !data[k]);
        if (miss.length) data.missingFields = miss;

        return json(res, 200, { success: true, data });
    } catch (e) {
        json(res, 500, { success: false, error: e.message });
    }
}

/* API names -> certificate template names (death cert fields) */
function toTemplateFields(d) {
    const t = Object.assign({}, d);
    const pick = (dst, src) => { if (!t[dst] && t[src]) t[dst] = t[src]; };
    pick('pobEn', 'placeOfDeathEn');
    pick('pobBn', 'placeOfDeathBn');
    pick('codEn', 'causeOfDeathEn');
    pick('codBn', 'causeOfDeathBn');
    pick('motherEn', 'motherNameEn');
    pick('motherBn', 'motherNameBn');
    pick('fatherEn', 'fatherNameEn');
    pick('fatherBn', 'fatherNameBn');
    pick('motherNatEn', 'motherNationalityEn');
    pick('motherNatBn', 'motherNationalityBn');
    pick('fatherNatEn', 'fatherNationalityEn');
    pick('fatherNatBn', 'fatherNationalityBn');
    pick('regDate', 'registrationDate');
    pick('issueDate', 'issuanceDate');
    // auto compute dodWords from dod if missing (In Word row)
    if (!t.dodWords && t.dod) {
        const months = { '01':'January','02':'February','03':'March','04':'April','05':'May','06':'June','07':'July','08':'August','09':'September','10':'October','11':'November','12':'December' };
        const days = ['','First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth','Tenth','Eleventh','Twelfth','Thirteenth','Fourteenth','Fifteenth','Sixteenth','Seventeenth','Eighteenth','Nineteenth','Twentieth','Twenty First','Twenty Second','Twenty Third','Twenty Fourth','Twenty Fifth','Twenty Sixth','Twenty Seventh','Twenty Eighth','Twenty Ninth','Thirtieth','Thirty First'];
        const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
        const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
        const m = String(t.dod).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) {
            const day = parseInt(m[1], 10), mn = m[2].padStart(2, '0'), yr = parseInt(m[3], 10);
            let ys = 'Two Thousand';
            if (yr >= 2000) { const r = yr - 2000; if (r > 0 && r < 20) ys += ' ' + ones[r]; else if (r >= 20) ys += ' ' + tens[Math.floor(r / 10)] + (r % 10 ? ' ' + ones[r % 10] : ''); }
            else { const r = yr - 1900; ys = 'Nineteen Hundred'; if (r > 0 && r < 20) ys += ' ' + ones[r]; else if (r >= 20) ys += ' ' + tens[Math.floor(r / 10)] + (r % 10 ? ' ' + ones[r % 10] : ''); }
            t.dodWords = days[day] + ' of ' + (months[mn] || 'January') + '  ' + ys;
        }
    }
    return t;
}

/* ---------------- preview (death replica HTML) ---------------- */
async function routePreview(req, res) {
    try {
        const d = await readJson(req);
        const html = buildDeathCertificateHtml(toTemplateFields(d), await buildAssets(d));
        json(res, 200, { success: true, html });
    } catch (e) {
        json(res, 500, { success: false, error: 'Preview failed: ' + e.message });
    }
}

/* ---------------- PDF (system Chrome, vector) ---------------- */
async function routePdf(req, res) {
    let tmpHtml = null, tmpPdf = null, prof = null;
    try {
        const d = await readJson(req);
        const html = buildDeathCertificateHtml(toTemplateFields(d), await buildAssets(d));
        const rnd = crypto.randomBytes(6).toString('hex');
        tmpHtml = path.join(require('os').tmpdir(), `dcert_${rnd}.html`);
        tmpPdf = path.join(require('os').tmpdir(), `dcert_${rnd}.pdf`);
        prof = path.join(require('os').tmpdir(), `dcert_prof_${rnd}`);
        fs.writeFileSync(tmpHtml, html, 'utf8');

        const url = 'file:///' + tmpHtml.replace(/\\/g, '/');
        await new Promise((resolve, reject) => {
            const ch = spawn(CHROME, [
                '--headless', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
                '--no-pdf-header-footer',
                '--user-data-dir=' + prof,
                '--print-to-pdf=' + tmpPdf,
                url
            ], { windowsHide: true });
            let err = '';
            ch.stderr.on('data', d2 => { err += d2; });
            ch.on('error', reject);
            ch.on('close', code => {
                if (code === 0 && fs.existsSync(tmpPdf)) resolve();
                else reject(new Error('Chrome pdf failed (code ' + code + '): ' + err.slice(0, 300)));
            });
        });
        const buf = fs.readFileSync(tmpPdf);
        res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename=Death_Certificate_${String(d.brn || '').trim() || 'output'}.pdf`,
            'Content-Length': buf.length
        });
        res.end(buf);
    } catch (e) {
        json(res, 500, { success: false, error: 'PDF failed: ' + e.message });
    } finally {
        for (const f of [tmpHtml, tmpPdf]) { try { if (f) fs.unlinkSync(f); } catch (_) {} }
        if (prof) { try { fs.rmSync(prof, { recursive: true, force: true }); } catch (_) {} }
    }
}

/* ---------------- server ---------------- */
// crash-proofing (engine hisabe cholle): unexpected error-e log rekhe
// supervisor/start-verify.bat jate karon dekhte pare. Port busy hole
// clear message + exit code 2 (silent crash NA). Localhost-only bind.
function logLine(s) {
    try { fs.appendFileSync(path.join(__dirname, 'server.log'), new Date().toISOString() + ' ' + s + '\n'); } catch (_) {}
}
process.on('uncaughtException', (e) => { logLine('UNCAUGHT: ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack || e)); });
const server = http.createServer(async (req, res) => {
    try {
        const u = new URL(req.url, 'http://localhost:' + PORT);
        const p = u.pathname;
        if (req.method === 'GET' && p === '/') return serveFile(res, path.join(__dirname, 'death-verify.html'), 'text/html; charset=utf-8');
        if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true });
if (req.method === 'GET' && p === '/api/captcha') return await routeCaptcha(res);
if (req.method === 'POST' && p === '/api/solve-captcha') return await routeSolveCaptcha(req, res);
if (req.method === 'POST' && p === '/api/verify') return await routeVerify(req, res);
        if (req.method === 'GET' && p === '/api/birth-debug') {
            const drn = String(u.searchParams.get('drn') || '').replace(/\D/g, '');
            const dob = String(u.searchParams.get('dob') || '').trim();
            if (!drn) return json(res, 400, { success: false, error: 'drn query-e din' });
            try {
                const html = await fetchBirthRecord(drn, dob);
                if (!html) return json(res, 200, { success: false, error: 'birth fetch fail (captcha/record) — _last-birth.html dekhen' });
                const b = normalizeBdrisData(mapBirthResultData(html));
                return json(res, 200, { success: true, data: b });
            } catch (e) { return json(res, 500, { success: false, error: e.message }); }
        }
        if (req.method === 'POST' && p === '/api/preview') return await routePreview(req, res);
        if (req.method === 'POST' && p === '/api/pdf') return await routePdf(req, res);
        if (req.method === 'GET' && p.startsWith('/assets/')) {
            const rel = path.normalize(p.slice(1));
            const full = path.join(__dirname, rel);
            if (!full.startsWith(__dirname) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404); return res.end('no'); }
            const types = { '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.js': 'application/javascript' };
            return serveFile(res, full, types[path.extname(full).toLowerCase()] || 'application/octet-stream');
        }
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'not found' }));
    } catch (e) {
        try { json(res, 500, { error: e.message }); } catch (_) {}
    }
});
server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
        const msg = `Port ${PORT} busy — arekta instance cholche? (exit 2)`;
        console.error(msg);
        logLine('EADDRINUSE: ' + msg);
        process.exit(2);
    }
    logLine('SERVER ERROR: ' + (e && e.stack || e));
});
server.listen(PORT, '127.0.0.1', () => {
    console.log('Death verify tool: http://localhost:' + PORT);
});

