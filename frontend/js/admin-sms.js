// SMS hub chunk, split out of admin.js (was ~164 lines inside it).
// Loads BEFORE admin.js; admin.js keeps a one-line shim (TABS.sms
// delegates to window.renderSmsTab at run time).
// NOTE: admin.js is wrapped in an IIFE, so its helpers (esc/bn) are NOT
// global — this chunk defines its own local copies below (mirroring
// admin.js exactly). ABC/show/admToast ARE global (app.js / window
// assignments), so the hub calls those at run time only.
// Includes the SMS delete UI: per-card Delete (unmatched cards
// only) + bulk delete of ignored SMS.
// Local helpers (admin.js keeps its own inside its IIFE; these mirror them).
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function bn(n){return Number(n||0).toLocaleString('bn-BD');}
/* ---------------- SMS AUTO-MATCH ---------------- */
// Audit #36 — short method label for the manual-match dropdown.
function smsMethodBn(m) {
  return { bkash_payment: 'bKash', bkash_personal: 'bKash', nagad: 'Nagad', rocket: 'Rocket' }[(m || '').toLowerCase()] || (m || '—');
}
window.renderSmsTab = async () => {
  const f = window._smsFilter || 'no';
  // Audit #36 — the hub is paged (the backend already returns
  // total/page/limit; the tab just never asked for a page).
  const page = Math.max(1, window._smsPage || 1);
  const r = await ABC.api('/admin/sms?matched=' + f + '&limit=30&page=' + page);
  const d = await r.json();
  const pr = await (await ABC.api('/admin/sms/pending-recharges')).json();
  const pend = pr.pending || [];
  const list = d.sms || [];

  let html = '<div class="adm-page-head">' +
    '<div>' +
      '<h2 class="adm-page-title">📩 SMS গেটওয়ে ও অটো-ম্যাচ হাব</h2>' +
      '<p class="adm-page-sub">ব্যাংকিং SMS পর্যালোচনা ও রিচার্জ অটোমেশন অডিট</p>' +
    '</div>' +
    '<div class="adm-head-actions">' +
      '<button class="mini-btn' + (f === 'no' ? ' ok' : '') + '" onclick="window._smsFilter=\'no\';window._smsPage=1;show(\'sms\')">⏳ আনম্যাচড</button>' +
      '<button class="mini-btn' + (f === 'yes' ? ' ok' : '') + '" onclick="window._smsFilter=\'yes\';window._smsPage=1;show(\'sms\')">✅ ম্যাচড</button>' +
      '<button class="mini-btn' + (f === '' ? ' ok' : '') + '" onclick="window._smsFilter=\'\';window._smsPage=1;show(\'sms\')">📋 সব SMS</button>' +
    '</div>' +
  '</div>';

  // SMS delete: bulk-delete buttons. Ignored-only, when ignored SMS exist;
  // Delete All (matched + unmatched), whenever any SMS exists.
  const _smsTotalAll = d.total_all || 0;
  if ((d.ignored_total || 0) > 0 || _smsTotalAll > 0) {
    html += '<div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap;">' +
      ((d.ignored_total || 0) > 0
        ? '<button class="mini-btn danger" onclick="AdmSms.deleteIgnored(' + (d.ignored_total || 0) + ')">🗑️ সব ignored SMS মুছুন (' + bn(d.ignored_total || 0) + 'টি)</button>'
        : '') +
      (_smsTotalAll > 0
        ? '<button class="mini-btn danger" style="background:#dc2626;color:#fff;border-color:#b91c1c;font-weight:800;" onclick="AdmSms.deleteAll(' + _smsTotalAll + ')">🗑️ সব SMS মুছুন (' + bn(_smsTotalAll) + 'টি)</button>'
        : '') +
    '</div>';
  }

  if (!list.length) {
    html += '<div class="adm-empty-state">' +
      '<div class="adm-empty-icon">📩</div>' +
      '<div class="adm-empty-title">কোনো SMS পাওয়া যায়নি</div>' +
      '<div class="adm-empty-desc">এই ফিল্টারে বর্তমানে কোনো এসএমএস রেকর্ড নেই।</div>' +
    '</div>';
  } else {
    html += '<div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">';
    for (const s of list) {
      const matched = !!s.matched_recharge_id;
      // Bug #3 — OTP/unparsed SMS is not a payment SMS: no match option.
      // Matchable = parsed AND carries both an amount and a TrxID.
      const matchable = !matched && s.parse_status === 'parsed' && s.amount != null && s.trxid != null;
      const method = (s.method || 'unknown').toLowerCase();
      let methodColor = '#2563eb';
      if (method.includes('bkash')) methodColor = '#e11d48';
      else if (method.includes('nagad')) methodColor = '#ea580c';
      else if (method.includes('rocket')) methodColor = '#7c3aed';

      html += '<div class="adm-table-card" style="padding:16px;margin-bottom:0;">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">' +
          '<div style="flex:1;min-width:260px;">' +
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">' +
              '<span style="font-size:18px;font-weight:800;color:#0f172a;">৳' + bn(s.amount) + '</span>' +
              '<span style="padding:2px 8px;border-radius:10px;font-size:11px;font-weight:700;background:#f8fafc;border:1px solid #cbd5e1;color:' + methodColor + ';">' + esc(s.method || 'SMS') + '</span>' +
              (matched
                ? '<span class="st-badge active">✅ ম্যাচড</span>'
                : '<span class="st-badge pending">⏳ আনম্যাচড</span>') +
            '</div>' +
            '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">' +
              'প্রেরক: <b>' + esc(s.sender || '—') + '</b> • TrxID: <span class="adm-code-chip" onclick="AdmInv.copyText(\'' + esc(s.trxid || '') + '\')">' + esc(s.trxid || '—') + ' 📋</span>' +
            '</div>' +
            '<div style="font-size:12px;color:#334155;background:#f8fafc;padding:8px 10px;border-radius:6px;border:1px solid #e2e8f0;margin:6px 0;">' +
              '\"' + esc((s.raw_message || '').slice(0, 160)) + '\"' +
            '</div>' +
            '<div style="font-size:11px;color:#94a3b8;">🕒 ' + new Date(s.created_at).toLocaleString('bn-BD') + '</div>' +
            (matched
              ? '<div style="margin-top:6px;font-size:12px;color:#059669;font-weight:600;">👤 ম্যাচকৃত গ্রাহক: ' + esc(s.user_name || '') + ' (' + esc(s.user_phone || '') + ') • ৳' + bn(s.tx_amount) + '</div>'
              : '') +
          '</div>' +
          '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;">' +
            (matchable
              ? '<select id="sms-tx-' + s.id + '" class="mini-btn" style="max-width:300px;font-size:12px;">' +
                  '<option value="">পেন্ডিং রিচার্জ বাছুন…</option>' +
                  pend.map(p => '<option value="' + p.id + '">৳' + bn(p.amount) + ' • ' + esc(smsMethodBn(p.method)) + ' • ' + esc(p.sender_no || '—') + ' • ' + esc(p.user_name) + ' • ' + esc(p.trxid || '') + '</option>').join('') +
                '</select>' +
                '<div style="display:flex;gap:6px;">' +
                  '<button class="mini-btn ok" onclick="AdmSms.match(\'' + s.id + '\')">🔗 ম্যাচ করুন</button>' +
                  '<button class="mini-btn danger" onclick="AdmSms.ignore(\'' + s.id + '\')">🙈 বাদ দিন</button>' +
                  '<button class="mini-btn danger" onclick="AdmSms.del(\'' + s.id + '\')">🗑️ মুছুন</button>' +
                '</div>'
              : !matched
                ? '<span style="color:#b45309;font-size:12px;font-weight:700;">⚠️ পেমেন্ট SMS নয় — ম্যাচ করা যাবে না</span>' +
                  '<div style="display:flex;gap:6px;">' +
                    '<button class="mini-btn danger" onclick="AdmSms.ignore(\'' + s.id + '\')">🙈 বাদ দিন</button>' +
                    '<button class="mini-btn danger" onclick="AdmSms.del(\'' + s.id + '\')">🗑️ মুছুন</button>' +
                  '</div>'
              // Audit #33 — the label tells HOW the SMS matched: only an
              // auto-match is "অটো প্রসেসড"; a manual match says so, and
              // a legacy row (matched before matched_via existed) says
              // only that it matched.
              : (s.matched_via === 'manual'
                  ? '<span style="color:#2563eb;font-size:12px;font-weight:700;">🔗 ম্যানুয়াল ম্যাচ</span>'
                  : s.matched_via === 'auto'
                    ? '<span style="color:#059669;font-size:12px;font-weight:700;">✓ অটো প্রসেসড</span>'
                    : '<span style="color:#059669;font-size:12px;font-weight:700;">✓ মিলেছে</span>')) +
          '</div>' +
        '</div>' +
      '</div>';
    }
    html += '</div>';
  }

  // Audit #36 — pager (30 per page, from d.total)
  const _smsTotal = d.total || 0;
  const _smsPages = Math.max(1, Math.ceil(_smsTotal / 30));
  if (list.length || _smsTotal > 0) {
    html += '<div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:20px;">' +
      '<button class="mini-btn"' + (page <= 1 ? ' disabled' : '') + ' onclick="window._smsPage=' + (page - 1) + ';show(\'sms\')">← আগের</button>' +
      '<span style="font-size:13px;color:#475569;">পৃষ্ঠা ' + bn(page) + ' / ' + bn(_smsPages) + ' • মোট ' + bn(_smsTotal) + 'টি SMS</span>' +
      '<button class="mini-btn"' + (page >= _smsPages ? ' disabled' : '') + ' onclick="window._smsPage=' + (page + 1) + ';show(\'sms\')">পরের →</button>' +
    '</div>';
  }

  // Forwarding setup instructions
  html += '<div class="adm-table-card" style="padding:20px;"><h3 style="color:#1e40af;margin:0 0 10px;font-size:16px;">📱 SMS ফরওয়ার্ড সেটআপ (Android)</h3>' +
    '<ol style="color:var(--text-muted);font-size:13px;line-height:1.9;margin:0;padding-left:20px;">' +
    '<li>Play Store থেকে <b>SMS Forwarder</b> জাতীয় অ্যাপ ইনস্টল করুন।</li>' +
    '<li>ফিল্টার: প্রেরক <b>bKash (16247)</b>, <b>Nagad (16167)</b>, <b>Rocket (16216)</b>।</li>' +
    '<li>Webhook URL বসান:<br><code id="smsSecretUrl" style="color:#2563eb;word-break:break-all;">' +
    location.origin + '/api/sms/incoming?secret=আপনার_SMS_WEBHOOK_SECRET</code><br>' +
    '<button class="mini-btn" style="margin-top:6px;" onclick="AdmSms.showSecret()">🔑 Secret দেখুন</button></li>' +
    '<li>মেথড: <b>POST</b>, JSON body: <code>{\"sender\":\"{sender}\",\"message\":\"{message}\"}</code></li>' +
    '<li>টাকা ঢুকলেই SMS এলে অটো-ম্যাচ হবে — TrxID মিললে বা টাকা+নম্বর মিললে ✅</li>' +
    '</ol></div>';

  content.innerHTML = html;
};

