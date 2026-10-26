const fs = require('fs');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, 'server.js');
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
// extractTdTexts (275) .. line before normalizeBdrisData (431) -> 1-based
const failSlice = (label) => { console.error('test-parse: ' + label + ' not found in ' + SRC); process.exit(2); };
const s = lines.findIndex(l => /^function extractTdTexts/.test(l));
const n = lines.findIndex(l => /^function normalizeBdrisData/.test(l));
if (s < 0) failSlice('function extractTdTexts');
if (n < 0) failSlice('function normalizeBdrisData');
let e = n + 1;
while (e < lines.length && !/^(function |const |let |var |app\.|module\.|exports)/.test(lines[e])) e++;
if (e <= s) failSlice('extractTdTexts slice is empty');
const code = lines.slice(s, e).join('\n');
eval(code);

// render slice: const esc .. end of buildCertificateHtml -> CASE 13 title-case
const rs = lines.findIndex(l => /^const esc =/.test(l));
const rb = lines.findIndex(l => /^function buildCertificateHtml/.test(l));
if (rs < 0) failSlice('const esc');
if (rb < 0) failSlice('function buildCertificateHtml');
let re = rb + 1;
while (re < lines.length && !/^(function |const |let |var |app\.|module\.|exports)/.test(lines[re])) re++;
eval(lines.slice(rs, re).join('\n'));
// server.js-er top helper fontsCss slice-e nei (assets read) — CASE 13 stub:
function fontsCss() { return ''; }

