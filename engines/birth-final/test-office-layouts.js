// Sthayi regression set — birth verify office1/office2-er jonno ekhon
// porjonto dekha SOB layout. Notun layout ele ekhane case jog korte hobe,
// alada patch noy. test-parse.js-er moto slice-eval: server.js theke
// extractTdTexts..normalizeBdrisData slice niye chalano hoy, tai kono
// dependency (express/puppeteer) lage na.
//
// Chalano: node engines/birth-final/test-office-layouts.js [server.js path]
// Exit 0 = sob pass, 1 = kono fail.
const fs = require('fs');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, 'server.js');
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const failSlice = (label) => { console.error('test-office-layouts: ' + label + ' not found in ' + SRC); process.exit(2); };
const s = lines.findIndex(l => /^function extractTdTexts/.test(l));
const n = lines.findIndex(l => /^function normalizeBdrisData/.test(l));
if (s < 0) failSlice('function extractTdTexts');
if (n < 0) failSlice('function normalizeBdrisData');
let e = n + 1;
while (e < lines.length && !/^(function |const |let |var |app\.|module\.|exports)/.test(lines[e])) e++;
if (e <= s) failSlice('slice is empty');
eval(lines.slice(s, e).join('\n'));

// Handler-er moto: table-e location na thakle footer function diye nao.
const pipeHtml = (html) => {
  const tds = extractTdTexts(html);
  if (!tds.some(t => /location of the register office/i.test(t))) {
    const fb = extractNbFooterLocation(html);
    if (fb) tds.push(fb);
  }
  return normalizeBdrisData(mapResultData(tds));
};
const pipeCells = (cells) => normalizeBdrisData(mapResultData(cells));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else fail++;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + ' | got=' + JSON.stringify(got) + (ok ? '' : ' | want=' + JSON.stringify(want)));
};

// --- normalize: NB location rokomfer ---
check('live entity with table office',
  (() => { const o = normalizeBdrisData({ office1: 'P.m. Khali', officeLocationRaw: 'Location of the Register office: P. M. Khali, Cox&#39;s Bazar Sadar, Cox&#39;s Bazar' }); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'P.m. Khali', o2: "Cox's Bazar Sadar, Cox's Bazar" });
check('fallback cell alone (no table office)',
  (() => { const o = pipeCells(['Location of the Register office: P. M. Khali, Cox&#39;s Bazar Sadar, Cox&#39;s Bazar']); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'P. M. Khali', o2: "Cox's Bazar Sadar, Cox's Bazar" });
check('decoded apostrophe (vul-fix case)',
  (() => { const o = normalizeBdrisData({ office1: 'P.m. Khali', officeLocationRaw: "Location of the Register office: P. M. Khali, Cox's Bazar Sadar, Cox's Bazar" }); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'P.m. Khali', o2: "Cox's Bazar Sadar, Cox's Bazar" });
check('zone-8 sample',
  (() => { const o = normalizeBdrisData({ office1: 'Zone - 8, Dhaka South City Corporation', officeLocationRaw: 'Location of the Register office: Zone - 8, Dhaka South City Corporation, Dhaka' }); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'Zone - 8, Dhaka South City Corporation', o2: 'Dhaka South City Corporation, Dhaka' });
check('union record',
  (() => { const o = normalizeBdrisData({ office1: 'Bagoan Union Parishad', officeLocationRaw: 'Location of the Register office: Bagoan, Raozan, Chattogram' }); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'Bagoan Union Parishad', o2: 'Raozan, Chattogram' });
check('2-token guard intact',
  (() => { const o = normalizeBdrisData({ office1: 'Raozan Union Parishad', officeLocationRaw: 'Location of the Register office: Raozan, Chattogram' }); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'Raozan Union Parishad', o2: 'Raozan, Chattogram' });
check('junk-suffix footer stripped',
  (() => { const o = normalizeBdrisData({ office1: 'P.m. Khali', officeLocationRaw: "Location of the Register office: P. M. Khali, Cox's Bazar Sadar, Cox's Bazar © 2026 - Developed and maintained by BDRIS" }); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'P.m. Khali', o2: "Cox's Bazar Sadar, Cox's Bazar" });
check('no location anywhere: no crash, office1 kept',
  (() => { const o = normalizeBdrisData({ office1: 'P.m. Khali' }); return { o1: o.office1, o2: o.office2 || '' }; })(),
  { o1: 'P.m. Khali', o2: '' });
check('split-cell label + value',
  (() => { const o = pipeCells(['Location of the Register office', "P. M. Khali, Cox's Bazar Sadar, Cox's Bazar"]); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'P. M. Khali', o2: "Cox's Bazar Sadar, Cox's Bazar" });

// --- entry points: entity sob pothe decode hote hobe ---
check('table cell entity decoded',
  extractTdTexts('<table><tr><td>Office</td><td>Cox&#39;s Bazar Sadar</td></tr></table>'),
  ['Office', "Cox's Bazar Sadar"]);
check('div-path entity decoded',
  extractTdTexts('<div>Cox&#39;s Bazar Sadar</div><div>Cox&#39;s Bazar</div>'),
  ["Cox's Bazar Sadar", "Cox's Bazar"]);
check('footer fn entity + everify marker',
  extractNbFooterLocation('<p>Location of the Register office: P. M. Khali, Cox&#39;s Bazar Sadar, Cox&#39;s Bazar. everify.bdris.gov.bd</p>'),
  'Location of the Register office: P. M. Khali, ' + "Cox's Bazar Sadar, Cox's Bazar");
check('footer fn dotted start not cut at first dot',
  (() => { const c = extractNbFooterLocation('<p>Location of the Register office: P.M. KHALI, COX&#39;S BAZAR SADAR, COX&#39;S BAZAR. everify</p>'); return c && c.includes("COX'S BAZAR SADAR") && !c.includes('&#39;'); })(),
  true);
check('full pipeline: table office + footer entity (live path)',
  (() => { const o = pipeHtml('<table><tr><td>Registration Office</td><td>P.m. Khali</td></tr></table><p>Location of the Register office: P. M. Khali, Cox&#39;s Bazar Sadar, Cox&#39;s Bazar. everify</p>'); return { o1: o.office1, o2: o.office2 }; })(),
  { o1: 'P.m. Khali', o2: "Cox's Bazar Sadar, Cox's Bazar" });

console.log('\nRESULT pass=' + pass + ' fail=' + fail);
process.exit(fail ? 1 : 0);