window.AdmSms = {
  async match(smsId) {
    const sel = document.getElementById('sms-tx-' + smsId);
    if (!sel || !sel.value) { alert('একটি রিচার্জ রিকোয়েস্ট বেছে নিন'); return; }
    if (!confirm('এই SMS-এর সাথে রিচার্জ ম্যাচ করবেন? টাকা ইউজারের ওয়ালেটে যোগ হবে।')) return;
    const r = await ABC.api('/admin/sms/' + smsId + '/match', {
      method: 'POST', body: { transaction_id: sel.value },
    });
    const d = await r.json();
    // Recharge Bug 4: SMS_ALREADY_MATCHED means a racing actor linked this
    // SMS to another recharge — say so plainly instead of the raw code.
    if (!r.ok) { alert(d.error === 'SMS_ALREADY_MATCHED' ? 'এই SMS ইতিমধ্যে অন্য একটি রিচার্জে ব্যবহৃত হয়েছে। তালিকা নতুন করে দেখুন।' : d.error === 'NOT_A_PAYMENT_SMS' ? 'এই SMS পেমেন্ট SMS নয় — এটি দিয়ে রিচার্জ ম্যাচ করা যাবে না।' : 'ব্যর্থ: ' + d.error); return; }
    alert('✅ ম্যাচ সফল! টাকা যোগ হয়েছে।');
    show('sms');
  },
  async ignore(smsId) {
    if (!confirm('এই SMS ইগনোর করবেন?')) return;
    await ABC.api('/admin/sms/' + smsId + '/ignore', { method: 'POST' });
    show('sms');
  },
  // SMS delete: hard-delete one SMS. The backend refuses a matched
  // SMS (400 MATCHED_SMS with a Bengali message) — show that reason.
  async del(smsId) {
    if (!confirm('এই SMS স্থায়ীভাবে মুছে ফেলবেন? এই কাজটি ফেরানো যাবে না।')) return;
    const r = await ABC.api('/admin/sms/' + smsId, { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { alert(d.message || 'ব্যর্থ: ' + (d.error || 'FAILED')); return; }
    admToast('SMS মুছে ফেলা হয়েছে', 'SMS রেকর্ডটি মুছে ফেলা হয়েছে।', 'info');
    show('sms');
  },
  // SMS delete: hard-delete ALL ignored SMS in one go.
  async deleteIgnored(n) {
    if (!confirm(n + 'টি ignored SMS স্থায়ীভাবে মুছে ফেলবেন? এই কাজটি ফেরানো যাবে না।')) return;
    const r = await ABC.api('/admin/sms/delete-ignored', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + (d.error || 'FAILED')); return; }
    admToast('Ignored SMS মোছা হয়েছে', (d.deleted || 0) + 'টি ignored SMS মুছে ফেলা হয়েছে।', 'info');
    show('sms');
  },
  // SMS delete: hard-delete EVERY SMS (matched + unmatched) in one go.
  // Destructive: matched SMS are payment proof — the confirm says so.
  async deleteAll(n) {
    if (!confirm('সতর্কতা: সব ' + n + 'টি SMS স্থায়ীভাবে মুছে ফেলবেন? ম্যাচড SMS-ও মুছে যাবে — সেগুলো রিচার্জের প্রমাণ। এই কাজটি ফেরানো যাবে না।')) return;
    const r = await ABC.api('/admin/sms/delete-all', { method: 'POST', body: { confirm: true } });
    const d = await r.json();
    if (!r.ok) { alert(d.message || 'ব্যর্থ: ' + (d.error || 'FAILED')); return; }
    admToast('সব SMS মোছা হয়েছে', (d.deleted || 0) + 'টি SMS মুছে ফেলা হয়েছে।', 'info');
    show('sms');
  },
  async showSecret() {
    const r = await ABC.api('/admin/sms/secret');
    const d = await r.json();
    if (d.ok && d.configured) {
      const el = document.getElementById('smsSecretUrl');
      const maskedUrl = location.origin + '/api/sms/incoming?secret=' + d.secret;
      if (el) el.textContent = maskedUrl;
      // L-1: full secret needs password confirmation
      const pw = prompt('পুরো secret দেখতে আপনার admin পাসওয়ার্ড দিন (বাতিল = শুধু masked):');
      let secret = d.secret;
      if (pw) {
        const rr = await ABC.api('/admin/sms/secret/reveal', { method: 'POST', body: { admin_password: pw } });
        const dd = await rr.json();
        if (dd.ok && dd.secret) {
          secret = dd.secret;
          if (el) el.textContent = location.origin + '/api/sms/incoming?secret=' + secret;
        } else {
          alert('ভুল পাসওয়ার্ড');
          return;
        }
      }
      prompt('SMS Webhook Secret (কপি করুন):', secret);
    } else {
      alert('Secret পাওয়া যায়নি');
    }
  },
};
