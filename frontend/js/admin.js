/* ============================================================
   All In One (Abc Authentic) - Admin panel logic (Phase 2)
   Tabs: stats, users, orders, services, recharge, coupons,
         banners, notices, activity, settings
   ============================================================ */
(function () {
'use strict';

const STBN = { new:'নতুন', pending:'অপেক্ষমান', processing:'প্রসেসিং', completed:'সম্পন্ন',
  delivered:'ডেলিভার্ড', failed:'ব্যর্থ', cancelled:'বাতিল', refunded:'রিফান্ডেড' };
const content = document.getElementById('content');
let me = null;

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function bn(n){return Number(n||0).toLocaleString('bn-BD');}

async function init() {
  const r = await ABC.api('/auth/me');
  if (!r.ok) { location.href = '/login.html'; return; }
  me = (await r.json()).user;
  if (me.role !== 'admin') { location.href = '/dashboard.html'; return; }
  document.querySelectorAll('#tabs .admin-tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('#tabs .admin-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      show(t.dataset.t);
    };
  });
  document.getElementById('logoutBtn').onclick = async () => {
    await ABC.api('/auth/logout', { method: 'POST', body: { refresh_token: localStorage.getItem('abc_refresh_token') } });
    ABC.clearTokens(); location.href = '/login.html';
  };
  show('stats');
  VoiceAlert.init();
}

async function show(tab) {
  content.innerHTML = '<div style="color:var(--muted)">লোড হচ্ছে…</div>';
  try { await TABS[tab](); }
  catch (e) { content.innerHTML = '<div class="err">লোড ব্যর্থ: ' + esc(e.message) + '</div>'; }
}

/* ============ Phase 3: Voice alerts (Web Speech API, Bengali) ============ */
const VoiceAlert = {
  enabled: localStorage.getItem('abc_voice') !== 'off',
  _last: { recharge: 0, order: 0 },
  _voices: [],
  init() {
    try {
      const load = () => { this._voices = speechSynthesis.getVoices(); };
      load();
      if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = load;
    } catch (e) { /* speech not supported */ }
    // Poll every 30s for new recharge requests & orders
    setInterval(() => this.check(), 30000);
    setTimeout(() => this.check(), 8000);
  },
  speak(text) {
    if (!this.enabled) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'bn-BD';
      // Prefer a Bengali voice if available
      const bn = this._voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('bn'));
      if (bn) u.voice = bn;
      u.rate = 0.95; u.pitch = 1.05;
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  },
  async check() {
    if (!this.enabled || !me || me.role !== 'admin') return;
    try {
      const r = await ABC.api('/admin/stats');
      if (!r.ok) return;
      const s = await r.json();
      const pr = Number(s.pending_recharge || 0);
      const no = Number(s.orders_new || 0);
      if (this._last.recharge && pr > this._last.recharge) {
        this.speak('নতুন রিচার্জ রিকোয়েস্ট এসেছে। অনুগ্রহ করে চেক করুন।');
      } else if (this._last.order && no > this._last.order) {
        this.speak('নতুন অর্ডার এসেছে।');
      }
      this._last.recharge = pr;
      this._last.order = no;
    } catch (e) { /* silent */ }
  },
  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('abc_voice', this.enabled ? 'on' : 'off');
    if (this.enabled) this.speak('ভয়েস নোটিফিকেশন চালু হয়েছে।');
    return this.enabled;
  },
};

const TABS = {};

