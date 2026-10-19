const fs = require('fs');
const path = require('path');
const SRC = process.argv[2] || path.join(__dirname, 'death-verify-server.js');
const lines = fs.readFileSync(SRC, 'utf8').split(/\r?\n/);
const a = lines.findIndex(l => /^function extractRows/.test(l));
const b = lines.findIndex(l => /^function normalizeBdrisData/.test(l));
let c = b + 1;
while (c < lines.length && !/^(function |const |let |var |app\.|module\.|exports)/.test(lines[c])) c++;
eval(lines.slice(a, c).join('\n'));

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  if (String(got || '').trim() === want) pass++;
  else { fail++; console.log(`  FAIL ${name}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`); }
};
const show = (n, d) => console.log(`  ${n}: ${JSON.stringify({
  registrationDate: d.registrationDate, issuanceDate: d.issuanceDate,
  registrationOffice: d.registrationOffice, office1: d.office1, office2: d.office2,
  dob: d.dob, brn: d.brn, sex: d.sex
})}`);

// CASE 1: death 4-col rows [bnLabel][bnValue][enLabel][enValue]
console.log('CASE 1 death 4-col rows');
{
  const html = `<table>
   <tr><td>à¦¨à¦¾à¦®</td><td>à¦œà¦¾à¦¹à¦¾à¦™à§à¦—à§€à¦° à¦†à¦²à¦®</td><td>Dead Person Name</td><td>Jahangir Alam</td></tr>
   <tr><td>à¦®à§ƒà¦¤à§à¦¯à§à¦° à¦¤à¦¾à¦°à¦¿à¦–</td><td>à§§à§¯ à¦¨à¦­à§‡à¦®à§à¦¬à¦° à§¨à§¦à§¨à§¨</td><td>Date of Death</td><td>19 November 2022</td></tr>
   <tr><td>à¦¨à¦¿à¦¬à¦¨à§à¦§à¦¨à§‡à¦° à¦¤à¦¾à¦°à¦¿à¦–</td><td>à§¨à§« à¦¨à¦­à§‡à¦®à§à¦¬à¦° à§¨à§¦à§¨à§¨</td><td>Registration Date</td><td>25 November 2022</td></tr>
   <tr><td>à¦‡à¦¸à§à¦¯à§à¦° à¦¤à¦¾à¦°à¦¿à¦–</td><td>à§¦à§§ à¦¡à¦¿à¦¸à§‡à¦®à§à¦¬à¦° à§¨à§¦à§¨à§¨</td><td>Issuance Date</td><td>01 December 2022</td></tr>
   <tr><td>à¦¨à¦¿à¦¬à¦¨à§à¦§à¦¨ à¦•à¦¾à¦°à§à¦¯à¦¾à¦²à¦¯à¦¼</td><td>à¦°à¦¾à¦‰à¦œà¦¾à¦¨</td><td>Registration Office</td><td>Raozan Union Parishad</td></tr>
  </table>`;
  const d = mapResultData(html);
  show('death', d);
  eq('regDate', d.registrationDate, '25 November 2022');
  eq('issueDate', d.issuanceDate, '01 December 2022');
  eq('office', d.registrationOffice, 'Raozan Union Parishad');
  eq('name', d.nameEn, 'Jahangir Alam');
}

// CASE 2: birth header grid â€” label row then value row, EXACT labels (regression)
console.log('CASE 2 birth grid exact labels');
{
  const html = `<table><tr>
    <td>REGISTRATION DATE</td><td>REGISTRATION OFFICE</td><td>ISSUANCE DATE</td>
    <td>DATE OF BIRTH</td><td>BIRTH REGISTRATION NUMBER</td><td>SEX</td></tr>
   <tr><td>30/09/2026</td><td>Bagoan Union Parishad, Raozan</td><td>05/10/2026</td>
    <td>01/01/2020</td><td>1234567890123456</td><td>Male</td></tr></table>`;
  const d = mapBirthResultData(html);
  show('grid', d);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('office', d.registrationOffice, 'Bagoan Union Parishad, Raozan');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('dob', d.dob, '01/01/2020');
  eq('brn', d.brn, '1234567890123456');
  eq('sex', d.sex, 'Male');
}

