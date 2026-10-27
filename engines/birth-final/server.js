const express = require('express');
const puppeteer = require('puppeteer'); // only for local PDF rendering
const cors = require('cors');
const bodyParser = require('body-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const QRCode = require('qrcode');
const engine = require('./engine');
const store = require('./store');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// Embedded certificate fonts (assets/fonts.css — @font-face + base64 woff2).
// The certificate carries its own fonts: same render on every machine,
// no font install needed. Read once, cache.
let _fontsCss = null;
function fontsCss() {
    if (_fontsCss === null) {
        _fontsCss = fs.readFileSync(path.join(__dirname, 'assets', 'fonts.css'), 'utf8');
    }
    return _fontsCss;
}

// TLS fix: everify.bdris.gov.bd-এর TLS 1.3 handshake কিছু network-এ ভাঙে
// ("bad ecpoint" error)। তাই এই app-এর সব HTTPS কল TLS 1.2 দিয়ে হবে।
// (কোডেই বসানো — আলাদা env var/flag লাগবে না।)
require('node:tls').DEFAULT_MAX_VERSION = 'TLSv1.2';

const app = express();
const port = parseInt(process.env.BIRTH_ENGINE_PORT || '3000', 10);

app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

// Serve the Studio UI
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ---------------------------------------------------------------------------
// Gemini API key MUST come from the environment. Never hardcode it.
// Windows (cmd):         set GEMINI_API_KEY=your_key_here
// Windows (PowerShell):  $env:GEMINI_API_KEY="your_key_here"
// Used ONLY for the optional "Auto Calculate" captcha helper button.
// Without it, you can still type the captcha answer manually.
// ---------------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;

// ---------------------------------------------------------------------------
// everify.bdris.gov.bd access uses plain HTTP (no browser needed).
// The captcha image, form tokens and cookies are kept in a short-lived
// session between:
//   GET  /api/captcha  -> captcha image
//   POST /api/verify   -> submit BRN + DOB + captcha answer, scrape result
// Sessions expire after 5 minutes.
// ---------------------------------------------------------------------------
const EVERIFY = 'https://everify.bdris.gov.bd';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sessions = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
    }
}, 60 * 1000);

// --- minimal cookie jar -----------------------------------------------------
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

// --- captcha auto-solve (optional helper) ------------------------------------
async function solveCaptchaWithGemini(captchaB64, mimeType) {
    if (!genAI) throw new Error('GEMINI_API_KEY is not set.');
    const imageParts = [{ inlineData: { data: captchaB64, mimeType: mimeType || 'image/png' } }];
    const modelsToTry = ['gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-flash-latest'];
    const prompt = "Solve the math problem shown in this image. If it's a math problem like '92-48=?', return only the final calculated number (e.g. 44). If it is just a string of random letters and numbers, return those exactly. ONLY return the final answer without any explanation or extra text. Make sure you calculate correctly.";
    let lastErr = null;
    const withTimeout = (p, ms, msg) => Promise.race([
        p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
    ]);
    for (let attempt = 1; attempt <= 3; attempt++) {
        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await withTimeout(model.generateContent([prompt, ...imageParts]), 45000, 'Gemini timeout');
                return result.response.text().trim();
            } catch (e) {
                lastErr = e;
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }
    throw lastErr || new Error('Captcha auto-solve failed.');
}

