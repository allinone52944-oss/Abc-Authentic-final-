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
  try {
    const r = await ABC.api('/auth/me');
    if (!r.ok) { location.href = '/login.html'; return; }
    me = (await r.json()).user;
    if (me.role !== 'admin') { location.href = '/dashboard.html'; return; }
    const tabs = document.querySelectorAll('#tabs .admin-tab');
    tabs.forEach(t => {
      t.onclick = () => {
        tabs.forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        show(t.dataset.t);
      };
    });
    const logoutBtn = document.getElementById('logoutBtn');
    if (logoutBtn) {
      logoutBtn.onclick = async () => {
        try {
          await ABC.api('/auth/logout', { method: 'POST', body: { refresh_token: localStorage.getItem('abc_refresh_token') } });
        } catch (e) {}
        ABC.clearTokens(); location.href = '/login.html';
      };
    }
    show('stats');
    try { VoiceAlert.init(); } catch (e) {}
    try { PushNotify.ensure(); } catch (e) {}
  } catch (e) {
    const c = document.getElementById('content');
    if (c) c.innerHTML = '<div class="err">লোড ব্যর্থ: ' + esc(e.message) + ' <button onclick="location.reload()">পুনরায় চেষ্টা</button></div>';
  }
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
      // Unmatched SMS (separate lightweight endpoint; table may not exist yet)
      try {
        const sr = await ABC.api('/admin/stats/sms');
        if (sr.ok) {
          const sd = await sr.json();
          const us = Number(sd.unmatched_sms || 0);
          if (this._last.sms && us > this._last.sms) {
            this.speak('নতুন পেমেন্ট SMS এসেছে, ম্যাচ হয়নি। অনুগ্রহ করে চেক করুন।');
          }
          this._last.sms = us;
        }
      } catch (e) { /* silent */ }
    } catch (e) { /* silent */ }
  },
  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('abc_voice', this.enabled ? 'on' : 'off');
    if (this.enabled) this.speak('ভয়েস নোটিফিকেশন চালু হয়েছে।');
    return this.enabled;
  },
};