// CASE 3: <th> labels + alias spelling (old code: exact match + td-only -> fail)
console.log('CASE 3 <th> + alias labels');
{
  const html = `<table>
    <tr><th>Date of Registration</th><th>Registration Office</th><th>Date of Issuance</th></tr>
    <tr><td>30/09/2026</td><td>Bagoan Union Parishad, Raozan</td><td>05/10/2026</td></tr></table>`;
  const d = mapBirthResultData(html);
  show('th-alias', d);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('office', d.registrationOffice, 'Bagoan Union Parishad, Raozan');
  eq('issueDate', d.issuanceDate, '05/10/2026');
}

// CASE 4: pair layout (label|value adjacent)
console.log('CASE 4 pair layout');
{
  const html = `<div><label>Registration Date</label><span>30/09/2026</span></div>
    <div><label>Issuance Date</label><span>05/10/2026</span></div>
    <div><label>Registration Office</label><span>Bagoan Union Parishad, Raozan</span></div>`;
  const d = mapBirthResultData(html);
  show('pair', d);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('office', d.registrationOffice, 'Bagoan Union Parishad, Raozan');
}

// CASE 5: sparse â€” empty value cell must NOT shift remaining values
console.log('CASE 5 sparse values');
{
  const html = `<table><tr><th>Date of Registration</th><th>Registration Office</th><th>Issuance Date</th></tr>
    <tr><td>12/05/2025</td><td></td><td>20/05/2025</td></tr></table>`;
  const d = mapBirthResultData(html);
  show('sparse', d);
  eq('regDate', d.registrationDate, '12/05/2025');
  eq('issueDate', d.issuanceDate, '20/05/2025');
}

// CASE 6: death header sentence + NB footer office location
console.log('CASE 6 death header sentence');
{
  const html = `<table><tr><td colspan="4">Given Death registration number <b>19681517411127048</b> and Date of Death is <b>19 November 2022</b> are belonged to <b> JAHANGIR ALAM</b> with the following particulars:</td></tr></table>`;
  const d = mapResultData(html);
  show('hdr', d);
  eq('brn', d.brn, '19681517411127048');
  eq('dod', d.dod, '19 November 2022');
  eq('name', d.nameEn, 'JAHANGIR ALAM');
}
console.log('CASE 6b NB footer office location');
{
  const html = `<table><tr><th>Registration Date</th></tr><tr><td>30/09/2026</td></tr></table>
   <p>NB: note. Location of the Register office : Raozan, Chattogram. everify</p>`;
  const d = mapBirthResultData(html);
  show('nb', d);
  if (/Raozan, Chattogram/.test(d.officeLocationRaw || '')) pass++;
  else { fail++; console.log(`  FAIL officeLocationRaw: ${JSON.stringify(d.officeLocationRaw)}`); }
}

// CASE 7: e2e office split (office1 = office name line, office2 = full location)
console.log('CASE 7 e2e office1/office2');
{
  const html = `<table><tr><th>Date of Registration</th><th>Registration Office</th><th>Issuance Date</th></tr>
    <tr><td>30 September 2026</td><td>Bagoan Union Parishad</td><td>05 October 2026</td></tr></table>
   <p>NB: note. Location of the Register office : Raozan, Chattogram. everify</p>`;
  const d = normalizeBdrisData(mapBirthResultData(html));
  console.log(`  office1=${JSON.stringify(d.office1)} office2=${JSON.stringify(d.office2)}`);
  eq('regDate', d.registrationDate, '30/09/2026');
  eq('issueDate', d.issuanceDate, '05/10/2026');
  eq('office1', d.office1, 'Bagoan Union Parishad');
  eq('office2', d.office2, 'Raozan, Chattogram');
}

// CASE 8: office name EKBAR — response-e registrationOffice NA (dedupe)
console.log('CASE 8 dedupe (registrationOffice removed from response)');
{
  const html = `<table><tr><th>Date of Registration</th><th>Registration Office</th><th>Issuance Date</th></tr>
    <tr><td>30/09/2026</td><td>Bagoan Union Parishad, Raozan, Chattogram</td><td>05/10/2026</td></tr></table>`;
  const d = normalizeBdrisData(mapBirthResultData(html));
  show('dedupe', d);
  eq('office1', d.office1, 'Bagoan Union Parishad');
  eq('office2', d.office2, 'Raozan, Chattogram');
  if (d.registrationOffice === undefined) pass++;
  else { fail++; console.log('  FAIL registrationOffice still in output: ' + JSON.stringify(d.registrationOffice)); }
}

console.log(`\nRESULT pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);

