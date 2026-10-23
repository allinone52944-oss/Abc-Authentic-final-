'use strict';
/**
 * engines/nid-server-copy/profile-map.js
 *
 * Pure mapping: NID portal (services.nidw.gov.bd/nid-pub) profile
 * label/value pairs -> the `input_data.json` shape that the shared
 * NID card output pipeline (make_fields.py) consumes.
 *
 * Pairs arrive as [{ section, label, value }] scraped from the
 * citizen profile page. Labels may be Bengali or English; the map
 * below covers both. No I/O here — unit-testable.
 */

function normLabel(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[:：]/g, ' ')
    .replace(/[()\-_/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanVal(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

// Top-level (personal) fields: normalised label -> input_data key.
const FIELD_MAP = {
  'নাম': 'Name(Bangla)',
  'name bangla': 'Name(Bangla)',
  'নাম ইংরেজি': 'Name(English)',
  'name english': 'Name(English)',
  'name': 'Name(English)',
  'পিতার নাম': 'Father Name',
  'father name': 'Father Name',
  'father': 'Father Name',
  'মাতার নাম': 'Mother Name',
  'mother name': 'Mother Name',
  'mother': 'Mother Name',
  'স্বামীর নাম': 'Spouse Name',
  'স্ত্রীর নাম': 'Spouse Name',
  'spouse name': 'Spouse Name',
  'spouse': 'Spouse Name',
  'জন্ম তারিখ': 'Date of Birth',
  'date of birth': 'Date of Birth',
  'dob': 'Date of Birth',
  'জন্মস্থান': 'Birth Place',
  'birth place': 'Birth Place',
  'place of birth': 'Birth Place',
  'রক্তের গ্রুপ': 'Blood Group',
  'blood group': 'Blood Group',
  'জাতীয় পরিচয়পত্র নম্বর': 'National ID',
  'জাতীয় পরিচয় পত্র নম্বর': 'National ID',
  'national id': 'National ID',
  'national id no': 'National ID',
  'nid': 'National ID',
  'nid no': 'National ID',
  'nid number': 'National ID',
  'পিন নম্বর': 'Pin',
  'pin': 'Pin',
  'pin no': 'Pin',
  'ভোটার নম্বর': 'Voter No',
  'voter no': 'Voter No',
  'voter number': 'Voter No',
  'সিরিয়াল নম্বর': 'Sl No',
  'serial no': 'Sl No',
  'ফর্ম নম্বর': 'Form No',
  'form no': 'Form No',
  'লিঙ্গ': 'Gender',
  'gender': 'Gender',
  'মোবাইল নম্বর': 'Mobile',
  'মোবাইল': 'Mobile',
  'mobile': 'Mobile',
  'mobile no': 'Mobile',
  'mobile number': 'Mobile',
  'জন্ম নিবন্ধন নম্বর': 'Birth Registration No',
  'birth registration no': 'Birth Registration No',
  'birth registration number': 'Birth Registration No',
  'টিন': 'TIN',
  'tin': 'TIN',
  'পেশা': 'Occupation',
  'occupation': 'Occupation',
  'শিক্ষাগত যোগ্যতা': 'Education',
  'education': 'Education',
  'ধর্ম': 'Religion',
  'religion': 'Religion',
  'পিতার জাতীয় পরিচয়পত্র নম্বর': 'NID Father',
  'father nid': 'NID Father',
  'মাতার জাতীয় পরিচয়পত্র নম্বর': 'NID Mother',
  'mother nid': 'NID Mother',
  'ভোটার এলাকা': 'Voter Area',
  'voter area': 'Voter Area',
};

// Address sub-fields: normalised label -> key inside the
// "Present Address" / "Permanent Address" dict that
// make_fields.compose_address() reads.
const ADDR_MAP = {
  'বিভাগ': 'division',
  'division': 'division',
  'জেলা': 'district',
  'district': 'district',
  'উপজেলা': 'upozila',
  'থানা': 'upozila',
  'upozila': 'upozila',
  'upazila': 'upozila',
  'ইউনিয়ন': 'union_ward',
  'ওয়ার্ড': 'union_ward',
  'union ward': 'union_ward',
  'union': 'union_ward',
  'ward': 'union_ward',
  'মৌজা': 'mouza',
  'মহল্লা': 'mouza',
  'mouza moholla': 'mouza',
  'mouza': 'mouza',
  'গ্রাম': 'village',
  'রাস্তা': 'village',
  'village road': 'village',
  'village': 'village',
  'বাসা হোল্ডিং নম্বর': 'holding',
  'বাসা': 'holding',
  'হোল্ডিং': 'holding',
  'home holding no': 'holding',
  'holding': 'holding',
  'ডাকঘর': 'post_office',
  'post office': 'post_office',
  'পোস্ট কোড': 'postal_code',
  'পোস্টাল কোড': 'postal_code',
  'postal code': 'postal_code',
  'post code': 'postal_code',
  'আরএমও': 'rmo',
  'rmo': 'rmo',
  'সিটি কর্পোরেশন': 'city_corp',
  'পৌরসভা': 'city_corp',
  'city corporation': 'city_corp',
  'municipality': 'city_corp',
};

function sectionKind(section) {
  const s = normLabel(section);
  if (!s) return null;
  if (s.includes('বর্তমান') || s.includes('present')) return 'Present Address';
  if (s.includes('স্থায়ী') || s.includes('permanent')) return 'Permanent Address';
  return null;
}

/**
 * @param {Array<{section?:string,label:string,value:string}>} pairs
 * @returns {object} input_data for make_fields.build_fields()
 */
function buildInputData(pairs) {
  const data = {};
  const present = {};
  const permanent = {};
  let presentStr = '';
  let permanentStr = '';

  for (const p of Array.isArray(pairs) ? pairs : []) {
    const label = normLabel(p && p.label);
    const value = cleanVal(p && p.value);
    if (!label || !value) continue;
    const kind = sectionKind(p && p.section);

    // A whole address given as one string under an address heading.
    if ((label.includes('ঠিকানা') || label === 'address') && value.includes(',')) {
      if (kind === 'Permanent Address' || label.includes('স্থায়ী') || label.includes('permanent')) {
        permanentStr = value;
      } else {
        presentStr = value;
      }
      continue;
    }

    if (kind) {
      const key = ADDR_MAP[label];
      const target = kind === 'Present Address' ? present : permanent;
      if (key && !target[key]) target[key] = value;
      continue;
    }

    const field = FIELD_MAP[label];
    if (field) {
      if (!data[field]) data[field] = value;
      continue;
    }
    // Address sub-fields appearing without a section heading still
    // belong to the present address on this portal's layout.
    const addrKey = ADDR_MAP[label];
    if (addrKey && !present[addrKey]) present[addrKey] = value;
  }

  if (presentStr) data['Present Address'] = presentStr;
  else if (Object.keys(present).length) data['Present Address'] = present;
  if (permanentStr) data['Permanent Address'] = permanentStr;
  else if (Object.keys(permanent).length) data['Permanent Address'] = permanent;

  return data;
}

/** Minimum data needed to render a card at all. */
function hasCoreData(data) {
  if (!data || typeof data !== 'object') return false;
  const name = data['Name(Bangla)'] || data['Name(English)'];
  const nid = data['National ID'] || data['Pin'];
  return Boolean(name && (nid || data['Date of Birth']));
}

module.exports = { buildInputData, hasCoreData, normLabel, FIELD_MAP, ADDR_MAP };
