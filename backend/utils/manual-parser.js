// ============================================================
// Manual submission text parser
// Parses customer-pasted "Key: Value" text (Bengali/English) into
// structured sections. Handles:
//   - Section headers:  [ ঠিকানার বিবরণ / Address Details ]
//   - Separator lines:  ----...  (ignored)
//   - Key: Value lines (value may be empty)
//   - Short 3-line format (no sections -> single "তথ্য" section)
// Output: { sections: [{title, fields:[{key,value}]}], flat: {key:value} }
// Also: toCleanText() -> copy-paste friendly organized text
//       toHTML()      -> beautiful admin-view HTML (escaped)
// ============================================================

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseManualText(raw) {
  const text = String(raw || '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const sections = [];
  let cur = null;

  const newSection = (title) => {
    cur = { title: (title || '').trim() || 'তথ্য', fields: [] };
    sections.push(cur);
  };
  newSection('তথ্য');

  for (let rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // Separator line: only - = _ * characters
    if (/^[-=—_*]{3,}$/.test(line)) continue;
    // Section header: [ ... ]
    const sec = line.match(/^\[(.+)\]$/);
    if (sec) { newSection(sec[1]); continue; }
    // Key: Value  (also handles Key : Value and fullwidth colon)
    const kv = line.match(/^([^:：]+)[:：]\s*(.*)$/);
    if (kv) {
      const key = kv[1].trim();
      const value = kv[2].trim();
      if (key) cur.fields.push({ key, value });
      continue;
    }
    // Continuation line: append to previous field's value
    if (cur.fields.length) {
      const last = cur.fields[cur.fields.length - 1];
      last.value = (last.value ? last.value + ' ' : '') + line;
    }
  }

  // Drop the default section if it stayed empty and others exist
  const filtered = sections.filter(s => s.fields.length > 0);
  const finalSections = filtered.length ? filtered : sections.slice(0, 1);

  const flat = {};
  for (const s of finalSections) {
    for (const f of s.fields) {
      if (!(f.key in flat)) flat[f.key] = f.value;
    }
  }
  return { sections: finalSections, flat };
}

// Clean copy-paste text: organized, never messy.
// Format:  Section title\n  Key: Value\n  ...
function toCleanText(parsed) {
  const out = [];
  for (const s of parsed.sections) {
    if (s.title && s.title !== 'তথ্য') out.push('[' + s.title + ']');
    for (const f of s.fields) {
      out.push(f.key + ': ' + (f.value || '—'));
    }
    out.push('');
  }
  return out.join('\n').trim() + '\n';
}

// Beautiful HTML for admin view (all values escaped).
function toHTML(parsed) {
  let h = '<div class="manual-parsed">';
  for (const s of parsed.sections) {
    h += '<div class="mp-sec"><div class="mp-title">' + esc(s.title) + '</div>';
    h += '<table class="mp-table">';
    for (const f of s.fields) {
      h += '<tr><td class="mp-key">' + esc(f.key) + '</td>' +
           '<td class="mp-val">' + esc(f.value || '—') + '</td></tr>';
    }
    h += '</table></div>';
  }
  return h + '</div>';
}

module.exports = { parseManualText, toCleanText, toHTML, esc };