let pass = 0, fail = 0;
const show = (name, data) => {
  const pick = ['registrationDate','issuanceDate','registrationOffice','office1','office2','officeLocationRaw','dob','brn','sex','nameEn','nameBn'];
  const out = {};
  for (const k of pick) if (data[k] !== undefined && data[k] !== '') out[k] = data[k];
  console.log(`  ${name}: ${JSON.stringify(out)}`);
};
const eq = (name, got, want) => {
  const ok = String(got || '').trim() === want;
  if (ok) pass++; else { fail++; console.log(`  FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};

// ---- 1) GRID layout: labels row then values row (offset i+3 as original) ----
console.log('CASE 1 grid (original layout)');
{
  const tds = [
    'Registration Date', 'Registration Office', 'Issuance Date',
    'Date of Birth', 'Birth Registration Number', 'Sex',
    '30/09/2026', 'Raozan Union Parishad, Raozan, Chattogram', '05/10/2026',
    '01/01/2020', '1234567890123456', 'Male',
    'à¦°à¦¹à¦¿à¦® à¦‰à¦¦à§à¦¦à¦¿à¦¨', 'Registered Person Name', 'RAHIM UDDIN'
  ];
  const d = mapResultData(tds);
  show('grid', d);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('office', d.registrationOffice, 'Raozan Union Parishad, Raozan, Chattogram');
  eq('dob', d.dob, '01/01/2020');
  eq('brn', d.brn, '1234567890123456');
  eq('sex', d.sex, 'Male');
  eq('name', d.nameEn, 'RAHIM UDDIN');
  eq('nameBn', d.nameBn, 'à¦°à¦¹à¦¿à¦® à¦‰à¦¦à§à¦¦à¦¿à¦¨');
}

// ---- 2) PAIR layout: label,value adjacent (old code took i+3 = WRONG value) ----
console.log('CASE 2 pair (label|value adjacent)');
{
  const tds = [
    'Registration Date', '30/09/2026',
    'Registration Office', 'Raozan Union Parishad, Raozan, Chattogram',
    'Issuance Date', '05/10/2026',
    'Date of Birth', '01/01/2020',
    'Birth Registration Number', '1234567890123456',
    'Sex', 'Male'
  ];
  const d = mapResultData(tds);
  show('pair', d);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('office', d.registrationOffice, 'Raozan Union Parishad, Raozan, Chattogram');
  eq('brn', d.brn, '1234567890123456');
}

// ---- 3) LABEL VARIANTS: case/space/colon/alias drift (old exact === failed) ----
console.log('CASE 3 label variants');
{
  const tds = [
    '  Date of Registration :', '30 September 2026',
    'Date of Issuance', '05 October 2026',
    'Register Office', 'Bagoan Union Parishad, Raozan, Chattogram',
    'DOB', '01 January 2020',
    'UBRN', '9876543210987654',
    'Gender', 'Female'
  ];
  const d = mapResultData(tds);
  show('variants', d);
  eq('regDate', d.registrationDate, '30 September 2026');
  eq('issueDate', d.issuanceDate, '05 October 2026');
  eq('office', d.registrationOffice, 'Bagoan Union Parishad, Raozan, Chattogram');
  eq('dob', d.dob, '01 January 2020');
  eq('brn', d.brn, '9876543210987654');
  eq('sex', d.sex, 'Female');
}

// ---- 4) GRID with alias labels + empty spacer cells ----
console.log('CASE 4 grid + alias + spacers');
{
  const tds = [
    'Date of Registration', '', 'Issuance Date', '',
    'Registration Office', '', '', '',
    '12/05/2025', '20/05/2025', '', 'Kotwali Union Parishad, Sitakunda, Chattogram'
  ];
  const d = mapResultData(tds);
  show('grid+spacer', d);
  eq('regDate', d.registrationDate, '12/05/2025');
  eq('issueDate', d.issuanceDate, '20/05/2025');
  eq('office', d.registrationOffice, 'Kotwali Union Parishad, Sitakunda, Chattogram');
}

// ---- 5) SAFETY NET: value separated far from label ----
console.log('CASE 5 safety net (value 4 cells away)');
{
  const tds = ['Registration Date', '', '', '', '30/09/2026', 'x', 'Issuance Date', '05/10/2026'];
  const d = mapResultData(tds);
  show('net', d);
  eq('regDate', d.registrationDate, '30/09/2026');
}

// ---- 6) officeLocationRaw + office split ----
console.log('CASE 6 officeLocationRaw');
{
  const html = '<p>NB: Some note Location of the Register office : Raozan, Chattogram. everify</p>';
  const tds = extractTdTexts(html);
  const d = mapResultData(tds);
  show('nb', d);
  if (/location of the register office/i.test(d.officeLocationRaw || '')) pass++;
  else { fail++; console.log('  FAIL officeLocationRaw not captured'); }
}

// ---- 7) BRN must NOT steal a date; date must NOT steal office ----
console.log('CASE 7 cross-field guard');
{
  const tds = ['Birth Registration Number', '30/09/2026', '1234567890123456', 'Sex', 'Male'];
  const d = mapResultData(tds);
  show('guard', d);
  eq('brn not date', d.brn, '1234567890123456');
}

// ---- 8) <th> label layout (old code extracted ONLY <td> -> shob khali) ----
console.log('CASE 8 <th> labels');
{
  const html = `<table>
    <tr><th>Registration Date</th><th>Registration Office</th><th>Issuance Date</th></tr>
    <tr><td>30/09/2026</td><td>Bagoan Union Parishad, Raozan, Chattogram</td><td>05/10/2026</td></tr>
    <tr><th>Date of Birth</th><th>Birth Registration Number</th><th>Sex</th></tr>
    <tr><td>01/01/2020</td><td>1234567890123456</td><td>Male</td></tr>
  </table>`;
  const tds = extractTdTexts(html);
  const d = mapResultData(tds);
  show('th', d);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('office', d.registrationOffice, 'Bagoan Union Parishad, Raozan, Chattogram');
  eq('dob', d.dob, '01/01/2020');
  eq('brn', d.brn, '1234567890123456');
  eq('sex', d.sex, 'Male');
}

// ---- 9) NO table at all (div/label/span layout) -> fallback tokenizer ----
console.log('CASE 9 div/label layout');
{
  const html = `<div class="row"><label>Date of Registration</label><span>30/09/2026</span></div>
    <div class="row"><label>Date of Issuance</label><span>05/10/2026</span></div>
    <div class="row"><label>Registration Office</label><span>Bagoan Union Parishad, Raozan, Chattogram</span></div>`;
  const tds = extractTdTexts(html);
  const d = mapResultData(tds);
  show('div', d);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('office', d.registrationOffice, 'Bagoan Union Parishad, Raozan, Chattogram');
}

// ---- 10) mixed: label row <th>, value row <td>, empty value cell ----
console.log('CASE 10 sparse values');
{
  const html = `<tr><th>Date of Registration</th><th>Registration Office</th><th>Issuance Date</th></tr>
    <tr><td>12/05/2025</td><td></td><td>20/05/2025</td></tr>`;
  const d = mapResultData(extractTdTexts(html));
  show('sparse', d);
  eq('regDate', d.registrationDate, '12/05/2025');
  eq('issueDate', d.issuanceDate, '20/05/2025');
}

// ---- 11) E2E: parse -> normalize -> office1/office2 + date format ----------
console.log('CASE 11 e2e normalize (office split + dd/mm/yyyy)');
{
  const html = `<table>
    <tr><th>Date of Registration</th><th>Registration Office</th><th>Date of Issuance</th></tr>
    <tr><td>30 September 2026</td><td>Bagoan Union Parishad</td><td>05 October 2026</td></tr>
    <tr><th>Date of Birth</th><th>Birth Registration Number</th><th>Sex</th></tr>
    <tr><td>01 January 2020</td><td>1234567890123456</td><td>Male</td></tr>
    <tr><td>রহিম উদ্দিন</td><td>Registered Person Name</td><td>Rahim Uddin</td></tr>
  </table>
  <p>NB: Some note. Location of the Register office : Raozan, Chattogram. everify</p>`;
  const tds = extractTdTexts(html);
  if (!tds.some(t => /location of the register office/i.test(t))) {
    const m = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/\s+/g, ' ')
      .match(/location of the register office\s*:?\s*([^.]{2,200})/i);
    if (m) tds.push('Location of the Register office: ' + m[1].trim());
  }
  const d = normalizeBdrisData(mapResultData(tds));
  show('e2e', d);
  console.log(`  office1=${JSON.stringify(d.office1)} office2=${JSON.stringify(d.office2)} missing=${JSON.stringify(d.missingFields)}`);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('office1', d.office1, 'Bagoan Union Parishad');
  eq('office2', d.office2, 'Raozan, Chattogram');
  eq('dob', d.dob, '01/01/2020');
  eq('name', d.nameEn, 'Rahim Uddin');
  eq('brn', d.brn, '1234567890123456');
}

// ---- 12) office name EKBAR: registrationOffice duplicate output-e NA ----------
console.log('CASE 12 dedupe (registrationOffice removed from response)');
{
  const d = normalizeBdrisData({
    registrationDate: '30 September 2026', issuanceDate: '05 October 2026',
    registrationOffice: 'Bagoan Union Parishad, Raozan, Chattogram',
    brn: '1234567890123456', dob: '01 January 2020'
  });
  show('dedupe', d);
  eq('office1', d.office1, 'Bagoan Union Parishad, Raozan, Chattogram'); // office1 = FULL office name (permanent rule)
  eq('office2', d.office2, 'Raozan, Chattogram');
  if (d.registrationOffice === undefined) pass++;
  else { fail++; console.log('  FAIL registrationOffice still in output: ' + JSON.stringify(d.registrationOffice)); }
}

// ---- 13) English address TITLE CASE (input case-agnostic) ------------------
console.log('CASE 13 address title-case (small + ALL CAPS input)');
{
  const assets = { qr: 'data:image/png;base64,x', barcode: 'data:image/png;base64,x', code: 'QHHI', logo: '', seal: '' };
  const rec = (en) => ({ brn: '123', permEn: en, permBn: 'x', dobWords: '', verificationCode: 'QHHI' });
  const want = 'Amal Chy Bari, Middle Mohara';
  const h1 = buildCertificateHtml(rec('amal chy bari,middle mohara'), assets);
  const h2 = buildCertificateHtml(rec('AMAL CHY BARI, MIDDLE MOHARA'), assets);
  const ok1 = h1.includes(want) && !h1.includes('amal chy') && !h1.includes('bari,middle');
  const ok2 = h2.includes(want) && !h2.includes('AMAL CHY');
  if (ok1) pass++; else { fail++; console.log('  FAIL small input title-case: ' + (h1.includes(want) ? 'spacing' : 'case')); }
  if (ok2) pass++; else { fail++; console.log('  FAIL caps input title-case: ' + (h2.includes(want) ? 'leftover' : 'missing')); }
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

