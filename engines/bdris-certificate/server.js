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
const port = 3000;

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
    const modelsToTry = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
    const prompt = "Solve the math problem shown in this image. If it's a math problem like '92-48=?', return only the final calculated number (e.g. 44). If it is just a string of random letters and numbers, return those exactly. ONLY return the final answer without any explanation or extra text. Make sure you calculate correctly.";
    let lastErr = null;
    const withTimeout = (p, ms, msg) => Promise.race([
        p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))
    ]);
    for (let attempt = 1; attempt <= 3; attempt++) {
        for (const modelName of modelsToTry) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                const result = await withTimeout(model.generateContent([prompt, ...imageParts]), 15000, 'Gemini timeout');
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
    const script = path.join(__dirname, 'solve_local.py');
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
    const tds = [];
    const re = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        let t = m[1]
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ')
            .replace(/&amp;/gi, '&')
            .replace(/&lt;/gi, '<')
            .replace(/&gt;/gi, '>')
            .replace(/&quot;/gi, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();
        tds.push(t);
    }
    return tds;
}

function mapResultData(tds) {
    const data = {};
    for (let i = 0; i < tds.length; i++) {
        const text = tds[i];
        if (/registration date/i.test(text)) {
            for (const off of [3, 1, 2, 4]) { if (tds[i+off] && /\d/.test(tds[i+off])) { data.registrationDate = tds[i+off]; break; } }
        }
        if (text === 'Registration Office' && tds[i + 3]) data.registrationOffice = tds[i + 3];
        // Some result pages put the office NAME in the table value cell and the
        // "NB: ... Location of the Register office : A, B, C" line in its own cell.
        // Keep that line aside: it becomes office2 when the table value had none.
        if (/location of.*register.*office/i.test(text) && !data.officeLocationRaw) {
            data.officeLocationRaw = text;
        }
        // Fallback: try other offsets if i+3 is empty
        if (text === 'Registration Office' && !data.registrationOffice) {
            for (const off of [1, 2, 4, 5]) {
                if (tds[i + off] && tds[i + off].trim().length > 3) {
                    data.registrationOffice = tds[i + off];
                    break;
                }
            }
        }
        if (/issuance date/i.test(text)) {
            for (const off of [3, 1, 2, 4]) { if (tds[i+off] && /\d/.test(tds[i+off])) { data.issuanceDate = tds[i+off]; break; } }
        }
        if (text === 'Date of Birth' && tds[i + 3]) data.dob = tds[i + 3];
        if (text === 'Birth Registration Number' && tds[i + 3]) data.brn = tds[i + 3];
        if (text === 'Sex' && tds[i + 3]) data.sex = tds[i + 3];
        if (text.includes('Registered Person Name')) { data.nameEn = tds[i + 1]; data.nameBn = tds[i - 1]; }
        if (text.includes('Place of Birth')) { data.placeOfBirthEn = tds[i + 1]; data.placeOfBirthBn = tds[i - 1]; }
        if (text.includes("Mother's Name")) { data.motherNameEn = tds[i + 1]; data.motherNameBn = tds[i - 1]; }
        if (text.includes("Mother's Nationality")) { data.motherNationalityEn = tds[i + 1]; data.motherNationalityBn = tds[i - 1]; }
        if (text.includes("Father's Name")) { data.fatherNameEn = tds[i + 1]; data.fatherNameBn = tds[i - 1]; }
        if (text.includes("Father's Nationality")) { data.fatherNationalityEn = tds[i + 1]; data.fatherNationalityBn = tds[i - 1]; }
    if (text.includes('Permanent Address')) { data.permanentAddressEn = tds[i + 1]; data.permanentAddressBn = tds[i - 1]; }
    }
    return data;
}