/* ============ Web Push (screen-off sound alerts for admin) ============ */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const PushNotify = {
  LS: 'abc_push',
  get enabled() { return localStorage.getItem(this.LS) !== 'off'; },
  supported() { return ('serviceWorker' in navigator) && ('PushManager' in window); },
  // Ensure an active subscription exists (silent; only when permission already granted)
  async ensure() {
    try {
      if (!this.enabled || !this.supported()) return false;
      if (Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        const kr = await ABC.api('/push/vapid-public-key');
        const kd = await kr.json();
        if (!kd.publicKey) return false;
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(kd.publicKey),
        });
        await ABC.api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
      }
      return true;
    } catch (e) { return false; }
  },
  // User-initiated enable: requests permission, then subscribes
  async enable() {
    try {
      if (!this.supported()) { alert('এই ব্রাউজারে Push নোটিফিকেশন সাপোর্ট নেই'); return false; }
      if (Notification.permission === 'denied') {
        alert('নোটিফিকেশন ব্লক করা আছে — ব্রাউজার সেটিংস থেকে Allow করুন');
        return false;
      }
      if (Notification.permission === 'default') {
        const p = await Notification.requestPermission();
        if (p !== 'granted') { alert('অনুমতি না দিলে Push নোটিফিকেশন আসবে না'); return false; }
      }
      localStorage.setItem(this.LS, 'on');
      const ok = await this.ensure();
      if (ok) alert('🔔 Push নোটিফিকেশন চালু! স্ক্রিন বন্ধ থাকলেও সাউন্ড আসবে।');
      return ok;
    } catch (e) { return false; }
  },
  async disable() {
    localStorage.setItem(this.LS, 'off');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await ABC.api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
    } catch (e) { /* silent */ }
    return false;
  },
  async toggle() { return this.enabled ? this.disable() : this.enable(); },
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
    modal('✏️ ' + u.name,
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
let catCache = null;
async function loadCats() {
  try {
    const r = await ABC.api('/admin/service-categories');
    catCache = r.ok ? (await r.json()).categories : [];
  } catch (e) { catCache = []; }
  return catCache;
}
function catOptions(selected) {
  let h = '<option value="">— ক্যাটাগরি নেই —</option>';
  (catCache || []).forEach(c => {
    h += '<option value="' + c.id + '"' + (selected === c.id ? ' selected' : '') + '>' +
      esc((c.icon || '📁') + ' ' + (c.name_bn || c.name)) + '</option>';
  });
  return h;
}
TABS.services = async () => {
  await loadCats();
  const r = await ABC.api('/admin/services');
  const d = await r.json();
  let html = '<button class="mini-btn ok" onclick="AdmSvc.createForm()" style="margin-bottom:12px;">+ নতুন সেবা</button>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>#</th><th>নাম</th><th>ক্যাটাগরি</th><th>ধরন</th><th>দাম</th><th>স্ট্যাটাস</th><th>কাজ</th></tr>';
  (d.services || []).forEach((s, i) => {
    html += '<tr><td>' + (i + 1) + '</td><td>' + esc(s.name_bn || s.name) + '<br><small style="color:var(--dim)">' + esc(s.name) + '</small></td>' +
      '<td>' + esc(s.category_id ? ((s.category_icon || '📁') + ' ' + (s.category_name_bn || s.category_name || '')) : '—') + '</td>' +
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
      '<div class="field"><label>ক্যাটাগরি</label><select id="sv_cat">' + catOptions(null) + '</select></div>' +
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
      category_id: document.getElementById('sv_cat').value || null,
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
    modal('✏️ ' + (s.name_bn || s.name),
      fld('নাম (বাংলা)', 'text', 'esv_bn', s.name_bn || '') +
      fld('নাম (English)', 'text', 'esv_name', s.name || '') +
      '<div class="field"><label>ক্যাটাগরি</label><select id="esv_cat">' + catOptions(s.category_id) + '</select></div>' +
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
      category_id: document.getElementById('esv_cat').value || null,
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

/* ---------------- SERVICE CATEGORIES ---------------- */
TABS.cats = async () => {
  const r = await ABC.api('/admin/service-categories');
  const d = await r.json();
  const cats = d.categories || [];
  let html = '<button class="mini-btn ok" onclick="AdmCat.createForm()" style="margin-bottom:12px;">+ নতুন ক্যাটাগরি</button>';
  if (!cats.length) {
    html += '<div style="color:var(--muted)">কোনো ক্যাটাগরি নেই — প্রথম ক্যাটাগরি বানান (যেমন: জন্মনিবন্ধন সেবা) 📁</div>';
  } else {
    html += '<div style="overflow-x:auto;"><table class="adm"><tr><th>#</th><th>আইকন</th><th>নাম</th><th>সেবা</th><th>স্ট্যাটাস</th><th>ক্রম</th><th>কাজ</th></tr>';
    cats.forEach((c, i) => {
      html += '<tr><td>' + (i + 1) + '</td><td style="font-size:22px">' + esc(c.icon || '📁') + '</td>' +
        '<td>' + esc(c.name_bn || c.name) + '<br><small style="color:var(--dim)">' + esc(c.name) + '</small></td>' +
        '<td>' + bn(c.service_count) + 'টি</td>' +
        '<td>' + esc(c.status) + '</td>' +
        '<td><button class="mini-btn" onclick="AdmCat.move(\'' + c.id + '\',-1)"' + (i === 0 ? ' disabled' : '') + '>↑</button> ' +
        '<button class="mini-btn" onclick="AdmCat.move(\'' + c.id + '\',1)"' + (i === cats.length - 1 ? ' disabled' : '') + '>↓</button></td>' +
        '<td><button class="mini-btn" onclick="AdmCat.edit(\'' + c.id + '\')">এডিট</button> ' +
        '<button class="mini-btn danger" onclick="AdmCat.del(\'' + c.id + '\')">ডিলিট</button></td></tr>';
    });
    html += '</table></div>' +
      '<div style="color:var(--muted);margin-top:10px;font-size:13px;">💡 ক্যাটাগরি ডিলিট করলে ভিতরের সেবাগুলো ডিলিট হবে না — "অন্যান্য"-তে চলে যাবে।</div>';
  }
  content.innerHTML = html;
};
window.AdmCat = {
  createForm() {
    modal('📁 নতুন ক্যাটাগরি',
      fld('নাম (বাংলা)', 'text', 'ct_bn') + fld('নাম (English)', 'text', 'ct_name') +
      fld('আইকন (emoji)', 'text', 'ct_icon', '📁') +
      '<button class="btn" onclick="AdmCat.create()">তৈরি করুন</button>');
  },
  async create() {
    const r = await ABC.api('/admin/service-categories', { method: 'POST', body: {
      name: v('ct_name') || v('ct_bn'), name_bn: v('ct_bn'), icon: v('ct_icon') || '📁',
    }});
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    closeModal(); show('cats');
  },
  async edit(id) {
    const r = await ABC.api('/admin/service-categories');
    const c = (await r.json()).categories.find(x => x.id === id);
    if (!c) return;
    modal('✏️ ' + (c.name_bn || c.name),
      fld('নাম (বাংলা)', 'text', 'ect_bn', c.name_bn || '') +
      fld('নাম (English)', 'text', 'ect_name', c.name || '') +
      fld('আইকন (emoji)', 'text', 'ect_icon', c.icon || '📁') +
      '<div class="field"><label>স্ট্যাটাস</label><select id="ect_status">' +
      ['active', 'disabled'].map(x => '<option value="' + x + '"' + (c.status === x ? ' selected' : '') + '>' + x + '</option>').join('') +
      '</select></div>' +
      '<button class="btn" onclick="AdmCat.save(\'' + id + '\')">সংরক্ষণ</button>');
  },
  async save(id) {
    const r = await ABC.api('/admin/service-categories/' + id, { method: 'PUT', body: {
      name: v('ect_name'), name_bn: v('ect_bn'), icon: v('ect_icon'),
      status: document.getElementById('ect_status').value,
    }});
    if (!r.ok) { alert('ব্যর্থ'); return; }
    closeModal(); show('cats');
  },
  async del(id) {
    if (!confirm('ক্যাটাগরি ডিলিট করবেন? ভিতরের সেবাগুলো ডিলিট হবে না, "অন্যান্য"-তে চলে যাবে।')) return;
    const r = await ABC.api('/admin/service-categories/' + id + '?confirm=yes', { method: 'DELETE' });
    if (!r.ok) { alert('ব্যর্থ'); return; }
    show('cats');
  },
  async move(id, dir) {
    const r = await ABC.api('/admin/service-categories');
    const cats = (await r.json()).categories || [];
    const i = cats.findIndex(x => x.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cats.length) return;
    const order = cats.map(x => x.id);
    const t = order[i]; order[i] = order[j]; order[j] = t;
    const rr = await ABC.api('/admin/service-categories/reorder', { method: 'PUT', body: { order } });
    if (!rr.ok) { alert('ব্যর্থ'); return; }
    show('cats');
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
/* ---------------- SMS AUTO-MATCH ---------------- */
TABS.sms = async () => {
  const f = window._smsFilter || 'no';
  const r = await ABC.api('/admin/sms?matched=' + f + '&limit=30');
  const d = await r.json();
  const pr = await (await ABC.api('/admin/sms/pending-recharges')).json();
  const pend = pr.pending || [];
  let html =
    '<h3 style="color:var(--gold);margin-bottom:12px;">📩 SMS অটো-ম্যাচ</h3>' +
    '<div style="margin-bottom:12px;">' +
    '<button class="mini-btn' + (f === 'no' ? ' ok' : '') + '" onclick="window._smsFilter=\'no\';show(\'sms\')">⏳ আনম্যাচড</button> ' +
    '<button class="mini-btn' + (f === 'yes' ? ' ok' : '') + '" onclick="window._smsFilter=\'yes\';show(\'sms\')">✅ ম্যাচড</button> ' +
    '<button class="mini-btn' + (f === '' ? ' ok' : '') + '" onclick="window._smsFilter=\'\';show(\'sms\')">📋 সব</button></div>';

  if (!(d.sms || []).length) html += '<div style="color:var(--muted)">কোনো SMS নেই 🎉</div>';
  for (const s of (d.sms || [])) {
    const matched = !!s.matched_recharge_id;
    html += '<div class="list-row" style="cursor:default;"><div>' +
      '<div class="t">৳' + bn(s.amount) + ' <small style="color:var(--dim)">' + esc(s.method || 'unknown') + '</small> ' +
      (matched
        ? '<span class="pill" style="background:#1d3b24;color:#7fd68f;">✅ ম্যাচড</span>'
        : '<span class="pill" style="background:#3b2a1d;color:#e0a75e;">⏳ আনম্যাচড</span>') + '</div>' +
      '<div class="s">প্রেরক: ' + esc(s.sender || '—') + ' • TrxID: ' + esc(s.trxid || '—') + '<br>' +
      '<span style="opacity:.75">"' + esc((s.raw_message || '').slice(0, 120)) + '"</span><br>' +
      new Date(s.created_at).toLocaleString('bn-BD');
    if (matched) {
      html += '<br>👤 ' + esc(s.user_name || '') + ' (' + esc(s.user_phone || '') + ') • ৳' + bn(s.tx_amount);
    }
    html += '</div></div><div style="text-align:right;min-width:150px;">';
    if (!matched) {
      html += '<select id="sms-tx-' + s.id + '" class="mini-btn" style="margin-bottom:6px;max-width:150px;">' +
        '<option value="">রিচার্জ বেছে নিন…</option>';
      for (const p of pend) {
        html += '<option value="' + p.id + '">৳' + bn(p.amount) + ' • ' + esc(p.user_name) + ' • ' + esc(p.trxid || '') + '</option>';
      }
      html += '</select><br>' +
        '<button class="mini-btn ok" onclick="AdmSms.match(\'' + s.id + '\')">🔗 ম্যাচ</button> ' +
        '<button class="mini-btn danger" onclick="AdmSms.ignore(\'' + s.id + '\')">🙈 ইগনোর</button>';
    }
    html += '</div></div>';
  }

  // Forwarding setup instructions
  html += '<div class="form-card" style="margin-top:16px;max-width:none;"><h3 style="color:var(--gold);margin:0 0 10px;">📱 SMS ফরওয়ার্ড সেটআপ (Android)</h3>' +
    '<ol style="color:var(--muted);font-size:14px;line-height:1.9;margin:0;padding-left:20px;">' +
    '<li>Play Store থেকে <b>SMS Forwarder</b> জাতীয় অ্যাপ ইনস্টল করুন।</li>' +
    '<li>ফিল্টার: প্রেরক <b>bKash (16247)</b>, <b>Nagad (16167)</b>, <b>Rocket (16216)</b>।</li>' +
    '<li>Webhook URL বসান:<br><code style="color:var(--gold);word-break:break-all;">' +
    location.origin + '/api/sms/incoming?secret=আপনার_SMS_WEBHOOK_SECRET</code></li>' +
    '<li>মেথড: <b>POST</b>, JSON body: <code>{"sender":"{sender}","message":"{message}"}</code></li>' +
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
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    alert('✅ ম্যাচ সফল! টাকা যোগ হয়েছে।');
    show('sms');
  },
  async ignore(smsId) {
    if (!confirm('এই SMS ইগনোর করবেন?')) return;
    await ABC.api('/admin/sms/' + smsId + '/ignore', { method: 'POST' });
    show('sms');
  },
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

/* ---------------- INVITE LINKS ---------------- */
TABS.invites = async () => {
  const r = await ABC.api('/admin/invites');
  const d = await r.json();
  const rows = (d.invites || []).map(x => {
    const used = Number(x.used_count) || 0;
    const max = x.max_uses == null ? '∞' : bn(x.max_uses);
    const exp = x.expires_at ? new Date(x.expires_at).toLocaleString('bn-BD') : '—';
    const st = !x.is_active ? '<span style="color:#ff6b6b;">বন্ধ</span>'
      : (x.expires_at && new Date(x.expires_at) <= new Date()) ? '<span style="color:#ff6b6b;">মেয়াদ শেষ</span>'
      : (x.max_uses != null && used >= Number(x.max_uses)) ? '<span style="color:#ffb84d;">পূর্ণ</span>'
      : '<span style="color:#7ddb7d;">চালু</span>';
    const link = location.origin + '/login.html?invite=' + encodeURIComponent(x.code);
    return '<tr><td><b>' + esc(x.code) + '</b><br><small style="color:var(--muted)">' + esc(x.note || '') + '</small></td>' +
      '<td>' + used + ' / ' + max + '</td><td>' + exp + '</td><td>' + st + '</td>' +
      '<td style="white-space:nowrap;">' +
      '<button class="mini-btn" onclick="AdmInv.copyLink(\'' + esc(x.code) + '\')">📋 লিংক কপি</button> ' +
      (x.is_active
        ? '<button class="mini-btn danger" onclick="AdmInv.set(\'' + x.id + '\',false)">বন্ধ করুন</button>'
        : '<button class="mini-btn ok" onclick="AdmInv.set(\'' + x.id + '\',true)">চালু করুন</button>') + ' ' +
      '<button class="mini-btn danger" onclick="AdmInv.del(\'' + x.id + '\')">🗑️</button></td></tr>';
  }).join('');
  content.innerHTML =
    '<button class="mini-btn ok" onclick="AdmInv.createForm()" style="margin-bottom:12px;">+ নতুন ইনভাইট লিংক</button>' +
    '<div style="color:var(--muted);font-size:13px;margin-bottom:12px;">রেজিস্ট্রেশন OFF থাকলেও এই লিংক দিয়ে রেজিস্টার করা যাবে।</div>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>কোড / নোট</th><th>ব্যবহার</th><th>মেয়াদ</th><th>স্ট্যাটাস</th><th>কাজ</th></tr>' +
    (rows || '<tr><td colspan="5" style="text-align:center;color:var(--muted)">কোনো লিংক নেই</td></tr>') +
    '</table></div>';
};
window.AdmInv = {
  createForm() {
    modal('🔗 নতুন ইনভাইট লিংক',
      fld('সর্বোচ্চ ব্যবহার (খালি = আনলিমিটেড)', 'number', 'iv_max') +
      fld('মেয়াদ (খালি = মেয়াদহীন)', 'datetime-local', 'iv_exp') +
      fld('নোট', 'text', 'iv_note') +
      '<button class="btn" onclick="AdmInv.create()">তৈরি করুন</button>');
  },
  async create() {
    const exp = v('iv_exp');
    const r = await ABC.api('/admin/invites', { method: 'POST', body: {
      max_uses: v('iv_max') || null,
      expires_at: exp ? new Date(exp).toISOString() : null,
      note: v('iv_note'),
    }});
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    closeModal();
    modal('✅ লিংক তৈরি!',
      '<div class="field"><label>Invite লিংক</label>' +
      '<input type="text" id="iv_link_out" readonly value="' + esc(d.link) + '" style="font-size:13px;"></div>' +
      '<button class="btn" onclick="AdmInv.copyText(document.getElementById(\'iv_link_out\').value)">📋 কপি করুন</button>');
    show('invites');
  },
  copyText(t) {
    const done = () => alert('✅ কপি হয়েছে!');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
    } else fallbackCopy(t, done);
  },
  copyLink(code) {
    this.copyText(location.origin + '/login.html?invite=' + encodeURIComponent(code));
  },
  async set(id, active) {
    await ABC.api('/admin/invites/' + id, { method: 'PUT', body: { is_active: active } });
    show('invites');
  },
  async del(id) {
    if (!confirm('এই লিংকটি মুছে ফেলবেন?')) return;
    await ABC.api('/admin/invites/' + id, { method: 'DELETE' });
    show('invites');
  },
};
function fallbackCopy(t, done) {
  const ta = document.createElement('textarea');
  ta.value = t; document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { alert('কপি ব্যর্থ — লিংকটি সিলেক্ট করে কপি করুন'); }
  ta.remove();
}

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
    '<div class="list-row" style="cursor:default;"><div><div class="t">🔔 Push নোটিফিকেশন</div><div class="s">স্ক্রিন বন্ধ থাকলেও সাউন্ড + ভাইব্রেশন অ্যালার্ট</div></div>' +
    '<button class="mini-btn ' + (PushNotify.enabled ? 'ok' : '') + '" onclick="PushNotify.toggle().then(function(on){this.className=\'mini-btn \'+(on?\'ok\':\'\');this.textContent=on?\'✅ চালু\':\'❌ বন্ধ\';}.bind(this))">' +
    (PushNotify.enabled ? '✅ চালু' : '❌ বন্ধ') + '</button></div>' +
    '<div class="list-row" style="cursor:default;"><div><div class="t">🔊 Religion Voice Greeting</div><div class="s">লগইনে ধর্মভিত্তিক বাংলা ভয়েস শুভেচ্ছা</div></div>' + bool('voice_greeting') + '</div>' +
    '<div class="list-row" style="cursor:default;"><div><div class="t">🔄 ভয়েস রোটেশন</div><div class="s">পুরুষ → মহিলা → শিশু কণ্ঠে পর্যায়ক্রমে</div></div>' + bool('voice_greeting', 'rotation') + '</div>' +
    '<div class="list-row" style="cursor:default;"><div><div class="t">💬 WhatsApp নোটিফিকেশন</div><div class="s">অর্ডার সফল / রিচার্জ সফল হলে গ্রাহকের WhatsApp-এ অটো মেসেজ</div></div>' + bool('whatsapp') + '</div>' +
    fld('WhatsApp বিজনেস নম্বর (ডিসপ্লে)', 'text', 'st_wa_num', ((s.whatsapp || {}).business_number) || '') +
    fld('Phone Number ID', 'text', 'st_wa_phone_id', ((s.whatsapp || {}).phone_number_id) || '') +
    '<div class="field"><label>Access Token (password)</label>' +
    '<input type="password" id="st_wa_token" value="" placeholder="নতুন token বসান (খালি রাখলে আগেরটা থাকবে)" autocomplete="new-password">' +
    '<div class="s" style="margin-top:4px;">' + (((s.whatsapp || {}).access_token_set) ? '✅ Token সেট আছে' : '❌ Token সেট নেই') + '</div></div>' +
    '<div class="field"><button class="mini-btn" onclick="AdmWa.test()">🔗 Test Connection</button></div>' +
    ta('📩 অর্ডার সফল মেসেজ (WhatsApp)', 'st_wa_order_msg', ((s.whatsapp || {}).order_completed_msg) || '', 'প্লেসহোল্ডার: {name} {order_number} {service_name}') +
    ta('📩 রিচার্জ সফল মেসেজ (WhatsApp)', 'st_wa_recharge_msg', ((s.whatsapp || {}).recharge_approved_msg) || '', 'প্লেসহোল্ডার: {name} {amount} {balance}') +
    fld('ইসলাম গ্রিটিং', 'text', 'st_vg_islam', (((s.voice_greeting||{}).greetings||{}).islam) || 'আসসালামু আলাইকুম') +
    fld('হিন্দু গ্রিটিং', 'text', 'st_vg_hindu', (((s.voice_greeting||{}).greetings||{}).hindu) || 'নমস্কার') +
    fld('বৌদ্ধ গ্রিটিং', 'text', 'st_vg_buddhist', (((s.voice_greeting||{}).greetings||{}).buddhist) || 'নমো বুদ্ধায়') +
    fld('খ্রিস্টান গ্রিটিং', 'text', 'st_vg_christian', (((s.voice_greeting||{}).greetings||{}).christian) || 'প্রভুর শান্তি') +
    fld('অন্যান্য গ্রিটিং (খালি = সময়ভিত্তিক)', 'text', 'st_vg_other', (((s.voice_greeting||{}).greetings||{}).other) || '') +
    '<div class="field" style="margin-top:14px;"><label>স্বাগতম বোনাস (৳, ০ = বন্ধ)</label><input type="number" id="st_wb" value="' + ((s.welcome_bonus && s.welcome_bonus.amount) || 0) + '"></div>' +
    '<div class="field"><label>ক্যাশব্যাক % (০ = বন্ধ)</label><input type="number" id="st_cb" value="' + ((s.cashback && s.cashback.percent) || 0) + '"></div>' +
    '<div class="field"><label>ফাইল আপলোড সীমা (MB)</label><input type="number" id="st_mb" value="' + ((s.file_upload && s.file_upload.max_mb) || 5) + '"></div>' +
    '<div class="field"><label>BDRIS আবেদন PDF ডাউনলোড চার্জ (৳, ০ = ফ্রি)</label><input type="number" id="st_bdris_pdf" value="' + (Number(s['bdris_apply.pdf_price']) || 0) + '"></div>' +
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
    const cur = await (await ABC.api('/admin/settings')).json();
    const vg = Object.assign({ enabled: true, rotation: true }, cur.voice_greeting || {});
    vg.greetings = {
      islam: v('st_vg_islam'), hindu: v('st_vg_hindu'), buddhist: v('st_vg_buddhist'),
      christian: v('st_vg_christian'), other: v('st_vg_other'),
    };
    const waCur = Object.assign({ enabled: false, business_number: '' }, cur.whatsapp || {});
    // New token (if any) requires admin password confirmation on the server.
    const newToken = String(v('st_wa_token') || '').trim();
    let admin_password = '';
    if (newToken) {
      admin_password = prompt('WhatsApp token পরিবর্তন করতে আপনার admin password দিন:') || '';
      if (!admin_password) { alert('বাতিল হয়েছে — token পরিবর্তন হয়নি'); return; }
    }
    const waBody = {
      enabled: waCur.enabled === true,
      business_number: String(v('st_wa_num') || '').trim(),
      phone_number_id: String(v('st_wa_phone_id') || '').trim(),
      order_completed_msg: vr('st_wa_order_msg') || waCur.order_completed_msg || '',
      recharge_approved_msg: vr('st_wa_recharge_msg') || waCur.recharge_approved_msg || '',
    };
    const putBody = {
      welcome_bonus: { enabled: Number(v('st_wb')) > 0, amount: Number(v('st_wb')) || 0 },
      cashback: { enabled: Number(v('st_cb')) > 0, percent: Number(v('st_cb')) || 0 },
      file_upload: { max_mb: Number(v('st_mb')) || 5, allowed: ['pdf', 'jpg', 'jpeg', 'png'] },
      'bdris_apply.pdf_price': Number(v('st_bdris_pdf')) || 0,
      voice_greeting: vg,
      whatsapp: waBody,
    };
    if (newToken) {
      waBody.access_token = newToken;
      putBody.admin_password = admin_password; // server verifies before storing
    }
    const resp = await ABC.api('/admin/settings', { method: 'PUT', body: putBody });
    const rd = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(rd.error === 'WRONG_PASSWORD' ? '❌ ভুল password — token পরিবর্তন হয়নি' : '❌ সংরক্ষণ ব্যর্থ');
      return;
    }
    alert('সংরক্ষণ হয়েছে');
  },
};

/* WhatsApp connection test (uses stored token server-side; never exposes it) */
window.AdmWa = {
  async test() {
    try {
      const r = await ABC.api('/admin/settings/whatsapp/test', { method: 'POST', body: {} });
      const d = await r.json().catch(() => ({}));
      alert(d.ok ? ('✅ সংযোগ সফল! নম্বর: ' + (d.number || '')) : ('❌ ব্যর্থ: ' + (d.error || 'FAILED')));
    } catch (e) { alert('❌ ব্যর্থ: ' + e.message); }
  },
};

/* ---------------- helpers ---------------- */
function fld(label, type, id, val) {
  return '<div class="field"><label>' + label + '</label>' +
    '<input type="' + type + '" id="' + id + '" value="' + esc(val || '') + '"></div>';
}
function ta(label, id, val, hint) {
  return '<div class="field"><label>' + label + '</label>' +
    '<textarea id="' + id + '" rows="4" style="width:100%;resize:vertical;">' + esc(val || '') + '</textarea>' +
    (hint ? '<div style="color:#888;font-size:12px;margin-top:4px;">' + hint + '</div>' : '') + '</div>';
}
function v(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }
function vr(id) { const el = document.getElementById(id); return el ? el.value : ''; }
function modal(title, bodyHtml) {
  closeModal();
  const bg = document.createElement('div');
  bg.className = 'modal-bg'; bg.id = 'admModal';
  bg.innerHTML = '<div class="modal"><h3>' + esc(title) + '</h3>' + bodyHtml + '</div>';
  bg.onclick = (e) => { if (e.target === bg) closeModal(); };
  document.body.appendChild(bg);
}
function closeModal() { const m = document.getElementById('admModal'); if (m) m.remove(); }

window.VoiceAlert = VoiceAlert;
window.PushNotify = PushNotify;
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch(() => {}));
} else {
  init().catch(() => {});
}
})();