// --- Step 1: fetch fresh captcha + form tokens --------------------------------
// Birth search only (UBRNVerification on the home page). The token+captcha
// must come from the SAME form page that will receive the search POST.
app.get('/api/captcha', async (req, res) => {
    const pagePath = '/';
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
                throw new Error('ছবি ঠিকমতো আসেনি — আবার চেষ্টা করুন।');
            // BDRIS-এর লাল-X placeholder (bot-block) ধরা পড়লে retry
            const bhash = crypto.createHash('sha256').update(buf).digest('hex');
            if (bhash === '7021ec2d5a98f5d470fd25303948246c1603ebe65a6c2bf07d58a644a8974536')
                throw new Error('BDRIS captcha দেয়নি (লাল X) — আবার চেষ্টা করুন।');

            const id = crypto.randomBytes(16).toString('hex');
            sessions.set(id, {
                jar, token, captchaDeText,
                captchaB64: buf.toString('base64'),
                captchaMime: imgRes.headers.get('content-type') || 'image/png',
                createdAt: Date.now()
            });
            setTimeout(() => sessions.delete(id), SESSION_TTL_MS);

            const mime = (imgRes.headers.get('content-type') || 'image/png').split(';')[0];
            return res.json({
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
    res.status(500).json({ success: false, error: 'Could not load captcha: ' + (lastErr && lastErr.message) });
});

// --- offline captcha solver (solve_local.py: opencv + ddddocr, zero API) ----
// 1st choice — Gemini lagbe na, net lagbe na (BDRIS captcha image chara).
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
    const sharedScript = path.join(__dirname, '..', 'shared', 'solve_local.py');
    const script = fs.existsSync(sharedScript) ? sharedScript : path.join(__dirname, 'solve_local.py');
    if (!fs.existsSync(script)) return null;
    const pyCmd = findPython();
    if (!pyCmd) return null;
    const ext = (mimeType || '').indexOf('png') >= 0 ? '.png' : '.gif';
    const tmp = path.join(os.tmpdir(), 'beng_cap_' + crypto.randomBytes(6).toString('hex') + ext);
    try {
        fs.writeFileSync(tmp, Buffer.from(captchaB64, 'base64'));
        const out = await new Promise((resolve) => {
            let buf = '';
            let done = false;
            const finish = (v) => { if (!done) { done = true; resolve(v); } };
            let py;
            try {
                py = spawn(pyCmd[0], pyCmd.slice(1).concat([script, tmp]), { windowsHide: true });
            } catch (e) { return finish(null); }
            const killer = setTimeout(() => { try { py.kill(); } catch (_) {} finish(null); }, 120000);
            py.stdout.on('data', d => { buf += d; });
            py.stderr.on('data', () => {});
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

// --- Optional helper: "Auto Calculate" button ---------------------------------
// Chain: 1) LOCAL offline solver -> 2) Gemini (key thakle) -> 3) manual input.
app.post('/api/solve-captcha', async (req, res) => {
    const s = sessions.get((req.body || {}).sessionId);
    if (!s) return res.status(400).json({ success: false, error: 'Session expired. Fetch a new captcha.' });
    const local = await solveCaptchaLocal(s.captchaB64, s.captchaMime);
    if (local) return res.json({ success: true, answer: local, method: 'local' });
    if (!GEMINI_API_KEY || GEMINI_API_KEY === 'PASTE_YOUR_KEY_HERE')
        return res.status(400).json({ success: false, error: 'Auto-solve failed (local + no key) — captcha manually likhun. (start.bat-এ Gemini key thakle auto try hobe.)' });
    try {
        const answer = await solveCaptchaWithGemini(s.captchaB64, s.captchaMime);
        res.json({ success: true, answer, method: 'gemini' });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Auto-solve failed: ' + (e.message || 'unknown error') });
    }
});

// --- Step 2: submit + scrape ---------------------------------------------------
function extractTdTexts(html) {
    const raw = String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ');
    const unesc = (s) => String(s)
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

    // (a) table cells — <td> AND <th>, document-order-e (label <th>-e holeo nay;
    //     purano shudhu-<td> code-e eta-i 100% data haranor karon chhilo).
    const cells = [];
    const re = /<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(raw)) !== null) cells.push(unesc(m[2]));

    // (b) kono table na thakle (div/span/label layout) — tag-boundary diye tokenize
    if (!cells.length) {
        const SEP = '\u0001';
        return raw
            .replace(/<\/(?:div|p|tr|li|h[1-6]|span|section|label|dt|dd)>/gi, SEP)
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .split(SEP)
            .map(s => s.replace(/\s+/g, ' ').trim())
            .filter(Boolean);
    }
    return cells;
}

// Tolerant label normalize: markup/space/case/punctuation drift jeneo match koro.
function nlab(s) {
    return String(s == null ? '' : s)
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/[\u200b-\u200d\ufeff]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()
        .replace(/[\s]*[:：.,]+$/, '')
        .trim();
}

// Field -> label aliases (EN + BN). Edit korlei notun label support hobe.
const RESULT_LABELS = {
    registrationDate: ['registration date', 'date of registration', 'reg date', 'reg. date',
        'registration date of', 'নিবন্ধনের তারিখ', 'নিবন্ধন তারিখ'],
    issuanceDate: ['issuance date', 'date of issuance', 'issue date', 'date of issue',
        'issued date', 'issue date of', 'ইস্যুর তারিখ', 'প্রদানের তারিখ'],
    registrationOffice: ['registration office', 'register office', 'office of the registrar',
        'registration place', 'reg office', 'নিবন্ধন কার্যালয়', 'নিবন্ধনকার্যালয়'],
    dob: ['date of birth', 'birth date', 'date of brith', 'dob', 'জন্ম তারিখ'],
    brn: ['birth registration number', 'birth registration no', 'birth reg. no', 'birth reg no',
        'ubrn', 'registration number', 'registration no', 'জন্ম নিবন্ধন নম্বর', 'নিবন্ধন নম্বর'],
    sex: ['sex', 'gender', 'লিঙ্গ', 'লিঙग'],
};

// Value validation (bhul cell-e jawa rokhte) — jodi value na mile, porer offset try hoy.
const FIELD_VALID = {
    registrationDate: v => /\d/.test(v) && /\d{4}/.test(v),
    issuanceDate: v => /\d/.test(v) && /\d{4}/.test(v),
    dob: v => /\d/.test(v) && /\d{4}/.test(v),
    brn: v => /\d{8,}/.test(v),
    sex: v => /^(male|female|other|others|m|f)\b/i.test(String(v).trim()) || /পুরুষ|নারী|অন্যান্য/.test(v),
    registrationOffice: v => String(v).replace(/\s/g, '').length > 3
        && !/\d{4}/.test(v)                                   // date na
        && !/^(date|number|no|sex|dob|brn|birth registration)\b/i.test(String(v).trim()),
};

// Niyom: i+1 (pair layout) age try, tarpor i+3 (grid layout), tarpor baki offset.
// Kintu label cell ba validator-fail value kabar hobe na.
function mapResultData(tds) {
    const data = {};
    const cells = (tds || []).map(t => String(t == null ? '' : t).replace(/\s+/g, ' ').trim());
    const N = cells.map(nlab);

    const LABEL_SET = new Set();
    for (const k of Object.keys(RESULT_LABELS)) for (const a of RESULT_LABELS[k]) LABEL_SET.add(a);
    // Ei cell gulo kokhono value na — value candidate hisebe skip hobe.
    ['registered person name', 'place of birth', "mother's name", "father's name",
     "mother's nationality", "father's nationality", 'permanent address', 'present address',
     'smart card info', 'license documents', 'verify by nid', 'no documents available'
    ].forEach(x => LABEL_SET.add(x));
    const isLabel = i => i >= 0 && i < N.length && LABEL_SET.has(N[i]);

    const used = new Set();
    const setField = (field, val) => {
        if (!val || data[field]) return;
        const ok = FIELD_VALID[field];
        if (ok && !ok(val)) return;   // validator fail -> dhoro na (fallback porobortiye bhorte parbe)
        data[field] = val;
        used.add(val);                // ek-i value dui field-e jabe na
    };

    // ---- PASS A: layout-agnostic RUN detection -----------------------------
    // Kono BDRIS table dui rkom hoy:
    //   grid : [L1 L2 L3][V1 V2 V3]  (label-run porer runLen ta cell = value)
    //   pair : [L1 V1][L2 V2]        (runLen=1, porer taich = value)
    // Label-run dhor (majhkhan-e khaali cell thakleo) — run-er niye STRRICT
    // positional: runLen-ta porer cell-i value (khaali value hole position
    // na-sarate rakhbe, na hole porer row-er value ageye jabe).
    const nextNonEmpty = (from) => { for (let j = from; j < cells.length; j++) if (cells[j]) return j; return -1; };
    for (let i = 0; i < cells.length;) {
        if (!isLabel(i)) { i++; continue; }
        const runIdx = [i];
        let last = i;
        let j = nextNonEmpty(i + 1);
        while (j >= 0 && isLabel(j)) { runIdx.push(j); last = j; j = nextNonEmpty(j + 1); }
        for (let k = 0; k < runIdx.length; k++) {
            const lab = N[runIdx[k]];
            const v = cells[last + 1 + k] || '';   // strict positional (empties included)
            for (const field of Object.keys(RESULT_LABELS)) {
                if (data[field]) continue;
                if (RESULT_LABELS[field].includes(lab)) setField(field, v);
            }
        }
        i = last + 1;
    }

    // ---- PASS B: forward-scan fallback (run/positional miss hole) ----------
    // Nije theke age, already-berokto value skip, validator milate hobe.
    const nearestValid = (i, field) => {
        const valid = FIELD_VALID[field] || (() => true);
        for (let j = i + 1; j < cells.length; j++) {
            const v = cells[j];
            if (!v || isLabel(j) || used.has(v)) continue;
            if (valid(v)) return v;
        }
        return '';
    };

    for (let i = 0; i < cells.length; i++) {
        const text = cells[i];
        const lab = N[i];

        // 1) fallback: ei label er field ekhono khali hole nearest-valid value
        for (const field of Object.keys(RESULT_LABELS)) {
            if (data[field]) continue;
            if (RESULT_LABELS[field].includes(lab)) setField(field, nearestValid(i, field));
        }

        // 2) single-cell "Label: value" pattern
        const m = text.match(/^([^:：]{3,48})\s*[:：]\s*(.+)$/);
        if (m) {
            const klab = nlab(m[1]);
            for (const field of Object.keys(RESULT_LABELS)) {
                if (data[field]) continue;
                if (RESULT_LABELS[field].includes(klab)) setField(field, m[2].trim());
            }
        }

        // 3) NB footer: "Location of the Register office : A, B, C. everify..."
        // Robustness layers (2026-10-27): the live HTML sometimes splits
        // the label and the value into separate cells. A label-only cell
        // ("Location of the Register office :") would otherwise leave
        // office2 empty even though the value sits in the next cell, so
        // append the next non-empty, non-label cell when the label cell
        // itself carries no location value.
        if (/location of the register office/i.test(text) && !data.officeLocationRaw) {
            data.officeLocationRaw = text;
            const afterLabel = String(text).replace(/^.*location of the register office\s*:?\s*/i, '').replace(/[^A-Za-z0-9,\s]/g, '').trim();
            if (!afterLabel) {
                for (let j = i + 1; j < cells.length; j++) {
                    const v = String(cells[j] || '').trim();
                    if (!v || isLabel(j)) continue;
                    data.officeLocationRaw = text + ' ' + v;
                    break;
                }
            }
        }

        // 4) pair cells: label at i -> value i+1, Bn value i-1 (layout unchanged)
        if (text.includes('Registered Person Name')) { data.nameEn = cells[i + 1]; data.nameBn = cells[i - 1]; }
        if (text.includes('Place of Birth')) { data.placeOfBirthEn = cells[i + 1]; data.placeOfBirthBn = cells[i - 1]; }
        if (text.includes("Mother's Name")) { data.motherNameEn = cells[i + 1]; data.motherNameBn = cells[i - 1]; }
        if (text.includes("Mother's Nationality")) { data.motherNationalityEn = cells[i + 1]; data.motherNationalityBn = cells[i - 1]; }
        if (text.includes("Father's Name")) { data.fatherNameEn = cells[i + 1]; data.fatherNameBn = cells[i - 1]; }
        if (text.includes("Father's Nationality")) { data.fatherNationalityEn = cells[i + 1]; data.fatherNationalityBn = cells[i - 1]; }
        if (text.includes('Permanent Address')) { data.permanentAddressEn = cells[i + 1]; data.permanentAddressBn = cells[i - 1]; }
    }

    // 5) safety net: kono layout-e label/labeler porer cell theke date/office khujo
    if (!data.registrationDate || !data.issuanceDate || !data.registrationOffice || !data.brn) {
        const near = (labPat, valid) => {
            const k = cells.findIndex((c, idx) => labPat.test(N[idx] || c));
            if (k < 0) return '';
            for (let j = k + 1; j < Math.min(k + 5, cells.length); j++) {
                const v = cells[j];
                if (!v || isLabel(j)) continue;
                if (!valid || valid(v)) return v;
            }
            return '';
        };
        if (!data.registrationDate) setField('registrationDate', near(/^registration date$|^date of registration$/i, FIELD_VALID.registrationDate));
        if (!data.issuanceDate) setField('issuanceDate', near(/^issuance date$|^issue date$|^date of issuance$/i, FIELD_VALID.issuanceDate));
        if (!data.registrationOffice) setField('registrationOffice', near(/^registration office$|^register office$|^office of the registrar$/i, FIELD_VALID.registrationOffice));
        if (!data.brn) {
            const k = cells.findIndex(c => /birth registration number/i.test(c));
            if (k >= 0) {
                for (let j = k + 1; j < Math.min(k + 5, cells.length); j++) {
                    const mm = cells[j].match(/\d{10,20}/);
                    if (mm) { setField('brn', mm[0]); break; }
                }
            }
        }
    }
    return data;
}

// BDRIS API-র raw data-কে genuine certificate format-এ normalize করো
function normalizeBdrisData(data) {
    const out = { ...data };

    // Strip stray artifacts: backticks, quotes from API data
    // Apostrophes inside a word are genuine (Cox's Bazar) — strip only
    // stray quotes/backticks and apostrophes NOT between two letters.
    const clean = (s) => String(s || '').replace(/[`"‘’“”]/g, '').replace(/(?<![A-Za-z])'|'(?![A-Za-z])/g, '').trim();
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

    // --- English names/places: Title Case ---
    for (const k of ['nameEn', 'motherNameEn', 'fatherNameEn', 'placeOfBirthEn', 'permanentAddressEn', 'registrationOffice']) {
        if (out[k]) out[k] = titleCase(out[k]);
    }
    // Nationality: "BANGLADESHI" -> "Bangladeshi"
    for (const k of ['motherNationalityEn', 'fatherNationalityEn']) {
        if (out[k]) out[k] = titleCase(out[k]);
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
    // first token if it repeats office1: exact match, or (3+ tokens and)
    // office1's first part starts with it (e.g. NB
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
            // Footer junk that can trail the location when no everify
            // marker precedes it (e.g. "© 2026 - Developed and maintained
            // by ...") — a real location never contains these, so strip
            // from the first such marker onward instead of showing junk
            // as part of office2.
            loc = loc.split(/©/)[0].replace(/developed and maintained.*$/i, '').replace(/is the official website.*$/i, '').trim().replace(/[.。]+$/, '').trim();
            const lp = loc.split(',').map(x => x.trim()).filter(Boolean);
            if (lp.length > 1) {
                if (out.office1) {
                    const firstPart = String(out.office1).split(',')[0].trim().toLowerCase();
                    const firstTok = lp[0].toLowerCase();
                    // Drop the NB first token when it repeats office1: exact match,
                    // or (NB has 3+ tokens and) office1's first part starts with it
                    // (e.g. office1 "Bagoan Union Parishad" + NB "Bagoan, Raozan,
                    // Chattogram" -> "Raozan, Chattogram"). The 3+ guard keeps a
                    // 2-token NB intact (e.g. office1 "Raozan Union Parishad" +
                    // NB "Raozan, Chattogram" stays "Raozan, Chattogram").
                    const looseKey = (t) => String(t || '').toLowerCase().replace(/[\.\-\u2010-\u2015,\u0964]/g, '').replace(/\s+/g, '');
                    const dropFirst = firstPart === firstTok ||
                        looseKey(firstPart) === looseKey(firstTok) ||
                        (lp.length > 2 && (firstPart.startsWith(firstTok + ' ') || looseKey(firstPart).startsWith(looseKey(firstTok))));
                    const locParts = dropFirst ? lp.slice(1) : lp;
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

    // --- Place of Birth: ", Bangladesh" / ", বাংলাদেশ" যোগ করো ---
    // (BDRIS দেয় bare "SIRAJGANJ"/"সিরাজগঞ্জ", replica-তে country suffix থাকে)
    if (out.placeOfBirthEn && !/bangladesh/i.test(out.placeOfBirthEn)) {
        out.placeOfBirthEn += ', Bangladesh';
    }
    if (out.placeOfBirthBn && !/বাংলাদেশ/.test(out.placeOfBirthBn)) {
        out.placeOfBirthBn += ', বাংলাদেশ';
    }

    // --- Sex: "MALE" -> "Male" ---
    if (out.sex) out.sex = titleCase(out.sex);

    return out;
}

app.post('/api/verify', async (req, res) => {
    const { sessionId, brn, dob, captcha } = req.body || {};
    const s = sessions.get(sessionId);
    if (!s) return res.status(400).json({ success: false, error: 'Session expired. Fetch a new captcha.' });
    if (!brn || !dob || !captcha) {
        return res.status(400).json({ success: false, error: 'BRN, DOB and captcha answer are required.' });
    }
    sessions.delete(sessionId); // one-shot session
    // Birth search only: POST /UBRNVerification/Search from the home form.
    const formPage = '/';
    const searchPath = '/UBRNVerification/Search';

    let dobFmt = String(dob).trim().replace(/\//g, '-');
    // yyyy-MM-dd আকারে normalize করো (input yyyy-MM-dd বা dd-MM-yyyy যাই হোক)
    const dm = dobFmt.match(/^(\d{1,4})-(\d{1,2})-(\d{1,4})$/);
    if (dm) {
        if (dm[1].length === 4) dobFmt = `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`;
        else if (dm[3].length === 4) dobFmt = `${dm[3]}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`;
    }

    try {
        const body = new URLSearchParams({
            __RequestVerificationToken: s.token,
            CaptchaDeText: s.captchaDeText,
            ubrn: String(brn).trim(),
            BirthDate: dobFmt,
            CaptchaInputText: String(captcha).trim()
        });
        const r = await fetch(EVERIFY + searchPath, {
            method: 'POST',
            signal: AbortSignal.timeout(60000),
            headers: {
                'User-Agent': UA,
                'Cookie': jarHeader(s.jar),
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': EVERIFY + formPage
            },
            body
        });
        const html = await r.text();
        // Verify page save — shudhu fail korle thake (structure dekhe fix kora jabe).
        // Success-e niche file-ta delete hoy, jate shofol record-er personal page disk-e pore na thake.
        try { require('fs').writeFileSync(require('path').join(__dirname, 'last-result.html'), html); } catch (_) {}

        if (/error in data retr/i.test(html)) {
            return res.json({ success: false, error: 'BDRIS error: Error in Data retrieving. Please retry another time.' });
        }

        if (html.includes('No record found') || html.includes('Captcha is not valid') || html.includes('Does not match')) {
            return res.json({ success: false, error: 'Data not found or captcha wrong. Fetch a new captcha and try again.' });
        }

        const tds = extractTdTexts(html);
        // NB footer table-r baire (<p>/<div>) hole td-th parse-e ashe na —
        // pura html theke office location niche nao, nahole office2 khali thake.
        if (!tds.some(t => /location of the register office/i.test(t))) {
            const m = String(html)
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/gi, ' ')
                .replace(/\s+/g, ' ')
                // 2026-10-27: [^.] broke locations starting with a dotted
                // abbreviation (e.g. "P.M. KHALI, ...") — the first dot ended
                // the capture, so no fallback cell was pushed and office2
                // stayed empty even though the location IS on the page.
                // Capture up to the footer boilerplate marker instead;
                // normalizeBdrisData already splits at ". everify"/http/www
                // and strips trailing dots, so trailing junk is cleaned there.
                .match(/location of the register office\s*:?\s*((?:(?!\.\s*(?:everify|https?:|www\.)).){2,300})/i);
            if (m) tds.push('Location of the Register office: ' + m[1].trim());
        }
        const data = normalizeBdrisData(mapResultData(tds));

        // 6 fallback pairs provided by user (BIRTH records only)
        const qrFallbackList = [
            { code: 'DZIH', url: 'https://bdris.gov.bd/certificate/verify?key=Y2p7chu0b0iI8aWymonnhfkpKoOKE3J5kRsiGb0ZVOe0SqgyoCnMtFT+wx+Ikn/O' },
            { code: 'DMIQ', url: 'https://bdris.gov.bd/certificate/verify?key=5gsdKUqk6MwdcGXYQrJJ3oFDeWtXYcK8sjPw9HTPyimw/CAb4Mia41mwDYBdwU/z' },
            { code: 'AEMA', url: 'https://bdris.gov.bd/certificate/verify?key=NstWvr0h0rOGf84T/VVLyG/k4N0SH4MULThJN9NKQzrcZXdnNjfrHy3f6R3cKkcP' },
            { code: 'RQHQ', url: 'https://bdris.gov.bd/certificate/verify?key=KU32mvimW7KmtS/jr0hNN1VZHRwISZmcLnrzJYmadhEkpmcxFDEqLIy0exp3OVbG' },
            { code: 'IRIA', url: 'https://bdris.gov.bd/certificate/verify?key=znKwFj1Z1NAmN1Pgt4f/wcjTogYsu7aOytY8p2pk3OvTRDJkegjZjefRlv1GgJ+u' },
            { code: 'ERRD', url: 'https://bdris.gov.bd/certificate/verify?key=S/m6tkNVXq24lDXol5XRdF6zC/FRDZq327Fk7Ur9UJX94kJHLkB5tA2nX83QsVYF' }
        ];
        // Select one randomly (fallback when the result page carries no QR key)
        const randomQr = qrFallbackList[Math.floor(Math.random() * qrFallbackList.length)];
        data.verificationCode = randomQr.code;
        data.verificationUrl = randomQr.url; // Use as default fallback
        data.recordType = 'birth';

        // Auto-extract verification URL/QR from BDRIS response if present (override if found)
        // Pattern: https://bdris.gov.bd/certificate/verify?key=...
        const verifyUrlMatch = html.match(/https:\/\/bdris\.gov\.bd\/certificate\/verify\?key=[A-Za-z0-9+\/=%_-]+/);
        if (verifyUrlMatch) {
            data.verificationUrl = verifyUrlMatch[0];
        }
        // Also check for QR code image src that might contain the key
        const qrImgMatch = html.match(/<img[^>]+src=["']([^"']*(?:qr|QR|verify)[^"']*)["']/i);
        if (qrImgMatch && !verifyUrlMatch) {
            data.qrImageSrc = qrImgMatch[1];
        }
        if (!data.brn && !data.nameEn) {
            return res.json({ success: false, error: 'Could not read the result. Fetch a new captcha and try again. (last-result.html saved)', debug: tds.slice(0, 40) });
        }
        // Missing-field diagnostic — builder app-e ki ki parse hocche dekhte parben.
        // (registrationOffice NA — output-e office1+office2 i canonical address.)
        const miss = ['registrationDate', 'issuanceDate', 'office1', 'office2']
            .filter(k => !data[k]);
        if (miss.length) data.missingFields = miss;
        // Success: last-result.html rakha dorkar nei — data frontend-e geche.
        try { require('fs').unlinkSync(require('path').join(__dirname, 'last-result.html')); } catch (_) {}
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Code engine API: number -> key -> verify URL -> QR + CODE128 barcode
// plus a record store (Oracle if ORACLE_* env set, otherwise local JSON file)
// ---------------------------------------------------------------------------
app.post('/api/engine', async (req, res) => {
    try {
        const body = req.body || {};
        const number = body.number || req.query.number;
        const url = body.url || req.query.url;
        if (!number) return res.status(400).json({ success: false, error: 'number is required' });
        res.json({ success: true, engine: await engine.build({ number, url }) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/api/records', async (req, res) => {
    try {
        const body = req.body || {};
        const number = String(body.number || '').trim();
        if (!number) return res.status(400).json({ success: false, error: 'number is required' });
        const built = await engine.build({ number, url: body.url });
        const saved = await store.saveRecord({
            number,
            name: body.name || null,
            key: built.key,
            verifyUrl: built.verifyUrl,
            keySource: built.keySource,
            payload: body.data || body.payload || {}
        });
        // saveRecord already returns the real destination; store.mode is only
        // the configured mode, so it lies when Oracle degraded to file.
        res.json({ success: true, number, key: built.key, keySource: built.keySource,
                   code: built.code, verifyUrl: built.verifyUrl, savedTo: saved.savedTo });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/records', async (req, res) => {
    try {
        res.json({ success: true, mode: store.effectiveMode(), records: await store.listRecords(req.query.limit) });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/records/:number', async (req, res) => {
    try {
        const rec = await store.getRecord(req.params.number);
        if (!rec) return res.status(404).json({ success: false, error: 'record not found' });
        const built = await engine.build({ number: rec.number, url: rec.verifyUrl || undefined });
        res.json({ success: true, record: rec, engine: built });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/store/health', async (req, res) => {
    try {
        res.json(Object.assign({ success: true }, await store.health()));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ---------------------------------------------------------------------------
// Certificate rendering
// ---------------------------------------------------------------------------
const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// English thikana user jemon-i likhuk (all small / ALL CAPS / mixed) —
// certificate-e TITLE CASE diye print hoy:
//   "amal chy bari,middle mohara"  -> "Amal Chy Bari, Middle Mohara"
//   "AMAL CHY BARI, MIDDLE MOHARA" -> "Amal Chy Bari, Middle Mohara"
// (position/font rules age-er motoi; kono font size badol na.)
const titleCaseAddr = (s) => String(s == null ? '' : s)
    .replace(/\s*,\s*/g, ', ')   // comma spacing uniform: "bari,middle" -> "bari, middle"
    .replace(/\s+/g, ' ')        // double space / tab clean
    .trim()
    .split(' ')
    .map(w => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w)
    .join(' ');

// Replica layout (same look as birth-certificate/index.html), driven by record data.
// Positions/fonts are the scan-measured replica values; QR + barcode come from
// the shared engine (cert-engine.js) via buildAssets. No client JS needed:
// everything (codes included) is baked into this HTML server-side.
function buildCertificateHtml(d, assets) {
    // collapse-proof spaces (replica uses &nbsp; for the double space in dobWords)
    const N = (s) => esc(s).replace(/ {2,}/g, (m) => '&nbsp;'.repeat(m.length));
    const bnL = String(d.permBn == null ? '' : d.permBn).split('\n');
    const enL = String(d.permEn == null ? '' : d.permEn).split(/\r?\n/).map(titleCaseAddr);
    const brnText = String(d.brn == null ? '' : d.brn);

    return `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="utf-8">
<title>Birth Registration Certificate - ${esc(brnText)}</title>
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
  .qhhi { position: absolute; left: 14.5mm; top: 52.1mm; width: 29.0mm; z-index: 1; line-height: 1;
           text-align: center; font-size: 11.2pt; color: #787373; letter-spacing: 0.15px;
           font-family: Arial, sans-serif; font-weight: normal; }
  .logo { position: absolute; left: 86.7mm; top: 10.0mm; width: 22.1mm; z-index: 1; }
  .bar  { position: absolute; left: 134.2mm; top: 21.1mm; width: 48.5mm; height: 7.8mm; z-index: 1; }
  .hc { position: absolute; left: 0; width: 210mm; text-align: center; z-index: 1; white-space: nowrap; line-height: 1.15; }
  .f11 { font-size: 11pt; } .f115 { font-size: 11.5pt; } .f105 { font-size: 10.5pt; }
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
  <div class="hc f105 txt" style="top:60.76mm; padding-left:11.06mm; font-family:Verdana, sans-serif; font-size:8.75pt; letter-spacing:0.2px;">(Rule 9, 10)</div>
  <div class="el txt b" style="left:53.3mm; top:66.3mm; font-size:15pt; line-height:1; font-family:'SutonnyOMJ'; transform:scaleX(1.011); transform-origin:left bottom">জন্ম নিবন্ধন সনদ</div>
  <div class="el txt b" style="left:82.6mm; top:65.3mm; font-size:16.8pt; line-height:1; font-family:Constantia, 'Times New Roman', serif;">/ Birth Registration Certificate</div>

  <!-- meta -->
  <div class="el txt f11" style="left:23.0mm; top:78.6mm; font-family:Candara, sans-serif; font-size:10.74pt; letter-spacing:0.15px;">Date of Registration</div>
  <div class="el txt f11" style="left:23.0mm; top:84.18mm; font-family:Arial, sans-serif; font-size:9.15pt; letter-spacing:1.05px;">${esc(d.regDate)}</div>
  <div class="el txt f11" style="left:1.82mm; width:204.2mm; text-align:center; top:78.87mm; font-family:Verdana, sans-serif; font-size:10.89pt; letter-spacing:0.60px;">Birth Registration Number</div>
  <div class="el txt b" style="left:0mm; width:207.6mm; text-align:center; top:83.7mm; font-size:12.5pt; font-family:'Trebuchet MS', sans-serif; transform:scaleX(1.016);">${esc(brnText)}</div>
  <div class="el txt f11" style="left:152.0mm; top:78.6mm; font-size:10.56pt; letter-spacing:0.15px;">Date of Issuance</div>
  <div class="el txt f11" style="left:152.3mm; top:84.18mm; font-family:Arial, sans-serif; font-size:9.15pt; letter-spacing:1.05px;">${esc(d.issueDate)}</div>

  <!-- dob -->
  <div class="el txt f11" style="left:22.8mm; top:98.2mm; font-family:Verdana, sans-serif; font-size:11pt;">Date of Birth</div>
  <div class="el txt f11" style="left:53.4mm; top:98.2mm;">:</div>
  <div class="el txt f11" style="left:56.06mm; top:98.35mm; font-family:Arial, sans-serif; font-weight:normal; font-size:12.04pt; letter-spacing:0.60px;">${esc(d.dob)}</div>
  <div class="el txt f11" style="left:131.3mm; top:98.2mm; font-family:Verdana, sans-serif;">Sex</div>
  <div class="el txt f11" style="left:139.9mm; top:98.2mm;">:</div>
  <div class="el txt f11" style="left:142.5mm; top:98.2mm; font-family:Verdana, sans-serif;">${esc(d.sex)}</div>
  <div class="el txt f11" style="left:22.6mm; top:104.8mm; font-size:12.7pt;">In Word</div>
  <div class="el txt f11" style="left:53.4mm; top:104.8mm;">:</div>
  <div class="el txt f11 it" style="left:55.47mm; top:104.8mm; transform:scaleX(1.159); transform-origin:left center;">${N(d.dobWords)}</div>

  <!-- column standard (forensic-locked, do NOT drift):
       BN label ~23.0 | BN ':' 53.40 | BN value ~56.3 || EN label 101.55 | EN ':' 128.10 | EN value 131.10.
       DOB/Sex + address rows have own traced geometry. Khali value = blank thake. -->
  <!-- row 1 -->
  <div class="el txt f11" style="left:23.1mm; top:118.7mm; font-family:'SutonnyOMJ'; transform:scaleX(0.990); transform-origin:left bottom">নাম</div>
  <div class="el txt f11" style="left:53.4mm; top:117.8mm;">:</div>
  <div class="el txt f11" style="left:56.59mm; top:118.75mm; font-family:'SutonnyOMJ'; transform:scaleX(1.069); transform-origin:left bottom">${esc(d.nameBn)}</div>
  <div class="el txt f11" style="left:101.55mm; top:118.1mm; font-family:Verdana, sans-serif; transform:scaleX(1.047); transform-origin:left center;">Name</div>
  <div class="el txt f11" style="left:128.1mm; top:118.1mm;">:</div>
  <div class="el txt f11" style="left:131.1mm; top:118.1mm; font-family:Tahoma, sans-serif; letter-spacing:0.92px; transform:scaleX(1.008); transform-origin:left center;">${esc(d.nameEn)}</div>

  <!-- row 2 -->
  <div class="el txt f11" style="left:22.9mm; top:128.15mm; font-family:'SutonnyOMJ'; transform:scaleX(1.096); transform-origin:left bottom">মাতা</div>
  <div class="el txt f11" style="left:53.4mm; top:127.8mm;">:</div>
  <div class="el txt f11" style="left:56.31mm; top:128.4mm; font-family:'SutonnyOMJ'; transform:scaleX(1.061); transform-origin:left bottom">${esc(d.motherBn)}</div>
  <div class="el txt f11" style="left:101.55mm; top:127.8mm; font-family:Verdana, sans-serif;">Mother</div>
  <div class="el txt f11" style="left:128.1mm; top:127.8mm;">:</div>
  <div class="el txt f11" style="left:131.1mm; top:127.8mm; font-family:Tahoma, sans-serif; letter-spacing:1.06px; transform:scaleX(1.006); transform-origin:left center;">${esc(d.motherEn)}</div>

  <!-- row 3 -->
  <div class="el txt f11" style="left:22.7mm; top:138.35mm; font-family:'SutonnyOMJ'; transform:scaleX(1.046); transform-origin:left bottom">মাতার জাতীয়তা</div>
  <div class="el txt f11" style="left:53.4mm; top:137.4mm;">:</div>
  <div class="el txt f11" style="left:55.90mm; top:138.4mm; font-family:'SutonnyOMJ'; transform:scaleX(1.067); transform-origin:left bottom">${esc(d.motherNatBn)}</div>
  <div class="el txt f11" style="left:101.55mm; top:137.7mm; font-family:Verdana, sans-serif; transform:scaleX(1.03); transform-origin:left center;">Nationality</div>
  <div class="el txt f11" style="left:128.1mm; top:137.7mm;">:</div>
  <div class="el txt f11" style="left:131.1mm; top:137.7mm; font-family:Tahoma, sans-serif; letter-spacing:1.10px; transform:scaleX(1.022); transform-origin:left center;">${esc(d.motherNatEn)}</div>

  <!-- row 4 -->
  <div class="el txt f11" style="left:23.0mm; top:148.25mm; font-family:'SutonnyOMJ'; transform:scaleX(1.059); transform-origin:left bottom">পিতা</div>
  <div class="el txt f11" style="left:53.4mm; top:147.4mm;">:</div>
  <div class="el txt f11" style="left:56.49mm; top:148.1mm; font-family:'SutonnyOMJ'; transform:scaleX(1.036); transform-origin:left bottom">${esc(d.fatherBn)}</div>
  <div class="el txt f11" style="left:101.55mm; top:147.7mm; font-family:Verdana, sans-serif; transform:scaleX(1.128); transform-origin:left center;">Father</div>
  <div class="el txt f11" style="left:128.1mm; top:147.7mm;">:</div>
  <div class="el txt f11" style="left:131.1mm; top:147.7mm; font-family:Tahoma, sans-serif; letter-spacing:1.07px; transform:scaleX(1.019); transform-origin:left center;">${esc(d.fatherEn)}</div>

  <!-- row 5 -->
  <div class="el txt f11" style="left:23.0mm; top:158.05mm; font-family:'SutonnyOMJ'; transform:scaleX(1.038); transform-origin:left bottom">পিতার জাতীয়তা</div>
  <div class="el txt f11" style="left:53.4mm; top:157.0mm;">:</div>
  <div class="el txt f11" style="left:55.90mm; top:158.0mm; font-family:'SutonnyOMJ'; transform:scaleX(1.067); transform-origin:left bottom">${esc(d.fatherNatBn)}</div>
  <div class="el txt f11" style="left:101.55mm; top:157.3mm; font-family:Verdana, sans-serif; transform:scaleX(1.03); transform-origin:left center;">Nationality</div>
  <div class="el txt f11" style="left:128.1mm; top:157.3mm;">:</div>
  <div class="el txt f11" style="left:131.1mm; top:157.3mm; font-family:Tahoma, sans-serif; letter-spacing:1.10px; transform:scaleX(1.022); transform-origin:left center;">${esc(d.fatherNatEn)}</div>

  <!-- row 6 -->
  <div class="el txt f11" style="left:22.5mm; top:167.6mm; font-family:'SutonnyOMJ'; transform:scaleX(1.122); transform-origin:left bottom">জন্মস্থান</div>
  <div class="el txt f11" style="left:53.4mm; top:167.0mm;">:</div>
  <div class="el txt f11" style="left:56.57mm; top:168.1mm; font-family:'SutonnyOMJ'; transform:scaleX(1.041); transform-origin:left bottom">${esc(d.pobBn)}</div>
  <div class="el txt f11" style="left:101.55mm; top:167.3mm; font-family:Verdana, sans-serif; transform:scaleX(1.012); transform-origin:left center;">Place of Birth</div>
  <div class="el txt f11" style="left:128.1mm; top:167.3mm;">:</div>
  <div class="el txt f11" style="left:131.43mm; top:167.3mm; font-family:Tahoma, sans-serif; letter-spacing:1.10px; transform:scaleX(0.9856); transform-origin:left center;">${esc(d.pobEn)}</div>

  <!-- row 7 address: wrap boxes (same font/size; long text flows DOWN, never restyles)
       FIT LOGIC (permanent): fixed width = horizontal BOUND (word-break for unbroken
       tokens), max-height 43mm = vertical BOUND (never reaches the signature block),
       inline script auto-shrinks font/line-height until it fits -> layout intact. -->
  <div class="el txt f11" style="left:22.7mm; top:180.8mm; font-family:'SutonnyOMJ'; transform:scaleX(1.089); transform-origin:left bottom">স্থায়ী ঠিকানা</div>
  <div class="el txt f11" style="left:53.9mm; top:179.9mm;">:</div>
  <div id="addrBn" class="el txt f11" style="left:56.1mm; top:180.8mm; width:40mm; max-height:43mm; overflow:hidden; font-family:'SutonnyOMJ'; transform:scaleX(1.018); transform-origin:left bottom; line-height:4.3mm; white-space:normal; overflow-wrap:anywhere; word-break:break-word;">${bnL.map(esc).join('<br>')}</div>
  <div class="el txt f11" style="left:101.55mm; top:179.9mm; font-family:Verdana, sans-serif; transform:scaleX(1.024); transform-origin:left center;">Permanent</div>
  <div class="el txt f11" style="left:128.1mm; top:179.9mm;">:</div>
  <div id="addrEn" class="el txt f11" style="left:131.1mm; top:180.43mm; width:56.4mm; max-height:43mm; overflow:hidden; white-space:normal; overflow-wrap:anywhere; word-break:break-word; line-height:4.27mm;"><div style="font-family:Tahoma, sans-serif; letter-spacing:0.96px; transform:scaleX(1.002); transform-origin:left center;">${esc(enL[0] || '')}</div>${enL.length > 1 ? `<div style="font-family:Tahoma, sans-serif; letter-spacing:1.07px; transform:scaleX(1.002); transform-origin:left center;">${enL.slice(1).map(esc).join('<br>')}</div>` : ''}</div>
  <div class="el txt f11" style="left:101.55mm; top:184.7mm; font-family:Verdana, sans-serif; transform:scaleX(1.047); transform-origin:left center;">Address</div>

  <!-- signatures -->
  <div class="el txt f11" style="left:-1.10mm; width:90mm; text-align:center; top:228.6mm; font-family:Verdana, sans-serif; font-size:11pt; letter-spacing:0px;">Seal &amp; Signature</div>
  <div class="el txt f11 b" style="left:-0.90mm; width:90mm; text-align:center; top:234.1mm; letter-spacing:0.4px; transform:scale(0.985,0.94);">Assistant to Registrar</div>
  <div class="el txt f105" style="left:-1.05mm; width:90mm; text-align:center; top:239.75mm; letter-spacing:0px; font-family:Arial, sans-serif; font-size:9.8pt; font-weight:bold;">(Preparation, Verification)</div>
  <div class="el txt f11" style="left:125.8mm; width:75mm; text-align:center; top:228.6mm; font-family:Verdana, sans-serif; font-size:11pt; letter-spacing:0px;">Seal &amp; Signature</div>
  <div class="el txt f11 b" style="left:126.15mm; width:75mm; text-align:center; top:234.6mm; letter-spacing:0px; font-family:Arial, sans-serif;">Registrar</div>

  <!-- footer -->
  <div class="el txt" style="left:1.1mm; width:208.6mm; text-align:center; padding-right:4.4mm; top:260.9mm; font-size:8.32pt; letter-spacing:0.15px;">This certificate is generated from bdris.gov.bd, and to verify this certificate, please scan the above QR Code &amp; Bar Code.</div>

</div>

<!-- AUTO-FIT (permanent): thikana jotoi boro/hok — addrBn/addrEn box-er FIXED
     width ar max-height BOUND cheye ber jabe NA (pixel area-r baire jabena).
     addrEn RIGHT bound = uporer barcode-er right edge line (134.2+48.5=182.7mm),
     niche oi vertical line porjanto — thikana oi line-er daye thakbe.
     Long text = font/line-height otikrompe choto hoye nijei fit hoy (position
     adjust), final fallback = clip — kakhono signature/layout bhenge na.
     Run hoy: preview iframe-eo, PDF (puppeteer)-eo. -->
<script>
(function () {
  function fitOne(id, maxMm) {
    var el = document.getElementById(id);
    if (!el) return;
    var maxPx = maxMm * 96 / 25.4;
    var fs0, lh0;
    if (el.dataset.fitFs) { fs0 = parseFloat(el.dataset.fitFs); lh0 = parseFloat(el.dataset.fitLh); }
    else {
      var cs = getComputedStyle(el);
      fs0 = parseFloat(cs.fontSize) || 14.67;
      lh0 = parseFloat(cs.lineHeight);
      if (!isFinite(lh0) || lh0 <= 0) lh0 = fs0 * 1.2;
      el.dataset.fitFs = fs0; el.dataset.fitLh = lh0;
    }
    el.style.fontSize = ''; el.style.lineHeight = '';
    var fs = fs0, lh = lh0;
    while (el.scrollHeight > maxPx && fs > 6.5) {
      fs -= 0.25;
      lh = Math.max(lh0 * (fs / fs0), fs * 1.02);
      el.style.fontSize = fs + 'px';
      el.style.lineHeight = lh + 'px';
    }
    while (el.scrollHeight > maxPx && lh > fs * 0.95) {
      lh -= 0.5;
      el.style.lineHeight = lh + 'px';
    }
    el.style.overflow = 'hidden';
  }
  function fitAll() { fitOne('addrBn', 43); fitOne('addrEn', 43); window.__fitDone = true; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fitAll);
  else fitAll();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitAll);
})();
</script>
</body>
</html>`;
}


async function buildAssets(d) {
    const sealBase64 = fs.readFileSync(path.join(__dirname, 'assets', 'seal.jpg')).toString('base64');
    const logoBase64 = fs.readFileSync(path.join(__dirname, 'assets', 'logo.png')).toString('base64');
    const brnText = String(d.brn || '').trim();
    let qrDataUrl;
    let barcodeDataUrl = '';
    let code = String(d.verificationCode || '').trim();
    if (brnText) {
        // engine: number -> key -> verify URL -> QR (scan geometry) + CODE128 barcode
        const built = await engine.build({ number: brnText, url: d.verificationUrl || undefined });
        qrDataUrl = built.qr.dataUrl;
        barcodeDataUrl = built.barcode.dataUrl;
        if (!code) code = built.code; // deterministic 4-char fallback, never empty
    } else {
        qrDataUrl = await QRCode.toDataURL(' ', { width: 400, margin: 0, errorCorrectionLevel: 'M' });
    }
    return {
        seal: `data:image/jpeg;base64,${sealBase64}`,
        logo: `data:image/png;base64,${logoBase64}`,
        qr: qrDataUrl,
        barcode: barcodeDataUrl,
        code
    };
}

// Live preview for the editor (returns the exact certificate HTML).
/* ---- field mapping: long API names -> short template names + dobWords ----
   BIRTH_OUTPUT.json / BDRIS API use motherNameEn, registrationDate etc.
   buildCertificateHtml expects motherEn, regDate, dobWords, permBn/permEn. */
function toTemplateFields(d) {
    const t = Object.assign({}, d);
    const pick = (dst, src) => { if (!t[dst] && t[src]) t[dst] = t[src]; };
    pick('regDate', 'registrationDate');
    pick('issueDate', 'issuanceDate');
    pick('motherEn', 'motherNameEn');
    pick('motherBn', 'motherNameBn');
    pick('fatherEn', 'fatherNameEn');
    pick('fatherBn', 'fatherNameBn');
    pick('motherNatEn', 'motherNationalityEn');
    pick('motherNatBn', 'motherNationalityBn');
    pick('fatherNatEn', 'fatherNationalityEn');
    pick('fatherNatBn', 'fatherNationalityBn');
    pick('pobEn', 'placeOfBirthEn');
    pick('pobBn', 'placeOfBirthBn');
    pick('permEn', 'permanentAddressEn');
    pick('permBn', 'permanentAddressBn');
    // auto compute dobWords from dob if missing (In Word row)
    if (!t.dobWords && t.dob) {
        const months = { '01':'January','02':'February','03':'March','04':'April','05':'May','06':'June','07':'July','08':'August','09':'September','10':'October','11':'November','12':'December' };
        const days = ['','First','Second','Third','Fourth','Fifth','Sixth','Seventh','Eighth','Ninth','Tenth','Eleventh','Twelfth','Thirteenth','Fourteenth','Fifteenth','Sixteenth','Seventeenth','Eighteenth','Nineteenth','Twentieth','Twenty First','Twenty Second','Twenty Third','Twenty Fourth','Twenty Fifth','Twenty Sixth','Twenty Seventh','Twenty Eighth','Twenty Ninth','Thirtieth','Thirty First'];
        const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
        const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
        const m = String(t.dob).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (m) {
            const day = parseInt(m[1], 10), mn = m[2].padStart(2, '0'), yr = parseInt(m[3], 10);
            let ys = 'Two Thousand';
            if (yr >= 2000) { const r = yr - 2000; if (r > 0 && r < 20) ys += ' ' + ones[r]; else if (r >= 20) ys += ' ' + tens[Math.floor(r / 10)] + (r % 10 ? ' ' + ones[r % 10] : ''); }
            else { const r = yr - 1900; ys = 'Nineteen Hundred'; if (r > 0 && r < 20) ys += ' ' + ones[r]; else if (r >= 20) ys += ' ' + tens[Math.floor(r / 10)] + (r % 10 ? ' ' + ones[r % 10] : ''); }
            t.dobWords = days[day] + ' of ' + (months[mn] || 'January') + '  ' + ys;
        }
    }
    return t;
}

app.post('/api/preview', async (req, res) => {
    try {
        const d = toTemplateFields(req.body || {});
        const html = buildCertificateHtml(d, await buildAssets(d));
        res.json({ success: true, html });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Preview failed.' });
    }
});

app.post('/generate-pdf', async (req, res) => {
    const d = toTemplateFields(req.body || {});
    let browser;
    try {
        const html = buildCertificateHtml(d, await buildAssets(d));

        browser = await puppeteer.launch({
            headless: true,
            executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
            // same rendering flags as the audited CLI renders (build.cmd)
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
                   '--disable-dev-shm-usage', '--disable-lcd-text', '--force-color-profile=srgb']
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 15000 });
        // address auto-fit script sesh hote dao (preview-e jothajoth dekha jay,
        // PDF-eo same layout) — fit na holeo PDF generation ruk hobe na.
        try { await page.waitForFunction('window.__fitDone === true', { timeout: 1000 }); } catch (_) {}
        await new Promise(r => setTimeout(r, 120));
        // VECTOR PDF (preferCSSPageSize honours @page A4, margin 0) — same as
        // the audited deliverable birth-certificate.pdf (486 KB). Text stays
        // selectable + file stays small; the old 300 DPI raster embed made
        // 3 MB PDFs.
        const pdfBuffer = await page.pdf({
            printBackground: true,
            preferCSSPageSize: true,
            margin: { top: 0, right: 0, bottom: 0, left: 0 }
        });
        await browser.close();

        const brnText = String(d.brn || '').trim();
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=Certificate_${brnText || 'output'}.pdf`);
        res.send(pdfBuffer);
    } catch (err) {
        console.error('PDF generation error:', err);
        res.status(500).json({ success: false, error: 'Failed to generate PDF' });
    } finally {
        if (browser) await browser.close();
    }
});

if (require.main === module) {
    const srv = app.listen(port, '127.0.0.1', () => {
        console.log(`Server running on port ${port}`);
    });
    srv.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
            const msg = `Port ${port} busy — arekta instance cholche? (exit 2)`;
            console.error(msg);
            logLine('EADDRINUSE: ' + msg);
            process.exit(2);
        }
        logLine('SERVER ERROR: ' + (e && e.stack || e));
    });
}

function logLine(s) {
    try { fs.appendFileSync(path.join(__dirname, 'server.log'), new Date().toISOString() + ' ' + s + '\n'); } catch (_) {}
}
process.on('uncaughtException', (e) => { logLine('UNCAUGHT: ' + (e && e.stack || e)); });
process.on('unhandledRejection', (e) => { logLine('UNHANDLED: ' + (e && e.stack || e)); });

module.exports = { app, buildCertificateHtml, buildAssets, normalizeBdrisData };
