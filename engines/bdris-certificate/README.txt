BDRIS Certificate Studio v3
============================

WHAT IT DOES
------------
1. Fetches the captcha from everify.bdris.gov.bd (plain HTTP, no browser needed).
2. You solve the captcha manually, OR press "Auto Calculate" and the app
   reads the image for you (needs a Gemini API key).
3. "Verify & Fetch Data" pulls the birth record from the BDRIS server.
4. The data appears in an editor with a LIVE certificate preview
   (birth replica - data-driven, kono client JS lage na).
   Edit anything, watch the preview update.
5. "Create PDF" generates the A4 certificate PDF and downloads it.

HOW TO RUN (Windows) - EASY WAY
--------------------------------
1. Install Node.js LTS from https://nodejs.org (if not already installed).
2. Extract this ZIP anywhere.
3. FIRST TIME ONLY, open PowerShell in the BDRIS-Scrapper folder and run:
     npm install
   then:
     npx puppeteer browsers install chrome
   (downloads Chrome for PDF generation - once only)
4. OPTIONAL: for the "Auto Calculate" captcha button, open start.bat in
   Notepad and put your Gemini key where it says PASTE_YOUR_KEY_HERE.
   Get a free key at https://aistudio.google.com/app/apikey
   Without the key, just type the captcha answer yourself - everything else works.
5. Double-click start.bat. It starts the server automatically.
6. Open http://localhost:3000 in your browser.
   To stop: press Ctrl+C in the black window.

HOW TO RUN - MANUAL (PowerShell)
--------------------------------
   cd "path\to\BDRIS-Scrapper"
   set GEMINI_API_KEY=your_key_here   (optional, for Auto Calculate)
   node server.js

FILES
-----
server.js              - backend (captcha session, verify, preview, PDF, engine API)
cert-engine.js         - SHARED engine logic (single source of truth; the birth-
                         certificate project loads the same file as a browser script)
engine.js              - Node wrapper: cert-engine + Node crypto/qrcode/bwip + PNG
certificate-builder.js - SAMPURNA builder: record -> {html, png, pdf} in 1 call
                         const out = await require('./certificate-builder')
                                             .buildCertificate(record)
workflow-engine.js     - SAMPURNA WORKFLOW: createRecord({number,name?,url?,data?})
                         -> {record, certificate{html,png,pdf}, saved};
                         getRecord(number) -> stored + fresh engine codes
                         (shudhu existing module reuse kore, purono logic untouched)
cert-engine-standalone.js - COMPLETE engine in ONE file for your builder (70 KB,
                         zero npm deps). Node: require() it. Browser: <script src>.
                         Regenerate: npm run build:standalone
                         (sources: standalone-core.js + build-standalone.js + _c128table.json)
store.js               - record store: Oracle (if env set) or local JSON file
index.html             - the Studio UI (open http://localhost:3000 after starting the server)
check-api.html         - API CHECK UI: 6 auto checks (store/captcha/engine/preview/
                         PDF/records - all birth) + manual verify box. Open from disk
                         (double-click) while the server runs; needs no build step.
assets/                - seal.jpg + logo.png (embedded into the certificate)
package.json           - dependencies
sample-payload.json    - example data for testing the PDF/preview
test_engine.js         - engine self-test (writes _test_out/ for cross-checks)
README.txt             - this file

CERTIFICATE CODE ENGINE (cert-engine.js, used via engine.js wrapper)
---------------------------------------------------------------------
Logic lives in cert-engine.js - the SAME file the birth-certificate
page loads in the browser (byte-identical copy at
..\birth-certificate\assets\vendor\cert-engine.js). engine.js only
adds Node pieces: crypto SHA-512, node-qrcode, bwip-js, PNG writer.

Verified 15/15 against the birth-certificate Python tool
(update_codes.py): key byte-identical, barcode pixel-identical,
QR roundtrip:

  number --makeKey()--> base64(sha512("BDRIS-CERT-VERIFY|"+number))[:64]
  key    --> https://bdris.gov.bd/certificate/verify?key=...
  URL    --> QR PNG (ECC-Q, 230x230, scan-exact bbox)          [qrcode lib]
  number --> CODE128 barcode PNG (145 modules for 17 digits,    [bwip-js raw]
             scan geometry: 48.5x7.8mm box, bars at 0.24/1.22mm)

Use it from your own web app, either way:

  A) In-process (any Node app):   const engine = require('./engine');
                                  const r = await engine.build({ number: '2000...064' });
                                  // r.key, r.verifyUrl, r.qr.dataUrl, r.barcode.dataUrl

  B) REST (works from any language):
     POST /api/engine   {number, url?}        -> {engine: {key, verifyUrl, qr, barcode}}
     (url = official BDRIS verify URL if you have one; otherwise engine key is used)

  C) SINGLE FILE for your builder: copy cert-engine-standalone.js (70 KB, no
     npm install needed) -
       Node:    const CE = require('./cert-engine-standalone.js');
                const r = await CE.build({ number: '2000...064' });
       Browser: <script src="cert-engine-standalone.js"></script>
                const r = await CertEngine.build({ number: '...' });
                // paint: canvas ImageData from CertEngine.grayToRGBA(r.qr.px)
     NOTE: browser needs secure context (https/localhost) for the key engine
     (WebCrypto); barcode input must be digits (certificate numbers).

