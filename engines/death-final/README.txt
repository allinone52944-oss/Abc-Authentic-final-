DEATH NUMBER VERIFY TOOL (standalone)
======================================
Ekta alada app: death number diye BDRIS-e live yachai —
captcha -> verify -> record data -> death replica preview -> vector PDF.
BDRIS Scrapper er sathe KONO somporko nei (port 3001, zero npm deps).

QUICK START
-----------
  install.bat          -> node/python/opencv/ddddocr check + missing gulo install
                          (idempotent, already thakle shudhu OK dey)
  start-verify.bat     -> server chalu + browser auto-khule http://localhost:3001
                          (IDEMPOTENT: port 3001 already LISTENING hole abar
                           server chalay NA - shudhu browser khule dey)
  (manual: node death-verify-server.js)

  1. Death Registration No (17 digit) + morttu tarikh (DD/MM/YYYY) din
  2. "Captcha anun"      -> everify.bdris.gov.bd (UDRN page) theke live captcha
  3. uttor likho -> "Yachai korun" (ba "Auto Calculate" chapa)
  4. Record pele: puro tothyo + sondo preview + "PDF naman" (vector, ~475 KB)
  5. REFRESH-PROOF: page reload korleo drn/dod/captcha/uttor/folafol -
     shob localStorage-e thake, auto restore + preview abar chole ashe
     ("Notun yachai" chapa holei puro state mache)

REQUIREMENTS
------------
  Node.js 18+ (built-in fetch) + Google Chrome (PDF er jonno).
  Python 3 + opencv-python + ddddocr (local captcha solver er jonno;
  path nije-theke detect hoy: PYTHON_PATH env -> PATH -> Windows install dir).
  KONO npm install lage NA. Node na thakle: https://nodejs.org

FILES
-----
  death-verify.html        UI (dark, Bangla, refresh-proof localStorage state)
  death-verify-server.js   proxy + UDRN parser + replica builder + PDF
                           + local-solver bridge (python auto-detect)
  solve_local.py           local captcha solver (offline, zero API):
                           opencv geometry segmentation + ddddocr ensemble +
                           template bank vote resolution; uncertain hole
                           exit 1 -> fallback chole jay (kono vul uttor NA)
  templates.json           harvested glyph template bank (auto-solve theke)
  cert-engine-standalone.js  engine (QR/barcode/key) - Scrapper theke copy,
                           shudhu codes, kono npm dep nei
  assets\                  seal.jpg + logo.png + fonts.css (embedded fonts)
  install.bat              dependency installer (idempotent)
  start-verify.bat         double-click to run (GEMINI key set kore,
                           port busy hole shudhu browser khule dey)

AUTO LOGICS (nije-nije chole)
-----------------------------
  * Captcha solve: 3-tier — (1) LOCAL offline solver solve_local.py
    (opencv + ddddocr, ~2-3s, zero API) -> (2) Gemini fallback (key lagbe,
    shudhu local decline korle) -> (3) manual entry.
    Local solver wrong-answer-r er jonno strict: parse/confidence uncertain
    hole NEMEI fallback (jate vul-uttor kabhi submit na hoy).
  * "Auto Calculate" button: ei same chain chalay + input-e auto-fill
    (start-verify.bat-e GEMINI_API_KEY lage fallback-er jonno)
  * DRN: shobho digits-e sanitize; header line theke parse, na hole row
    label theke, taholeo hole page-er 16-18 digit run (safety net)
  * Date: "19 November 2022" -> 19/11/2022; input DD/MM or yyyy-MM accepted
  * "In Word" line nije theke toiri (dobToWords)
  * Place: "munsiganj munsiganj" jodi dobe-tobe repeat thake auto-dedupe,
    pore ", Bangladesh"/", বাংলাদেশ" auto-yojon (replica pattern)
  * English: TitleCase (name/place/office), Nationality BANGLADESHI ->
    Bangladeshi, Sex MALE -> Male; kintu Cause CAPS-i thake (replica moto)
  * Naam theke trailing DB junk auto-porishkar (backtick etc.)
  * Office +2 auto: "NB: ... Location of Register office" preamble kete
    comma-diwye office1 / office2 split (birth er exactly same logic)
  * QR + caption: known record-e official key + official caption
    (19681517411127048 -> ZTZQQ, bdris.gov.bd verify URL - scan korle
    official verify-e pass kore); notun record-e engine key (scan hoy)
  * Verify URL: BDRIS response-e thakle setai; known record-e auto-inject
  * fieldRow: ja API dey shei dekhay, blank row auto-hide
  * PDF filename: Death_Certificate_<DRN>.pdf auto

DEBUG
-----
  BDRIS response ekhane save hoy: _last-result.html (ei folder-e).
  Captcha/expired/session problem hole notun captcha anun (session 5 min).
  Official QR: BDRIS result-e verify URL thakle setai QR-e jay; na thakle
  engine key (scan hoy, kintu bdris.gov.bd official verify-e pass korbe na).

NOTE: death-certificate\ folder = shudhu replica (index.html + audit);
ei tool alada, oikhane kono lekha thikna-i kaj korbe na.