/* ---------------- STATS ---------------- */
TABS.stats = async () => {
  const r = await ABC.api('/admin/stats');
  const s = await r.json();
  content.innerHTML =
    '<div class="stat-grid">' +
    stat(s.users, 'মোট ইউজার') + stat(s.admins, 'এডমিন') +
    stat(s.orders_total, 'মোট অর্ডার') + stat(s.orders_new, 'নতুন অর্ডার') +
    stat(s.orders_active, 'চলমান অর্ডার') + stat(s.orders_completed, 'সম্পন্ন') +
    stat(s.pending_recharge, 'পেন্ডিং রিচার্জ') + stat('৳' + bn(s.revenue_today), 'আজকের আয়') +
    '</div>' +
    '<div class="form-card" style="max-width:none;"><h2>🚨 দ্রুত কাজ</h2>' +
    '<button class="mini-btn" onclick="document.querySelector(\'[data-t=recharge]\').click()">পেন্ডিং রিচার্জ (' + s.pending_recharge + ')</button> ' +
    '<button class="mini-btn" onclick="document.querySelector(\'[data-t=orders]\').click()">নতুন অর্ডার (' + s.orders_new + ')</button></div>' +
    '<div class="form-card" style="margin-top:14px;"><h3 style="color:var(--gold);margin:0 0 10px;">📊 PDF রিপোর্ট</h3>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">' +
    '<div class="field" style="margin:0;"><label>থেকে</label><input type="date" id="rp_from"></div>' +
    '<div class="field" style="margin:0;"><label>পর্যন্ত</label><input type="date" id="rp_to"></div>' +
    '<button class="mini-btn ok" onclick="AdmReports.dl(\'orders\')">📥 অর্ডার রিপোর্ট</button>' +
    '<button class="mini-btn ok" onclick="AdmReports.dl(\'transactions\')">📥 লেনদেন রিপোর্ট</button>' +
    '</div></div>';
  function stat(n, l) { return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>'; }
};

window.AdmReports = {
  dl(kind) {
    const f = document.getElementById('rp_from').value;
    const t = document.getElementById('rp_to').value;
    const q = (f ? 'from=' + f : '') + (t ? '&to=' + t : '');
    const token = localStorage.getItem('abc_access_token') || '';
    // Use fetch with auth header to download the PDF blob
    fetch('/api/admin/reports/' + kind + (q ? '?' + q : ''), {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(async (r) => {
      if (!r.ok) { alert('রিপোর্ট ব্যর্থ'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = kind + '-report.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }).catch(() => alert('রিপোর্ট ব্যর্থ'));
  },
};

/* ---------------- USERS ---------------- */
TABS.users = async () => {
  const r = await ABC.api('/admin/users?limit=30');
  const d = await r.json();
  let html = '<div style="display:flex;gap:8px;margin-bottom:12px;">' +
    '<input id="uq" placeholder="নাম/ফোন/ইমেইল খুঁজুন" style="flex:1;padding:10px 14px;background:rgba(0,0,0,0.4);border:1px solid rgba(212,175,55,0.25);border-radius:10px;color:var(--cream);outline:none;">' +
    '<button class="mini-btn" onclick="AdmUsers.search()">খুঁজুন</button>' +
    '<button class="mini-btn ok" onclick="AdmUsers.createForm()">+ নতুন ইউজার</button></div>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>নাম</th><th>ফোন</th><th>ধর্ম</th><th>ব্যালেন্স</th><th>স্ট্যাটাস</th><th>কাজ</th></tr>';
  for (const u of d.users) {
    html += '<tr><td>' + esc(u.name) + '<br><small style="color:var(--dim)">' + esc(u.id.slice(0, 8)) + '</small></td>' +
      '<td>' + esc(u.phone) + '</td><td>' + esc(u.religion) + '</td>' +
      '<td>৳' + bn(u.balance) + '</td><td>' + esc(u.status) + '</td>' +
      '<td><button class="mini-btn" onclick="AdmUsers.edit(\'' + u.id + '\')">এডিট</button>' +
      (u.id !== me.id ? '<button class="mini-btn danger" onclick="AdmUsers.del(\'' + u.id + '\',\'' + esc(u.name) + '\')">ডিলিট</button>' : '<small style="color:var(--dim)">(নিজে)</small>') +
      '</td></tr>';
  }
  content.innerHTML = html + '</table></div><div style="color:var(--muted);font-size:12px;margin-top:8px;">মোট: ' + bn(d.total) + '</div>';
};

window.AdmUsers = {
  async search() {
    const q = document.getElementById('uq').value;
    const r = await ABC.api('/admin/users?limit=30&q=' + encodeURIComponent(q));
    const d = await r.json();
    TABS._lastUsers = d.users;
    show('users');
  },
  createForm() {
    modal('👥 নতুন ইউজার',
      fld('নাম', 'text', 'cu_name') + fld('ফোন (01XXXXXXXXX)', 'text', 'cu_phone') +
      fld('WhatsApp *', 'text', 'cu_wa') + fld('ইমেইল', 'email', 'cu_email') +
      fld('পাসওয়ার্ড', 'password', 'cu_pw') +
      '<button class="btn" onclick="AdmUsers.create()">তৈরি করুন</button>');
  },
  async create() {
    const body = {
      name: v('cu_name'), phone: v('cu_phone'), whatsapp: v('cu_wa'),
      email: v('cu_email'), password: v('cu_pw'),
    };
    const r = await ABC.api('/admin/users', { method: 'POST', body });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    closeModal(); show('users');
  },
  async edit(id) {
    const r = await ABC.api('/admin/users?limit=100');
    const u = (await r.json()).users.find(x => x.id === id);
    if (!u) return;
    modal('✏️ ' + esc(u.name),
      fld('নাম', 'text', 'eu_name', u.name) +
      '<div class="field"><label>ধর্ম</label><select id="eu_religion">' +
      ['islam', 'hindu', 'buddhist', 'christian', 'other'].map(x =>
        '<option value="' + x + '"' + (u.religion === x ? ' selected' : '') + '>' + x + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>রোল' + (u.id === me.id ? ' (নিজের রোল বদলানো যাবে না)' : '') + '</label><select id="eu_role" ' + (u.id === me.id ? 'disabled' : '') + '>' +
      ['user', 'admin'].map(x => '<option value="' + x + '"' + (u.role === x ? ' selected' : '') + '>' + x + '</option>').join('') +
      '</select></div>' +
      '<div class="field"><label>স্ট্যাটাস</label><select id="eu_status">' +
      ['active', 'pending', 'disabled', 'blocked'].map(x => '<option value="' + x + '"' + (u.status === x ? ' selected' : '') + '>' + x + '</option>').join('') +
      '</select></div>' +
      fld('ব্যালেন্স যোগ/বাদ (যেমন: 100 বা -50)', 'number', 'eu_bal') +
      fld('নোটিশ পাঠান (ঐচ্ছিক)', 'text', 'eu_notice') +
      '<button class="btn" onclick="AdmUsers.save(\'' + id + '\')">সংরক্ষণ</button> ' +
      '<button class="btn-secondary" onclick="AdmUsers.unblock(\'' + id + '\')">🔓 আনব্লক</button>');
  },
  async save(id) {
    const body = {
      name: v('eu_name'), religion: v('eu_religion'), status: v('eu_status'),
      balance_adjust: v('eu_bal') ? Number(v('eu_bal')) : 0,
    };
    const roleEl = document.getElementById('eu_role');
    if (roleEl && !roleEl.disabled) body.role = roleEl.value;
    const nt = v('eu_notice');
    if (nt) body.notice = { title: 'নোটিশ', message: nt };
    const r = await ABC.api('/admin/users/' + id, { method: 'PUT', body });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    closeModal(); show('users');
  },
  async unblock(id) {
    await ABC.api('/admin/users/' + id + '/unblock', { method: 'POST' });
    alert('আনব্লক হয়েছে'); closeModal(); show('users');
  },
  async del(id, name) {
    if (!confirm('⚠️ সত্যিই ডিলিট করবেন?\n\n' + name + '\n\nসব ডাটা মুছে যাবে: অর্ডার, লেনদেন, কুপন, নোটিশ, চ্যাট, ডকুমেন্ট!')) return;
    if (!confirm('🔴 শেষ কনফার্মেশন — ফিরিয়ে আনা যাবে না!')) return;
    const r = await ABC.api('/admin/users/' + id + '?confirm=yes', { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    alert('ডিলিট হয়েছে'); show('users');
  },
};

/* ---------------- ORDERS ---------------- */
TABS.orders = async () => {
  const r = await ABC.api('/admin/orders?limit=30');
  const d = await r.json();
  let html = '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">' +
    ['new', 'pending', 'processing', 'completed', 'delivered', 'failed', 'cancelled', 'refunded']
      .map(s => '<button class="mini-btn" onclick="AdmOrders.filter(\'' + s + '\')">' + (STBN[s] || s) + '</button>').join('') +
    '<button class="mini-btn" onclick="AdmOrders.filter(\'\')">সব</button></div>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>সেবা</th><th>ইউজার</th><th>দাম</th><th>স্ট্যাটাস</th><th>তারিখ</th><th>কাজ</th></tr>';
  for (const o of d.orders) {
    html += '<tr><td>' + esc(o.service_name_bn || o.service_name) + '</td>' +
      '<td>' + esc(o.user_name) + '<br><small style="color:var(--dim)">' + esc(o.user_phone) + '</small></td>' +
      '<td>৳' + bn(o.price) + '</td>' +
      '<td><span class="badge st-' + o.status + '">' + (STBN[o.status] || o.status) + '</span></td>' +
      '<td><small>' + new Date(o.created_at).toLocaleString('bn-BD') + '</small></td>' +
      '<td><select onchange="AdmOrders.setStatus(\'' + o.id + '\',this.value)">' +
      Object.keys(STBN).map(s => '<option value="' + s + '"' + (o.status === s ? ' selected' : '') + '>' + STBN[s] + '</option>').join('') +
      '</select> <button class="mini-btn" title="সাপোর্ট মেসেজ" onclick="AdmOrders.supportForm(\'' + o.id + '\')">💬</button></td></tr>';
  }
  content.innerHTML = html + '</table></div>';
};
window.AdmOrders = {
  async filter(s) {
    const r = await ABC.api('/admin/orders?limit=30' + (s ? '&status=' + s : ''));
    const d = await r.json();
    // re-render via show then filter — simple: reload tab with query stored
    TABS._f = s; show('orders');
  },
  async setStatus(id, status) {
    const r = await ABC.api('/admin/orders/' + id + '/status', { method: 'PUT', body: { status } });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    show('orders');
  },
  // ---- Support messages (Phase 3) ----
  _tpls: [],
  useTpl(btn) {
    const t = this._tpls[Number(btn.dataset.tpl)];
    if (t) document.getElementById('supMsg').value = t.emoji + ' ' + t.bn;
  },
  async supportForm(orderId) {
    const [tR, mR] = await Promise.all([
      ABC.api('/admin/support-templates'),
      ABC.api('/admin/orders/' + orderId + '/support-messages'),
    ]);
    const t = tR.ok ? await tR.json() : { templates: [] };
    this._tpls = t.templates || [];
    const m = mR.ok ? await mR.json() : { messages: [] };
    const hist = (m.messages || []).map((x) =>
      '<div class="sup-msg"><span class="sup-text">' + esc(x.message) + '</span>' +
      '<div class="sup-time">' + new Date(x.created_at).toLocaleString('bn-BD') + '</div></div>'
    ).join('') || '<p style="color:var(--muted);font-size:13px;">এখনো কোনো মেসেজ পাঠানো হয়নি</p>';
    modal('💬 সাপোর্ট মেসেজ পাঠান',
      '<div class="field"><label>রেডিমেড টেমপ্লেট</label><div style="display:flex;flex-wrap:wrap;gap:6px;">' +
      t.templates.map((x, i) =>
        '<button class="mini-btn" data-tpl="' + i + '" onclick="AdmOrders.useTpl(this)">' + x.emoji + ' ' + esc(x.bn.slice(0, 28)) + '…</button>'
      ).join('') + '</div></div>' +
      fld('কাস্টম মেসেজ', 'text', 'supMsg') +
      '<button class="btn" onclick="AdmOrders.sendSupport(\'' + orderId + '\')">পাঠান ➤</button>' +
      '<h4 style="color:var(--gold);margin:14px 0 6px;">পাঠানো মেসেজ</h4>' + hist);
  },
  async sendSupport(orderId) {
    const msg = v('supMsg');
    if (!msg) { alert('মেসেজ লিখুন'); return; }
    const r = await ABC.api('/admin/orders/' + orderId + '/support-message', {
      method: 'POST', body: { message: msg },
    });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    closeModal();
    alert('✅ মেসেজ পাঠানো হয়েছে!');
  },
};

/* ---------------- SERVICES ---------------- */
TABS.services = async () => {
  const r = await ABC.api('/admin/services');
  const d = await r.json();
  let html = '<button class="mini-btn ok" onclick="AdmSvc.createForm()" style="margin-bottom:12px;">+ নতুন সেবা</button>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>#</th><th>নাম</th><th>ধরন</th><th>দাম</th><th>স্ট্যাটাস</th><th>কাজ</th></tr>';
  d.services.forEach((s, i) => {
    html += '<tr><td>' + (i + 1) + '</td><td>' + esc(s.name_bn || s.name) + '<br><small style="color:var(--dim)">' + esc(s.name) + '</small></td>' +
      '<td>' + (s.type === 'manual' ? 'ম্যানুয়াল' : 'অটোমেটেড') + '</td><td>৳' + bn(s.price) + '</td>' +
      '<td>' + esc(s.status) + '</td>' +
      '<td><button class="mini-btn" onclick="AdmSvc.edit(\'' + s.id + '\')">এডিট</button>' +
      '<button class="mini-btn danger" onclick="AdmSvc.del(\'' + s.id + '\')">ডিলিট</button></td></tr>';
  });
  content.innerHTML = html + '</table></div>';
};
window.AdmSvc = {
  createForm() {
    modal('🛎️ নতুন সেবা',
      fld('নাম (বাংলা)', 'text', 'sv_bn') + fld('নাম (English)', 'text', 'sv_name') +
      '<div class="field"><label>ধরন</label><select id="sv_type"><option value="manual">ম্যানুয়াল</option><option value="automated">অটোমেটেড</option></select></div>' +
      fld('দাম (৳)', 'number', 'sv_price') +
      fld('ডকুমেন্ট (কমা দিয়ে: NID, Photo)', 'text', 'sv_docs') +
      '<div class="field"><label>নিয়মাবলী</label><textarea id="sv_rules" rows="3"></textarea></div>' +
      '<button class="btn" onclick="AdmSvc.create()">তৈরি করুন</button>');
  },
  async create() {
    const docs = v('sv_docs').split(',').map(x => x.trim()).filter(Boolean);
    const r = await ABC.api('/admin/services', { method: 'POST', body: {
      name: v('sv_name') || v('sv_bn'), name_bn: v('sv_bn'),
      type: document.getElementById('sv_type').value,
      price: Number(v('sv_price')) || 0,
      documents_required: docs, rules_text: v('sv_rules'),
    }});
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    closeModal(); show('services');
  },
  async edit(id) {
    const r = await ABC.api('/admin/services');
    const s = (await r.json()).services.find(x => x.id === id);
    if (!s) return;
    modal('✏️ ' + esc(s.name_bn || s.name),
      fld('নাম (বাংলা)', 'text', 'esv_bn', s.name_bn || '') +
      fld('নাম (English)', 'text', 'esv_name', s.name || '') +
      fld('দাম (৳)', 'number', 'esv_price', s.price) +
      '<div class="field"><label>স্ট্যাটাস</label><select id="esv_status">' +
      ['active', 'disabled'].map(x => '<option value="' + x + '"' + (s.status === x ? ' selected' : '') + '>' + x + '</option>').join('') +
      '</select></div>' +
      fld('ডকুমেন্ট (কমা দিয়ে)', 'text', 'esv_docs', (s.documents_required || []).join(', ')) +
      '<div class="field"><label>নিয়মাবলী</label><textarea id="esv_rules" rows="3">' + esc(s.rules_text || '') + '</textarea></div>' +
      '<button class="btn" onclick="AdmSvc.save(\'' + id + '\')">সংরক্ষণ</button>');
  },
  async save(id) {
    const docs = v('esv_docs').split(',').map(x => x.trim()).filter(Boolean);
    const r = await ABC.api('/admin/services/' + id, { method: 'PUT', body: {
      name: v('esv_name'), name_bn: v('esv_bn'), price: Number(v('esv_price')) || 0,
      status: document.getElementById('esv_status').value,
      documents_required: docs, rules_text: v('esv_rules'),
    }});
    if (!r.ok) { alert('ব্যর্থ'); return; }
    closeModal(); show('services');
  },
  async del(id) {
    if (!confirm('সেবা ডিলিট করবেন?')) return;
    if (!confirm('শেষ কনফার্মেশন!')) return;
    const r = await ABC.api('/admin/services/' + id + '?confirm=yes', { method: 'DELETE' });
    if (!r.ok) { alert('ব্যর্থ'); return; }
    show('services');
  },
};

/* ---------------- RECHARGE ---------------- */
TABS.recharge = async () => {
  const r = await ABC.api('/admin/transactions?type=recharge&status=pending&limit=30');
  const d = await r.json();
  let html = '<h3 style="color:var(--gold);margin-bottom:12px;">⏳ পেন্ডিং রিচার্জ (' + bn(d.total) + ')</h3>';
  if (!d.transactions.length) html += '<div style="color:var(--muted)">কোনো পেন্ডিং রিকোয়েস্ট নেই 🎉</div>';
  for (const t of d.transactions) {
    html += '<div class="list-row" style="cursor:default;"><div>' +
      '<div class="t">' + esc(t.user_name) + ' <small style="color:var(--dim)">' + esc(t.user_phone) + '</small></div>' +
      '<div class="s">' + esc(t.method) + ' • ' + esc(t.sender_no) + ' • TrxID: ' + esc(t.trxid) + '<br>' +
      new Date(t.created_at).toLocaleString('bn-BD') + '</div></div>' +
      '<div style="text-align:right;"><div class="pill" style="margin-bottom:6px;">৳' + bn(t.amount) + '</div><br>' +
      '<button class="mini-btn ok" onclick="AdmTx.approve(\'' + t.id + '\')">✅ Approve</button>' +
      '<button class="mini-btn danger" onclick="AdmTx.reject(\'' + t.id + '\')">❌ Reject</button></div></div>';
  }
  content.innerHTML = html;
};
window.AdmTx = {
  async approve(id) {
    if (!confirm('৳ যোগ করবেন?')) return;
    const r = await ABC.api('/admin/transactions/' + id + '/approve', { method: 'PUT' });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    show('recharge');
  },
  async reject(id) {
    if (!confirm('Reject করবেন?')) return;
    await ABC.api('/admin/transactions/' + id + '/reject', { method: 'PUT' });
    show('recharge');
  },
};

/* ---------------- COUPONS ---------------- */
TABS.coupons = async () => {
  const r = await ABC.api('/admin/coupons');
  const d = await r.json();
  let html = '<button class="mini-btn ok" onclick="AdmCp.createForm()" style="margin-bottom:12px;">+ নতুন কুপন</button>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>কোড</th><th>ধরন</th><th>%</th><th>টাকা</th><th>স্ট্যাটাস</th><th>কাজ</th></tr>';
  for (const c of d.coupons) {
    html += '<tr><td><b>' + esc(c.code) + '</b></td><td>' + esc(c.type) + '</td><td>' + c.percent + '%</td>' +
      '<td>৳' + bn(c.amount) + '</td><td>' + esc(c.status) + '</td>' +
      '<td>' + (c.status === 'active'
        ? '<button class="mini-btn danger" onclick="AdmCp.set(\'' + c.id + '\',\'disabled\')">Disable</button>'
        : '<button class="mini-btn ok" onclick="AdmCp.set(\'' + c.id + '\',\'active\')">Enable</button>') + '</td></tr>';
  }
  content.innerHTML = html + '</table></div>';
};
window.AdmCp = {
  createForm() {
    modal('🎟️ নতুন কুপন',
      fld('কোড', 'text', 'cp_code') +
      '<div class="field"><label>ধরন</label><select id="cp_type"><option value="promo">প্রোমো</option><option value="cashback">ক্যাশব্যাক</option></select></div>' +
      fld('শতাংশ %', 'number', 'cp_pct') + fld('টাকা (ফিক্সড)', 'number', 'cp_amt') +
      '<button class="btn" onclick="AdmCp.create()">তৈরি করুন</button>');
  },
  async create() {
    const r = await ABC.api('/admin/coupons', { method: 'POST', body: {
      code: v('cp_code'), type: document.getElementById('cp_type').value,
      percent: Number(v('cp_pct')) || 0, amount: Number(v('cp_amt')) || 0,
    }});
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    closeModal(); show('coupons');
  },
  async set(id, status) {
    await ABC.api('/admin/coupons/' + id, { method: 'PUT', body: { status } });
    show('coupons');
  },
};

/* ---------------- BANNERS ---------------- */
TABS.banners = async () => {
  const r = await ABC.api('/admin/banners');
  const d = await r.json();
  let html = '<button class="mini-btn ok" onclick="AdmBn.createForm()" style="margin-bottom:12px;">+ নতুন ব্যানার</button>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>ধরন</th><th>শিরোনাম</th><th>ডিজাইন</th><th>সক্রিয়</th><th>কাজ</th></tr>';
  for (const b of d.banners) {
    html += '<tr><td>' + esc(b.type) + '</td><td>' + esc(b.title) + '</td><td>#' + b.design_id + '</td>' +
      '<td>' + (b.active ? '✅' : '❌') + '</td>' +
      '<td><button class="mini-btn" onclick="AdmBn.editForm(\'' + b.id + '\')">✏️ এডিট</button>' +
      '<button class="mini-btn" onclick="AdmBn.toggle(\'' + b.id + '\',' + (!b.active) + ')">' +
      (b.active ? 'বন্ধ' : 'চালু') + '</button>' +
      '<button class="mini-btn danger" onclick="AdmBn.del(\'' + b.id + '\')">ডিলিট</button></td></tr>';
  }
  content.innerHTML = html + '</table></div>' +
    '<div style="color:var(--gold);font-size:12px;margin-top:8px;">✨ ২৪টি animated design — সব edit করা যায়</div>';
};
window.AdmBn = {
  _catalog: null,
  _selDesign: 1,
  async _cat() {
    if (this._catalog) return this._catalog;
    const r = await fetch('/banners/catalog.json');
    this._catalog = await r.json();
    return this._catalog;
  },
  async createForm() {
    this._selDesign = 1;
    const cat = await this._cat();
    modal('🖼️ নতুন ব্যানার/বিজ্ঞাপন/পপআপ',
      '<div class="field"><label>ধরন</label><select id="bn_type"><option value="banner">ব্যানার</option><option value="ad">বিজ্ঞাপন</option><option value="popup">পপআপ</option></select></div>' +
      fld('শিরোনাম (admin)', 'text', 'bn_title') +
      '<div class="field"><label>ডিজাইন বেছে নিন (' + cat.designs.length + 'টি)</label>' +
      '<div class="bn-design-grid" id="bnDesignGrid">' +
      cat.designs.map((d) =>
        '<div class="bn-design-opt' + (d.id === 1 ? ' sel' : '') + '" data-id="' + d.id + '" onclick="AdmBn.pick(' + d.id + ')">' +
        '<div class="dname">#' + d.id + ' ' + esc(d.name) + '</div><div class="dcat">' + esc(d.category) + '</div></div>'
      ).join('') + '</div></div>' +
      '<div class="field"><label>লাইভ প্রিভিউ</label><div class="bn-preview" id="bnPreview"></div></div>' +
      fld('লেখা (বাংলা)', 'text', 'bn_text_bn') +
      fld('লেখা (English)', 'text', 'bn_text_en') +
      fld('লিংক (optional)', 'text', 'bn_link') +
      '<button class="btn" onclick="AdmBn.create()">তৈরি করুন</button>');
    this.updatePreview();
    ['bn_text_bn', 'bn_text_en'].forEach((id) => {
      document.getElementById(id).addEventListener('input', () => this.updatePreview());
    });
  },
  pick(id) {
    this._selDesign = id;
    document.querySelectorAll('.bn-design-opt').forEach((el) => {
      el.classList.toggle('sel', Number(el.dataset.id) === id);
    });
    this.updatePreview();
  },
  async updatePreview() {
    const cat = await this._cat();
    const d = cat.designs.find((x) => x.id === this._selDesign) || cat.designs[0];
    const bn = document.getElementById('bn_text_bn');
    const en = document.getElementById('bn_text_en');
    const lk = document.getElementById('bn_link');
    const html = await BannerRender.render({
      design_id: this._selDesign,
      content: {
        text_bn: (bn && bn.value) || d.default_bn,
        text_en: (en && en.value) || d.default_en,
        link: (lk && lk.value) || '',
      },
    });
    const pv = document.getElementById('bnPreview');
    if (pv) pv.innerHTML = html;
  },
  async create() {
    const r = await ABC.api('/admin/banners', { method: 'POST', body: {
      type: document.getElementById('bn_type').value,
      title: v('bn_title'), design_id: this._selDesign,
      content: { text_bn: v('bn_text_bn'), text_en: v('bn_text_en'), link: v('bn_link') },
    }});
    if (!r.ok) { alert('ব্যর্থ'); return; }
    closeModal(); show('banners');
  },
  async editForm(id) {
    const r = await ABC.api('/admin/banners');
    const d = await r.json();
    const b = (d.banners || []).find((x) => x.id === id);
    if (!b) { alert('পাওয়া যায়নি'); return; }
    this._selDesign = b.design_id;
    const cat = await this._cat();
    const c = b.content || {};
    modal('✏️ ব্যানার এডিট করুন',
      fld('শিরোনাম (admin)', 'text', 'bn_title', b.title) +
      '<div class="field"><label>ডিজাইন</label><div class="bn-design-grid" id="bnDesignGrid">' +
      cat.designs.map((x) =>
        '<div class="bn-design-opt' + (x.id === b.design_id ? ' sel' : '') + '" data-id="' + x.id + '" onclick="AdmBn.pick(' + x.id + ')">' +
        '<div class="dname">#' + x.id + ' ' + esc(x.name) + '</div><div class="dcat">' + esc(x.category) + '</div></div>'
      ).join('') + '</div></div>' +
      '<div class="field"><label>লাইভ প্রিভিউ</label><div class="bn-preview" id="bnPreview"></div></div>' +
      fld('লেখা (বাংলা)', 'text', 'bn_text_bn', c.text_bn || '') +
      fld('লেখা (English)', 'text', 'bn_text_en', c.text_en || '') +
      fld('লিংক', 'text', 'bn_link', c.link || '') +
      '<div class="field"><label><input type="checkbox" id="bn_active" ' + (b.active ? 'checked' : '') + '> সক্রিয়</label></div>' +
      '<button class="btn" onclick="AdmBn.save(\'' + id + '\')">সেভ করুন</button>');
    this.updatePreview();
    ['bn_text_bn', 'bn_text_en'].forEach((x) => {
      document.getElementById(x).addEventListener('input', () => this.updatePreview());
    });
  },
  async save(id) {
    const r = await ABC.api('/admin/banners/' + id, { method: 'PUT', body: {
      title: v('bn_title'), design_id: this._selDesign, active: document.getElementById('bn_active').checked,
      content: { text_bn: v('bn_text_bn'), text_en: v('bn_text_en'), link: v('bn_link') },
    }});
    if (!r.ok) { alert('ব্যর্থ'); return; }
    closeModal(); show('banners');
  },
  async toggle(id, active) {
    await ABC.api('/admin/banners/' + id, { method: 'PUT', body: { active } });
    show('banners');
  },
  async del(id) {
    if (!confirm('ডিলিট করবেন?')) return;
    await ABC.api('/admin/banners/' + id, { method: 'DELETE' });
    show('banners');
  },
};

/* ---------------- NOTICES ---------------- */
TABS.notices = async () => {
  const r = await ABC.api('/admin/notices');
  const d = await r.json();
  let html = '<button class="mini-btn ok" onclick="AdmNt.createForm()" style="margin-bottom:12px;">+ নতুন নোটিশ</button>';
  for (const n of d.notices) {
    html += '<div class="list-row" style="cursor:default;"><div>' +
      '<div class="t">' + esc(n.title) + '</div><div class="s">' + esc(n.message) + '<br>' +
      (n.user_name ? '👤 ' + esc(n.user_name) : '📢 সবাই') + ' • ' + new Date(n.created_at).toLocaleString('bn-BD') + '</div></div>' +
      '<button class="mini-btn danger" onclick="AdmNt.del(\'' + n.id + '\')">ডিলিট</button></div>';
  }
  content.innerHTML = html || '<div style="color:var(--muted)">কোনো নোটিশ নেই</div>';
};
window.AdmNt = {
  createForm() {
    modal('🔔 নতুন নোটিশ',
      fld('শিরোনাম', 'text', 'nt_title') +
      '<div class="field"><label>বার্তা</label><textarea id="nt_msg" rows="3"></textarea></div>' +
      '<div class="field"><label>যার জন্য (খালি = সবাই)</label><input type="text" id="nt_user" placeholder="User ID (ঐচ্ছিক)"></div>' +
      '<button class="btn" onclick="AdmNt.create()">পাঠান</button>');
  },
  async create() {
    const r = await ABC.api('/admin/notices', { method: 'POST', body: {
      title: v('nt_title'), message: v('nt_msg'), user_id: v('nt_user') || null,
    }});
    if (!r.ok) { alert('ব্যর্থ'); return; }
    closeModal(); show('notices');
  },
  async del(id) {
    if (!confirm('ডিলিট করবেন?')) return;
    await ABC.api('/admin/notices/' + id, { method: 'DELETE' });
    show('notices');
  },
};

/* ---------------- ACTIVITY LOG ---------------- */
TABS.activity = async () => {
  const r = await ABC.api('/admin/activity-log?limit=30');
  const d = await r.json();
  let html = '<div style="overflow-x:auto;"><table class="adm"><tr><th>সময়</th><th>এডমিন</th><th>কাজ</th><th>বিস্তারিত</th></tr>';
  for (const a of d.log) {
    html += '<tr><td><small>' + new Date(a.created_at).toLocaleString('bn-BD') + '</small></td>' +
      '<td>' + esc(a.admin_name || '-') + '</td><td><span class="badge">' + esc(a.action) + '</span></td>' +
      '<td><small style="color:var(--dim)">' + esc(JSON.stringify(a.details)).slice(0, 120) + '</small></td></tr>';
  }
  content.innerHTML = html + '</table></div>';
};

/* ---------------- SETTINGS ---------------- */
TABS.settings = async () => {
  const r = await ABC.api('/admin/settings');
  const s = await r.json();
  const bool = (key, sub) => {
    const on = s[key] && s[key][sub || 'enabled'];
    return '<button class="mini-btn ' + (on ? 'ok' : '') + '" onclick="AdmSt.toggle(\'' + key + '\',\'' + (sub || 'enabled') + '\',' + (!on) + ')">' + (on ? '✅ চালু' : '❌ বন্ধ') + '</button>';
  };
  content.innerHTML =
    '<div class="form-card" style="max-width:640px;">' +
    '<h2>⚙️ সিস্টেম সেটিংস</h2>' +
    '<div class="list-row" style="cursor:default;"><div><div class="t">রেজিস্ট্রেশন</div><div class="s">বন্ধ থাকলে শুধু লগইন দেখাবে</div></div>' + bool('registration_enabled') + '</div>' +
    '<div class="list-row" style="cursor:default;"><div><div class="t">মেনটেনেন্স মোড</div><div class="s">সাইট সাময়িক বন্ধ</div></div>' + bool('maintenance_mode') + '</div>' +
    '<div class="list-row" style="cursor:default;"><div><div class="t">🔊 ভয়েস নোটিফিকেশন</div><div class="s">নতুন রিচার্জ/অর্ডারে বাংলা ভয়েস অ্যালার্ট</div></div>' +
    '<button class="mini-btn ' + (VoiceAlert.enabled ? 'ok' : '') + '" onclick="var on=VoiceAlert.toggle();this.className=\'mini-btn \'+(on?\'ok\':\'\');this.textContent=on?\'✅ চালু\':\'❌ বন্ধ\';">' +
    (VoiceAlert.enabled ? '✅ চালু' : '❌ বন্ধ') + '</button></div>' +
    '<div class="field" style="margin-top:14px;"><label>স্বাগতম বোনাস (৳, ০ = বন্ধ)</label><input type="number" id="st_wb" value="' + ((s.welcome_bonus && s.welcome_bonus.amount) || 0) + '"></div>' +
    '<div class="field"><label>ক্যাশব্যাক % (০ = বন্ধ)</label><input type="number" id="st_cb" value="' + ((s.cashback && s.cashback.percent) || 0) + '"></div>' +
    '<div class="field"><label>ফাইল আপলোড সীমা (MB)</label><input type="number" id="st_mb" value="' + ((s.file_upload && s.file_upload.max_mb) || 5) + '"></div>' +
    '<button class="btn" onclick="AdmSt.save()">সংরক্ষণ</button></div>';
};
window.AdmSt = {
  async toggle(key, sub, val) {
    const cur = await (await ABC.api('/admin/settings')).json();
    const obj = Object.assign({}, cur[key] || {});
    obj[sub] = val;
    const body = {}; body[key] = obj;
    await ABC.api('/admin/settings', { method: 'PUT', body });
    show('settings');
  },
  async save() {
    await ABC.api('/admin/settings', { method: 'PUT', body: {
      welcome_bonus: { enabled: Number(v('st_wb')) > 0, amount: Number(v('st_wb')) || 0 },
      cashback: { enabled: Number(v('st_cb')) > 0, percent: Number(v('st_cb')) || 0 },
      file_upload: { max_mb: Number(v('st_mb')) || 5, allowed: ['pdf', 'jpg', 'jpeg', 'png'] },
    }});
    alert('সংরক্ষণ হয়েছে');
  },
};

/* ---------------- helpers ---------------- */
function fld(label, type, id, val) {
  return '<div class="field"><label>' + label + '</label>' +
    '<input type="' + type + '" id="' + id + '" value="' + esc(val || '') + '"></div>';
}
function v(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function modal(title, bodyHtml) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'admModal';
  bg.innerHTML = '<div class="modal"><h3>' + title + '</h3>' + bodyHtml + '</div>';
  bg.onclick = (e) => { if (e.target === bg) closeModal(); };
  document.body.appendChild(bg);
}
function closeModal() { const m = document.getElementById('admModal'); if (m) m.remove(); }

window.VoiceAlert = VoiceAlert;
init();
})();