NOTE: engine keys are deterministic and scan correctly, but bdris.gov.bd only
validates keys it issued itself. Pass the official URL (url / verificationUrl)
when the real one is available.

RECORD STORE (store.js) - Oracle or file
-----------------------------------------
Oracle mode activates when all three env vars are set (before node server.js):

  ORACLE_CONN_STR=localhost:1521/XEPDB1   (host:port/service or full EZConnect)
  ORACLE_USER=your_user
  ORACLE_PASSWORD=your_password

Table CERT_RECORDS is created automatically on first use (idempotent).
Without those vars everything runs against _data/records.json (no setup needed).
node-oracledb 7 thin driver is used - no Oracle Instant Client needed for TCP.

  POST /api/records     {number, name?, url?, data?} -> saves + returns key/url
  GET  /api/records     ?limit=50                    -> list
  GET  /api/records/:number                          -> record + fresh codes
  GET  /api/store/health                             -> {mode: "oracle"|"file", ok}

API ENDPOINTS (for reference)
-----------------------------
GET  /api/captcha                 -> { sessionId, image }
POST /api/solve-captcha  -> { answer }             (Gemini reads the captcha)
POST /api/verify         -> { success, data }      (number+date+captcha -> record)
POST /api/engine         -> { engine }             (number -> key/QR/barcode)
POST /api/records        -> save record            (Oracle if configured)
GET  /api/records        -> list records
GET  /api/records/:number-> one record + codes
POST /api/preview        -> { html }               (birth replica HTML)
POST /generate-pdf       -> PDF file download      (vector A4, ~475 KB)

NOTES
-----
- The captcha session expires after 5 minutes. Press "fetch new captcha" if it does.
- The QR on the generated certificate now holds the verify URL: the official
  BDRIS key when the real one is available, otherwise the engine key (scans
  fine, but only keys issued by bdris.gov.bd pass server-side verification).
- The barcode encodes the certificate number (CODE128, scan geometry).
- Only transcribe genuine data from records you are authorized to use.

OUTPUT LOGIC (konta theke konta hoy)
------------------------------------
A) CORE ENGINE (cert-engine.js - shared, single source; browser-e same file):
   number -> makeKey -> verifyUrl -> QR matrix + CODE128 modules -> gray px
   (Node providers: crypto SHA-512, node-qrcode, bwip-js raw.
    Browser providers: WebCrypto, qrcode.js, bwip-js raw. Same outputs.)
   engine.js wrapper adds: grayToPng (300dpi pHYs) + data URLs.

B) STUDIO OUTPUTS (server.js):
   /api/verify record (+official URL jodi BDRIS response-e thake)
     -> office auto: "NB: ...Database. Location of the Register office:"
        preamble bad diye FULL address office1/line2-te split (UI-teo same
        fallback, tai purono server holeo line thik ashe)
     -> buildAssets : seal.jpg + logo.png embed (assets/)
                      + engine.build(number, url?) -> QR/barcode data URLs
     -> buildCertificateHtml : REPLICA layout (birth index.html hubohu),
         data-driven (shob field record theke), kono client JS lage na
      -> POST /api/preview  -> { html } (Studio iframe-e live preview)
      -> POST /generate-pdf -> puppeteer VECTOR PDF
                               (page.pdf, @page A4, ~475 KB, selectable text)
   /api/engine  -> { key, verifyUrl, qr/barcode dataUrls } (JSON, jekono app-er jonno)
   /api/records -> save/list/get (Oracle jodi ORACLE_* env thake, nahole _data/records.json)

C) TEST LOGIC:
   node test_engine.js -> _test_out/ (qr/barcode PNG + result.json)
   cross-check (Python zxingcpp): key Node==Python, barcode pixel-identical,
   QR roundtrip, geometry bbox. Expected: 15/15 PASS.
   Jodi "ager output" dekha jay: taskkill /F /IM node.exe, server restart.