// BDRIS API-র raw data-কে genuine certificate format-এ normalize করো
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
        out.office1 = parts.length ? parts[0] : cleaned;
        out.office2 = parts.length > 1 ? parts.slice(1).join(', ') : '';
    }

    // Separate NB/location cell (office NAME was in the table, location here):
    // use its location as office2 ONLY when the table value had no comma of its
    // own. Never overrides an existing office2. Title-cased like the rest.
    // Single-token location + no office1 -> office1 (kokhono data harabe na).
    if (out.officeLocationRaw) {
        if (!out.office2) {
            const lm = String(out.officeLocationRaw).match(/location of the register office\s*:?\s*([\s\S]+)$/i);
            if (lm) {
                let loc = String(lm[1]).split(/[.。]\s*(https?:|everify|www\.)/i)[0].replace(/[.。]+$/, '').trim();
                const lp = loc.split(',').map(x => x.trim()).filter(Boolean);
                if (lp.length > 1) {
                    out.office2 = titleCase(lp.slice(1).join(', '));
                    if (!out.office1 && lp[0]) out.office1 = titleCase(lp[0]);
                } else if (lp.length === 1 && !out.office1) {
                    out.office1 = titleCase(lp[0]);
                }
            }
        }
        delete out.officeLocationRaw;
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
        try {
            const dbgPath = '/tmp/bdris-debug-' + Date.now() + '.html';
            require('fs').writeFileSync(dbgPath, html.slice(0, 80000));
            console.log('[bdris-cert] DEBUG html saved to', dbgPath, 'len=', html.length);
        } catch (_) {}

        if (html.includes('No record found') || html.includes('Captcha is not valid') || html.includes('Does not match')) {
            return res.json({ success: false, error: 'Data not found or captcha wrong. Fetch a new captcha and try again.' });
        }

        const tds = extractTdTexts(html);
        const mapped = mapResultData(tds);
        // Fallback: search raw HTML for office location if not in TDs
        if (!mapped.officeLocationRaw) {
            const hm = html.match(/location of the register office\s*:?\s*([^<]{3,200})/i);
            if (hm) mapped.officeLocationRaw = 'Location of the Register office: ' + hm[1].trim();
        }
        const data = normalizeBdrisData(mapped);

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
            // Debug: result page save করে রাখি যাতে structure দেখা যায়
            try { require('fs').writeFileSync(require('path').join(__dirname, 'last-result.html'), html); } catch (_) {}
            return res.json({ success: false, error: 'Could not read the result. Fetch a new captcha and try again. (last-result.html saved)', debug: tds.slice(0, 40) });
        }
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
        await store.saveRecord({
            number,
            name: body.name || null,
            key: built.key,
            verifyUrl: built.verifyUrl,
            keySource: built.keySource,
            payload: body.data || body.payload || {}
        });
        res.json({ success: true, number, key: built.key, keySource: built.keySource,
                   code: built.code, verifyUrl: built.verifyUrl, savedTo: store.mode });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/records', async (req, res) => {
    try {
        res.json({ success: true, mode: store.mode, records: await store.listRecords(req.query.limit) });
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

// Replica layout (same look as birth-certificate/index.html), driven by record data.
// Positions/fonts are the scan-measured replica values; QR + barcode come from
// the shared engine (cert-engine.js) via buildAssets. No client JS needed:
// everything (codes included) is baked into this HTML server-side.
function buildCertificateHtml(d, assets) {
    // collapse-proof spaces (replica uses &nbsp; for the double space in dobWords)
    const N = (s) => esc(s).replace(/ {2,}/g, (m) => '&nbsp;'.repeat(m.length));
    const bnL = String(d.permBn == null ? '' : d.permBn).split('\n');
    // Title Case for English address: any input case -> proper case
    const _tc = (s) => String(s || '').toLowerCase().split(/(\s+)/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    const enL = _tc(d.permEn).split('\n');
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
  .seal { position: absolute; left: 21mm; top: 69.8mm; width: 168mm; z-index: 0; }
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

  <!-- row 7 address: wrap boxes (same font/size; long text flows DOWN, never restyles) -->
  <div class="el txt f11" style="left:22.7mm; top:180.8mm; font-family:'SutonnyOMJ'; transform:scaleX(1.089); transform-origin:left bottom">স্থায়ী ঠিকানা</div>
  <div class="el txt f11" style="left:53.9mm; top:179.9mm;">:</div>
  <div class="el txt f11" style="left:56.1mm; top:180.8mm; width:40mm; font-family:'SutonnyOMJ'; transform:scaleX(1.018); transform-origin:left bottom; line-height:4.3mm; white-space:normal;">${bnL.map(esc).join('<br>')}</div>
  <div class="el txt f11" style="left:101.55mm; top:179.9mm; font-family:Verdana, sans-serif; transform:scaleX(1.024); transform-origin:left center;">Permanent</div>
  <div class="el txt f11" style="left:128.1mm; top:179.9mm;">:</div>
  <div class="el txt f11" style="left:131.1mm; top:180.43mm; width:51.6mm; max-width:51.6mm; white-space:normal; overflow-wrap:break-word;"><div style="font-family:Tahoma, sans-serif; letter-spacing:0.96px; transform:scaleX(1.002); transform-origin:left center; line-height:4.27mm;">${esc(enL[0])}</div>${enL.length > 1 ? `<div style="font-family:Tahoma, sans-serif; letter-spacing:1.07px; transform:scaleX(1.002); transform-origin:left center; line-height:4.27mm;">${enL.slice(1).map(esc).join('<br>')}</div>` : ''}</div>
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
app.post('/api/preview', async (req, res) => {
    try {
        const d = req.body || {};
        const html = buildCertificateHtml(d, await buildAssets(d));
        res.json({ success: true, html });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Preview failed.' });
    }
});

app.post('/generate-pdf', async (req, res) => {
    const d = req.body || {};
    let browser;
    try {
        const html = buildCertificateHtml(d, await buildAssets(d));

        browser = await puppeteer.launch({
            headless: true,
            executablePath: '/usr/bin/google-chrome',
            // same rendering flags as the audited CLI renders (build.cmd)
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
                   '--disable-lcd-text', '--force-color-profile=srgb']
        });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
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
        // Filename: person's English name with underscores (fallback to BRN)
        const nameText = String(d.nameEn || '').trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || brnText || 'output';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=${nameText}.pdf`);
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
