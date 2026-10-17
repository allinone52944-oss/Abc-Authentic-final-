/* ============================================================
   All In One (Abc Authentic) - Admin panel logic (Phase 2)
   Tabs: stats, users, orders, services, recharge, coupons,
         banners, notices, activity, settings
   ============================================================ */
(function () {
'use strict';

const STBN = { new:'নতুন', pending:'অপেক্ষমান', received:'গৃহীত',
  processing:'প্রসেসিং', registered:'নিবন্ধিত', completed:'সম্পন্ন',
  delivered:'ডেলিভার্ড', failed:'ব্যর্থ', cancelled:'বাতিল', refunded:'রিফান্ডেড' };
const content = document.getElementById('content');
let me = null;

function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function escJs(s){return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'\\"').replace(/\n/g,'\\n');}
function bn(n){return Number(n||0).toLocaleString('bn-BD');}

async function init() {
  try {
    const r = await ABC.api('/auth/me');
    if (!r.ok) {
      // 429/5xx = transient server-side problem, NOT a dead session.
      // Only bounce to login on real auth failures (401/403/404).
      if (r.status === 401 || r.status === 403 || r.status === 404) {
        location.href = '/login.html'; return;
      }
      const c0 = document.getElementById('content');
      if (c0) c0.innerHTML = '<div class="err">সার্ভার ব্যস্ত আছে (কোড ' + r.status + ')। <button class="mini-btn" onclick="location.reload()">পুনরায় চেষ্টা</button></div>';
      return;
    }
    me = (await r.json()).user;
    if (me.role !== 'admin') { location.href = '/dashboard.html'; return; }
    const tabs = document.querySelectorAll('#tabs .side-link');
    tabs.forEach(t => {
      t.onclick = () => {
        tabs.forEach(x => x.classList.remove('on'));
        t.classList.add('on');
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
    try { PushNotify.autoPrompt(); } catch (e) {}
  } catch (e) {
    const c = document.getElementById('content');
    if (c) c.innerHTML = '<div class="err">লোড ব্যর্থ: ' + esc(e.message) + ' <button onclick="location.reload()">পুনরায় চেষ্টা</button></div>';
  }
}

let _showGen = 0;
async function show(tab) {
  const gen = ++_showGen;
  if (!content) return;
  content.innerHTML = '<div style="color:var(--muted)">লোড হচ্ছে…</div>';
  try {
    await TABS[tab]();
    if (gen !== _showGen) return; // Stale: another show() started, don't overwrite
  } catch (e) {
    if (gen !== _showGen) return;
    const msg = String((e && e.message) || e);
    content.innerHTML = '<div class="err">লোড ব্যর্থ: ' + esc(msg) + '</div>';
  }
}

/* ============ Phase 3: Voice alerts (Web Speech API, Bengali) ============ */
const VoiceAlert = {
  enabled: localStorage.getItem('abc_voice') !== 'off',
  _last: { recharge: 0, order: 0 },
  _voices: [],
  // Notification sound (plays alongside TTS; files were unused before)
  playSound(file) {
    if (!this.enabled) return;
    try {
      const a = new Audio('/audio/' + file);
      a.play().catch(() => {});
    } catch (e) {}
  },
  init() {
    try {
      const load = () => { this._voices = speechSynthesis.getVoices(); };
      load();
      // Unlock audio on first user interaction (browser autoplay policy)
      const unlock = () => {
        try {
          const a = new Audio();
          a.play().catch(() => {});
          if (window.speechSynthesis) {
            const u = new SpeechSynthesisUtterance('');
            speechSynthesis.speak(u);
          }
        } catch (e) {}
        document.removeEventListener('click', unlock);
      };
      document.addEventListener('click', unlock, { once: true });
      if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = load;
    } catch (e) { /* speech not supported */ }
    // Poll every 30s for new recharge requests & orders
    setInterval(() => this.check(), 30000);
    setTimeout(() => this.check(), 8000);
  },
  playAudio(file) {
    if (!this.enabled) return;
    try {
      const a = new Audio('/audio/' + file);
      a.play().catch(() => {});
    } catch (e) { /* ignore */ }
  },
  speak(text) {
    // Map text to human voice audio files
    if (text.includes('রিচার্জ')) this.playAudio('new-recharge.mp3');
    else if (text.includes('অর্ডার')) this.playAudio('new-order.mp3');
    else if (text.includes('মেসেজ') || text.includes('SMS')) this.playAudio('new-message.mp3');
    else {
      // Fallback to TTS for unknown
      if (!this.enabled) return;
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'bn-BD';
        speechSynthesis.speak(u);
      } catch (e) { /* ignore */ }
    }
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
        this.playSound('new-recharge.mp3');
        this.speak('নতুন রিচার্জ রিকোয়েস্ট এসেছে। অনুগ্রহ করে চেক করুন।');
        // Speak customer name sweetly via TTS
        try {
          const rr = await ABC.api('/admin/recharge/pending');
          if (rr.ok) {
            const rd = await rr.json();
            const latest = (rd.list || rd)[0];
            if (latest && latest.user_name) {
              setTimeout(() => {
                const u = new SpeechSynthesisUtterance('কাস্টমার: ' + latest.user_name);
                u.lang = 'bn-BD'; u.rate = 0.9; u.pitch = 1.1;
                speechSynthesis.speak(u);
              }, 3500);
            }
          }
        } catch (e) {}
      } else if (this._last.order && no > this._last.order) {
        this.playSound('new-order.mp3');
        this.speak('নতুন অর্ডার এসেছে।');
        // Speak customer name sweetly via TTS
        try {
          const or = await ABC.api('/admin/orders?status=new&limit=1');
          if (or.ok) {
            const od = await or.json();
            const latest = (od.list || od.orders || [])[0];
            if (latest && latest.user_name) {
              setTimeout(() => {
                const u = new SpeechSynthesisUtterance('কাস্টমার: ' + latest.user_name);
                u.lang = 'bn-BD'; u.rate = 0.9; u.pitch = 1.1;
                speechSynthesis.speak(u);
              }, 3500);
            }
          }
        } catch (e) {}
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
  // Auto-prompt once if Push is enabled but permission not yet granted/denied
  async autoPrompt() {
    try {
      if (!this.enabled || !this.supported()) return;
      if (Notification.permission !== 'default') return;
      if (localStorage.getItem('abc_push_prompted')) return;
      localStorage.setItem('abc_push_prompted', '1');
      if (confirm('🔔 Push নোটিফিকেশন চালু করবেন?\n\nনতুন অর্ডার/রিচার্জ এলে সাথে সাথে জানতে পারবেন।')) {
        await this.enable();
      }
    } catch (e) {}
  },
};

const TABS = {};

/* ---------------- STATS ---------------- */
TABS.stats = async () => {
  const r = await ABC.api('/admin/stats');
  if (!r.ok) {
    // Never render stat cards with undefined data (looks like a "broken"
    // dashboard). Surface the failure with a retry instead.
    let why = 'পরিসংখ্যান লোড ব্যর্থ';
    try {
      const d = await r.json();
      if (r.status === 429 || d.error === 'RATE_LIMITED') why += ' — অনেক রিকোয়েস্ট হয়েছে, একটু পরে আবার চেষ্টা করুন';
      else if (d.error) why += ': ' + d.error;
    } catch (e) { why += ' (কোড ' + r.status + ')'; }
    throw new Error(why);
  }
  const s = (await r.json()) || {};
  const num = (v) => (v == null || isNaN(Number(v)) ? 0 : v);
  content.innerHTML =
    '<div class="stat-grid">' +
    stat(num(s.users), 'মোট ইউজার') + stat(num(s.admins), 'এডমিন') +
    stat(num(s.orders_total), 'মোট অর্ডার') + stat(num(s.orders_new), 'নতুন অর্ডার') +
    stat(num(s.orders_active), 'চলমান অর্ডার') + stat(num(s.orders_completed), 'সম্পন্ন') +
    stat(num(s.pending_recharge), 'পেন্ডিং রিচার্জ') + stat('৳' + bn(num(s.revenue_today)), 'আজকের আয়') +
    '</div>' +
    '<div class="form-card" style="max-width:none;"><h2>🚨 দ্রুত কাজ</h2>' +
    '<button class="mini-btn" onclick="document.querySelector(\'[data-t=recharge]\').click()">পেন্ডিং রিচার্জ (' + num(s.pending_recharge) + ')</button> ' +
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
  TABS._upage = 1;
  const _q = TABS._uq || '';
  const r = await ABC.api('/admin/users?limit=30' + (_q ? '&q=' + encodeURIComponent(_q) : ''));
  const d = await r.json();
  let html = '<div style="display:flex;gap:8px;margin-bottom:12px;">' +
    '<input id="uq" placeholder="নাম/ফোন/ইমেইল খুঁজুন" style="flex:1;padding:10px 14px;background:rgba(0,0,0,0.4);border:1px solid rgba(212,175,55,0.25);border-radius:10px;color:var(--cream);outline:none;" value="' + esc(_q) + '">' +
    '<button class="mini-btn" onclick="AdmUsers.search()">খুঁজুন</button>' +
    '<button class="mini-btn ok" onclick="AdmUsers.createForm()">+ নতুন ইউজার</button></div>' +
    '<div style="overflow-x:auto;"><table class="adm" id="uTable"><tr><th>নাম</th><th>ফোন</th><th>ধর্ম</th><th>ব্যালেন্স</th><th>স্ট্যাটাস</th><th>কাজ</th></tr>';
  for (const u of d.users) {
    html += AdmUsers.row(u);
  }
  const shown = (d.users || []).length;
  html += '</table></div><div style="color:var(--muted);font-size:12px;margin-top:8px;">মোট: ' + bn(d.total) + ' (দেখানো: ' + bn(shown) + ')</div>' +
    '<div id="uMore">' + (d.total > shown ? '<button class="mini-btn" onclick="AdmUsers.more()">আরো দেখুন ↓</button>' : '') + '</div>';
  content.innerHTML = html;
};

window.AdmUsers = {
  row(u) {
    const myId = (typeof me !== 'undefined' && me && me.id) || '';
    return '<tr><td>' + esc(u.name) + '<br><small style="color:var(--dim)">' + esc(u.id.slice(0, 8)) + '</small>' +
      (u.email_verified === false ? '<br><small style="color:#f59e0b;">⚠️ ইমেইল অযাচাইকৃত</small>' : '') + '</td>' +
      '<td>' + esc(u.phone) + '</td><td>' + esc(u.religion) + '</td>' +
      '<td>৳' + bn(u.balance) + '</td><td>' + esc(u.status) + '</td>' +
      '<td><button class="mini-btn" onclick="AdmUsers.edit(\'' + u.id + '\')">এডিট</button>' +
      (u.id !== myId ? '<button class="mini-btn danger" onclick="AdmUsers.del(\'' + u.id + '\',\'' + escJs(u.name) + '\')">ডিলিট</button>' : '<small style="color:var(--dim)">(নিজে)</small>') +
      '</td></tr>';
  },
  async more() {
    TABS._upage = (TABS._upage || 1) + 1;
    const _q = TABS._uq || '';
    const r = await ABC.api('/admin/users?limit=30&page=' + TABS._upage + (_q ? '&q=' + encodeURIComponent(_q) : ''));
    const d = await r.json();
    const tbl = document.getElementById('uTable');
    if (tbl) tbl.insertAdjacentHTML('beforeend', (d.users || []).map(u => AdmUsers.row(u)).join(''));
    const shown = tbl ? tbl.rows.length - 1 : 0;
    const moreBox = document.getElementById('uMore');
    if (moreBox) {
      moreBox.innerHTML = (d.total > shown)
        ? '<button class="mini-btn" onclick="AdmUsers.more()">আরো দেখুন ↓ (' + bn(shown) + '/' + bn(d.total) + ')</button>'
        : '<div style="color:var(--muted);font-size:12px;">সব দেখানো হয়েছে (' + bn(d.total) + ')</div>';
    }
  },
  async search() {
    const q = document.getElementById('uq').value;
    TABS._uq = q;
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
    // 4-tab interface (user spec 2026-10-16)
    const tabs = [
      { id: 'profile', icon: '📝', label: 'প্রোফাইল' },
      { id: 'balance', icon: '💰', label: 'ব্যালেন্স' },
      { id: 'services', icon: '🛎️', label: 'সেবা' },
      { id: 'security', icon: '🔒', label: 'সিকিউরিটি' },
    ];
    const activeTab = window._usrTab || 'profile';
    let tabBtns = '<div style="display:flex; gap:6px; margin-bottom:16px; border-bottom:2px solid var(--line); padding-bottom:10px;">';
    tabs.forEach(t => {
      tabBtns += '<button class="mini-btn' + (activeTab === t.id ? ' ok' : '') + '" ' +
        'onclick="window._usrTab=\'' + t.id + '\';AdmUsers.edit(\'' + id + '\')">' + t.icon + ' ' + t.label + '</button>';
    });
    tabBtns += '</div>';

    let body = '';
    if (activeTab === 'profile') {
      body = fld('নাম', 'text', 'eu_name', u.name) +
        fld('ফোন', 'text', 'eu_phone', u.phone || '') +
        fld('WhatsApp নম্বর', 'text', 'eu_wa', u.whatsapp || '') +
        fld('ইমেইল', 'email', 'eu_email', u.email || '') +
        '<div class="field"><label>ধর্ম</label><select id="eu_religion">' +
        ['islam', 'hindu', 'buddhist', 'christian', 'other'].map(x =>
          '<option value="' + x + '"' + (u.religion === x ? ' selected' : '') + '>' + x + '</option>').join('') +
        '</select></div>' +
        '<div class="field"><label>স্ট্যাটাস</label><select id="eu_status">' +
        ['active', 'pending', 'disabled', 'blocked', 'suspended'].map(x => '<option value="' + x + '"' + (u.status === x ? ' selected' : '') + '>' + x + '</option>').join('') +
        '</select></div>' +
        '<button class="btn" onclick="AdmUsers.saveProfile(\'' + id + '\')">💾 সংরক্ষণ</button>';
    } else if (activeTab === 'balance') {
      body = '<div style="background:var(--bg); padding:16px; border-radius:10px; margin-bottom:14px; text-align:center;">' +
        '<div style="font-size:12px; color:var(--dim);">বর্তমান ব্যালেন্স</div>' +
        '<div style="font-size:28px; font-weight:700; color:var(--gold);">৳' + bn(u.balance) + '</div></div>' +
        fld('টাকা (যোগ করতে +সংখ্যা, বাদ দিতে -সংখ্যা)', 'number', 'eu_bal') +
        fld('কারণ/নোট', 'text', 'eu_bal_note') +
        '<div style="display:flex; gap:8px;">' +
        '<button class="btn" style="flex:1;" onclick="AdmUsers.adjustBalance(\'' + id + '\',1)">➕ যোগ</button>' +
        '<button class="btn" style="flex:1; background:#dc2626;" onclick="AdmUsers.adjustBalance(\'' + id + '\',-1)">➖ বাদ</button></div>';
    } else if (activeTab === 'services') {
      body = '<div id="usrSvcList" style="color:var(--dim);">লোড হচ্ছে...</div>';
      // Load after modal opens
      setTimeout(() => AdmUsers.loadUserServices(id), 100);
    } else if (activeTab === 'security') {
      body = '<div style="display:grid; gap:10px;">' +
        '<button class="btn-secondary" onclick="AdmUsers.unblock(\'' + id + '\')">🔓 লিমিট আনব্লক</button>' +
        (u.email_verified ? '<div style="color:#22c55e;">✅ ইমেইল যাচাইকৃত</div>'
          : '<button class="btn-secondary" onclick="AdmUsers.verifyEmail(\'' + id + '\')">✅ ইমেইল যাচাই করুন</button>') +
        '<button class="btn-secondary" onclick="AdmUsers.resetPw(\'' + id + '\')">🔑 পাসওয়ার্ড রিসেট</button>' +
        '<button class="btn-secondary" onclick="AdmUsers.viewData(\'' + id + '\')">📊 ইউজার ডেটা দেখুন</button>' +
        '<button class="btn" style="background:#dc2626;" onclick="AdmUsers.del(\'' + id + '\',\'' + escJs(u.name) + '\')">🗑️ ইউজার ডিলিট</button>' +
        '</div>';
    }

    modal('👤 ' + esc(u.name), tabBtns + body);
  },
  async saveProfile(id) {
    const body = {
      name: v('eu_name'), phone: v('eu_phone'), whatsapp: v('eu_wa'),
      email: v('eu_email'), religion: v('eu_religion'), status: v('eu_status'),
    };
    const r = await ABC.api('/admin/users/' + id, { method: 'PUT', body });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    alert('✅ সংরক্ষণ হয়েছে'); closeModal(); show('users');
  },
  async adjustBalance(id, dir) {
    let amt = Number(v('eu_bal')) || 0;
    if (amt <= 0) { alert('টাকার পরিমাণ দিন'); return; }
    amt = dir * Math.abs(amt);
    const note = v('eu_bal_note');
    const r = await ABC.api('/admin/users/' + id, { method: 'PUT', body: { balance_adjust: amt, balance_note: note } });
    if (!r.ok) { alert('ব্যর্থ'); return; }
    alert('✅ ব্যালেন্স ' + (amt > 0 ? 'যোগ' : 'বাদ') + ' হয়েছে'); closeModal(); show('users');
  },
  async loadUserServices(userId) {
    try {
      const [svcR, ovR] = await Promise.all([
        ABC.api('/admin/services'), ABC.api('/admin/users/' + userId + '/service-overrides'),
      ]);
      const services = (await svcR.json()).services || [];
      const overrides = (await ovR.json()).overrides || {};
      let h = '<div style="display:grid; gap:8px; max-height:400px; overflow-y:auto;">';
      services.forEach(s => {
        const ov = overrides[s.id] || {};
        const enabled = ov.access_enabled !== false;
        const price = ov.custom_price != null ? ov.custom_price : s.price;
        h += '<div style="display:flex; align-items:center; gap:10px; padding:10px; background:var(--bg); border-radius:8px;">' +
          '<span style="font-size:18px;">' + esc(s.icon || '📦') + '</span>' +
          '<div style="flex:1;"><b style="font-size:13px;">' + esc(s.name_bn || s.name) + '</b><br>' +
          '<small style="color:var(--dim);">ডিফল্ট ৳' + bn(s.price) + '</small></div>' +
          '<input type="number" id="usv_price_' + s.id + '" value="' + (ov.custom_price != null ? ov.custom_price : '') + '" ' +
          'placeholder="৳' + s.price + '" style="width:80px; padding:6px; border-radius:6px; border:1px solid var(--line);">' +
          '<button class="mini-btn' + (enabled ? ' ok' : '') + '" onclick="AdmUsers.toggleSvc(\'' + userId + '\',\'' + s.id + '\',' + enabled + ')">' +
          (enabled ? '🟢' : '🔴') + '</button></div>';
      });
      h += '</div><button class="btn" style="margin-top:12px;" onclick="AdmUsers.saveSvcPrices(\'' + userId + '\')">💾 দাম সংরক্ষণ</button>';
      const el = document.getElementById('usrSvcList');
      if (el) el.innerHTML = h;
      window._usrSvcList = services;
    } catch (e) {
      const el = document.getElementById('usrSvcList');
      if (el) el.innerHTML = '<div style="color:#dc2626;">লোড ব্যর্থ</div>';
    }
  },
  async toggleSvc(userId, serviceId, cur) {
    const r = await ABC.api('/admin/users/' + userId + '/service-access', {
      method: 'PUT', body: { service_id: serviceId, enabled: !cur },
    });
    if (!r.ok) { alert('ব্যর্থ'); return; }
    AdmUsers.loadUserServices(userId);
  },
  async saveSvcPrices(userId) {
    const services = window._usrSvcList || [];
    const updates = [];
    services.forEach(s => {
      const el = document.getElementById('usv_price_' + s.id);
      if (el && el.value !== '') updates.push({ service_id: s.id, custom_price: Number(el.value) });
    });
    for (const u of updates) {
      await ABC.api('/admin/users/' + userId + '/service-pricing', { method: 'PUT', body: u });
    }
    alert('✅ দাম সংরক্ষণ হয়েছে');
  },
  async resetPw(id) {
    if (!confirm('পাসওয়ার্ড রিসেট করবেন? নতুন পাসওয়ার্ড ইউজারকে জানাতে হবে।')) return;
    const r = await ABC.api('/admin/users/' + id + '/reset-password', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + (d.error || '')); return; }
    alert('✅ নতুন পাসওয়ার্ড: ' + d.new_password + '\n\nইউজারকে জানান!');
  },
  async viewData(id) {
    const r = await ABC.api('/admin/users/' + id + '/data');
    const d = await r.json();
    alert('অর্ডার: ' + (d.orders || 0) + '\nলেনদেন: ' + (d.transactions || 0) + '\nব্যালেন্স: ৳' + (d.balance || 0));
  },
  async unblock(id) {
    await ABC.api('/admin/users/' + id + '/unblock', { method: 'POST' });
    alert('আনব্লক হয়েছে'); closeModal(); show('users');
  },
  async verifyEmail(id) {
    if (!confirm('এই ইউজারের ইমেইল যাচাইকৃত হিসেবে চিহ্নিত করবেন?')) return;
    const r = await ABC.api('/admin/users/' + id + '/verify-email', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { alert('ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    alert('✅ ইমেইল যাচাই হয়েছে — এখন লগইন করতে পারবে'); closeModal(); show('users');
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
  const _f = TABS._f || '';
  const r = await ABC.api('/admin/orders?limit=30' + (_f ? '&status=' + _f : ''));
  const d = await r.json();
  TABS._orders = d.orders;
  let html = '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">' +
    ['new', 'pending', 'received', 'processing', 'registered', 'completed', 'delivered', 'failed', 'cancelled', 'refunded']
      .map(s => '<button class="mini-btn' + (_f === s ? ' ok' : '') + '" onclick="AdmOrders.filter(\'' + s + '\')">' + (STBN[s] || s) + '</button>').join('') +
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
      '</select> <button class="mini-btn" title="বিস্তারিত" onclick="AdmOrders.view(\'' + o.id + '\')">👁️</button> ' +
      '<button class="mini-btn" title="সাপোর্ট মেসেজ" onclick="AdmOrders.supportForm(\'' + o.id + '\')">💬</button> ' +
      '<button class="mini-btn" title="ডেলিভারি ডকুমেন্ট" onclick="AdmOrders.deliForm(\'' + o.id + '\')">📎</button></td></tr>';
  }
  content.innerHTML = html + '</table></div>';
};
window.AdmOrders = {
  copyData() {
    const t = TABS._viewRaw || '';
    if (!t) { alert('কপি করার মতো ডেটা নেই'); return; }
    navigator.clipboard.writeText(t).then(() => alert('✅ কপি হয়েছে')).catch(() => alert('কপি ব্যর্থ'));
  },
  async dlDoc(orderId, idx) {
    const d = (TABS._viewDocs || [])[idx];
    if (!d) return;
    try {
      const r = await ABC.api('/admin/orders/' + orderId + '/documents/' + encodeURIComponent(d.filename));
      if (!r.ok) { alert('ডাউনলোড ব্যর্থ'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = d.originalname || d.filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } catch (e) { alert('ডাউনলোড ব্যর্থ'); }
  },
  view(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    if (!o) { alert('অর্ডার পাওয়া যায়নি'); return; }
    let dataHtml = '';
    let rawText = '';
    try {
      const data = typeof o.data === 'string' ? JSON.parse(o.data) : (o.data || {});
      // Auto-format: clean key names, trim values
      const formatted = Object.entries(data).map(([k, v]) => {
        const cleanK = String(k).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
        const cleanV = String(v == null ? '' : v).trim();
        rawText += cleanK + ': ' + cleanV + '\n';
        return '<div style="padding:6px 0;border-bottom:1px solid var(--line);font-size:13px;">' +
          '<span style="color:var(--muted)">' + esc(cleanK) + ':</span> ' +
          '<b style="color:var(--cream)">' + esc(cleanV) + '</b></div>';
      }).join('') || '<div style="color:var(--muted)">কোনো ফর্ম ডেটা নেই</div>';
      dataHtml = formatted;
      TABS._viewRaw = rawText;
    } catch (e) { dataHtml = '<div style="color:var(--muted)">ডেটা পড়া যায়নি</div>'; }
    let docsHtml = '';
    try {
      const docs = typeof o.documents === 'string' ? JSON.parse(o.documents || '[]') : (o.documents || []);
      docsHtml = docs.length ?
        docs.map((d, i) => '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;font-size:13px;">' +
          '<span style="flex:1;">📎 ' + esc(d.originalname || d.filename || '') + '</span>' +
          '<button class="mini-btn" onclick="AdmOrders.dlDoc(\'' + o.id + '\',' + i + ')">⬇️ ডাউনলোড</button></div>').join('') :
        '<div style="color:var(--muted);font-size:13px;">কোনো ডকুমেন্ট নেই</div>';
      TABS._viewDocs = docs;
    } catch (e) { docsHtml = '<div style="color:var(--muted)">ডকুমেন্ট পড়া যায়নি</div>'; }
    modal('👁️ অর্ডার বিস্তারিত',
      '<div style="margin-bottom:12px;"><b style="color:var(--gold)">' + esc(o.service_name_bn || o.service_name || '') + '</b><br>' +
      '<span class="badge st-' + o.status + '">' + (STBN[o.status] || o.status) + '</span> ' +
      '<span class="pill">৳' + bn(o.price) + '</span> ' +
      '<button class="mini-btn" onclick="AdmOrders.copyData()">📋 কপি</button><br>' +
      '<small style="color:var(--muted)">👤 ' + esc(o.user_name || '') + ' (' + esc(o.user_phone || '') + ')<br>🕘 ' + new Date(o.created_at).toLocaleString('bn-BD') + '</small></div>' +
      '<div style="color:var(--gold);font-weight:700;margin:10px 0 6px;">📝 ফর্ম ডেটা</div>' + dataHtml +
      '<div style="color:var(--gold);font-weight:700;margin:10px 0 6px;">📎 ডকুমেন্ট</div>' + docsHtml +
      (o.notes ? '<div style="margin-top:10px;font-size:13px;">📝 নোট: ' + esc(o.notes) + '</div>' : '') +
      (o.admin_note ? '<div style="margin-top:6px;font-size:13px;color:var(--gold);">👨‍💼 এডমিন: ' + esc(o.admin_note) + '</div>' : '')
    );
  },
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
  async deliForm(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    // Delivery modal: blank page style, editable (user spec 2026-10-16)
    modal('📎 ডেলিভারি ডকুমেন্ট',
      '<div style="margin-bottom:12px;"><b>' + esc(o ? (o.service_name_bn || o.service_name) : '') + '</b><br>' +
      '<small style="color:var(--muted)">👤 ' + esc(o ? (o.user_name || '') : '') + '</small></div>' +
      '<div id="deliPreview" style="min-height:120px; border:2px dashed var(--line); border-radius:12px; ' +
      'display:flex; align-items:center; justify-content:center; margin-bottom:12px; padding:20px; text-align:center; color:var(--muted);">' +
      '📄 ডকুমেন্ট বেছে নিন<br><small>PDF, JPG, PNG</small></div>' +
      '<input type="file" id="deliFile" accept=".pdf,.jpg,.jpeg,.png" style="display:none;" onchange="AdmOrders.deliPreview(this)">' +
      '<div style="display:flex; gap:8px;">' +
      '<button class="btn" style="flex:1;" onclick="document.getElementById(\'deliFile\').click()">📁 ফাইল বেছে নিন</button>' +
      '<button class="btn" style="flex:1; background:#16a34a;" id="deliUploadBtn" onclick="AdmOrders.deliUpload(\'' + id + '\')" disabled>⬆️ আপলোড</button>' +
      '</div>' +
      '<div style="margin-top:10px;"><button class="btn-secondary" onclick="closeModal()">✕ বন্ধ</button></div>'
    );
    window._deliFile = null;
  },
  deliPreview(inp) {
    const f = inp.files[0];
    if (!f) return;
    window._deliFile = f;
    const pv = document.getElementById('deliPreview');
    const btn = document.getElementById('deliUploadBtn');
    if (f.type.startsWith('image/')) {
      const url = URL.createObjectURL(f);
      pv.innerHTML = '<img src="' + url + '" style="max-width:100%; max-height:300px; border-radius:8px;">' +
        '<br><small>' + esc(f.name) + ' (' + Math.round(f.size / 1024) + ' KB)</small><br>' +
        '<button class="mini-btn danger" style="margin-top:8px;" onclick="AdmOrders.deliClear()">🗑️ বাদ দিন</button>';
    } else {
      pv.innerHTML = '<div style="font-size:48px;">📄</div><b>' + esc(f.name) + '</b><br>' +
        '<small>' + Math.round(f.size / 1024) + ' KB</small><br>' +
        '<button class="mini-btn danger" style="margin-top:8px;" onclick="AdmOrders.deliClear()">🗑️ বাদ দিন</button>';
    }
    if (btn) btn.disabled = false;
  },
  deliClear() {
    window._deliFile = null;
    const pv = document.getElementById('deliPreview');
    const btn = document.getElementById('deliUploadBtn');
    const inp = document.getElementById('deliFile');
    if (pv) pv.innerHTML = '📄 ডকুমেন্ট বেছে নিন<br><small>PDF, JPG, PNG</small>';
    if (btn) btn.disabled = true;
    if (inp) inp.value = '';
  },
  async deliUpload(id) {
    const f = window._deliFile;
    if (!f) { alert('ফাইল বেছে নিন'); return; }
    const fd = new FormData();
    fd.append('file', f);
    fd.append('doc_type', 'delivery');
    const r = await fetch('/api/admin/orders/' + id + '/delivery-docs', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('abc_access_token') },
      body: fd
    });
    const d = await r.json();
    if (r.ok) {
      alert('✅ ডকুমেন্ট আপলোড হয়েছে');
      // Auto-set to delivered if not already
      const o = (TABS._orders || []).find(x => x.id === id);
      if (o && o.status !== 'delivered') {
        if (confirm('Status "ডেলিভার্ড" করবেন?')) {
          await AdmOrders.setStatus(id, 'delivered');
        }
      }
      closeModal(); show('orders');
    } else {
      alert('❌ ব্যর্থ: ' + (d.error || r.status));
    }
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

/* ---------------- MANUAL SUBMISSIONS (standalone module) ---------------- */
const MANUAL_CSS = '<style>' +
 '.mp-sec{margin-bottom:14px;border:1px solid var(--line);border-radius:10px;overflow:hidden;}' +
 '.mp-title{background:#2b1d14;color:var(--gold);font-weight:700;padding:8px 12px;font-size:14px;}' +
 '.mp-table{width:100%;border-collapse:collapse;}' +
 '.mp-table td{padding:7px 12px;border-top:1px solid var(--line);font-size:13px;vertical-align:top;}' +
 '.mp-table tr:first-child td{border-top:none;}' +
 '.mp-key{color:var(--muted);width:42%;}' +
 '.mp-val{color:var(--cream);}' +
 '</style>';

TABS.manual = async () => {
  const f = TABS._mf || '';
  const r = await ABC.api('/admin/manual' + (f ? '?status=' + f : ''));
  const d = await r.json();
  const list = d.list || [];
  const stBn = { new: '🆕 নতুন', processing: '⏳ প্রসেসিং', completed: '✅ সম্পন্ন', rejected: '❌ বাতিল' };
  let html = MANUAL_CSS +
    '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">' +
    Object.keys(stBn).map(s =>
      '<button class="mini-btn' + (f === s ? ' ok' : '') + '" onclick="TABS._mf=\'' + s + '\';show(\'manual\')">' + stBn[s] + '</button>').join('') +
    '<button class="mini-btn' + (!f ? ' ok' : '') + '" onclick="TABS._mf=\'\';show(\'manual\')">সব</button>' +
    '<button class="mini-btn" onclick="AdmManual.tplForm()" style="margin-left:auto;">📝 নমুনা ফরম্যাট</button></div>';
  if (!list.length) {
    html += '<div style="color:var(--muted);">কোনো ম্যানুয়াল আবেদন নেই।</div>';
  } else {
    html += '<div style="overflow-x:auto;"><table class="adm"><tr><th>গ্রাহক</th><th>নাম</th><th>ডকুমেন্ট</th><th>স্ট্যাটাস</th><th>তারিখ</th><th>কাজ</th></tr>';
    for (const m of list) {
      html += '<tr><td>' + esc(m.user_name) + '<br><small style="color:var(--dim)">' + esc(m.user_phone) + '</small></td>' +
        '<td>' + esc(m.name_bn || '—') + '</td>' +
        '<td>📎 ' + (m.doc_count || 0) + '</td>' +
        '<td><span class="badge st-' + m.status + '">' + (stBn[m.status] || m.status) + '</span></td>' +
        '<td><small>' + new Date(m.created_at).toLocaleString('bn-BD') + '</small></td>' +
        '<td><button class="mini-btn" onclick="AdmManual.view(\'' + m.id + '\')">👁️ দেখুন</button></td></tr>';
    }
    html += '</table></div>';
  }
  content.innerHTML = html;
};

window.AdmManual = {
  async view(id) {
    const r = await ABC.api('/admin/manual/' + id);
    const d = await r.json();
    if (!r.ok) { alert('লোড ব্যর্থ'); return; }
    const stBn = { new: '🆕 নতুন', processing: '⏳ প্রসেসিং', completed: '✅ সম্পন্ন', rejected: '❌ বাতিল' };
    const docs = (d.documents || []).map((doc, i) =>
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;padding:8px 12px;border:1px solid var(--line);border-radius:8px;">' +
      '<span style="font-size:20px;">📎</span>' +
      '<span style="flex:1;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(doc.originalname || doc.filename) + '</span>' +
      '<button class="mini-btn" onclick="AdmManual.dlDoc(\'' + d.id + '\',\'' + esc(doc.filename) + '\')">⬇️</button></div>'
    ).join('');
    window._manualClean = d.clean_text || '';
    modal('📝 ম্যানুয়াল আবেদন',
      '<div style="margin-bottom:10px;font-size:13px;color:var(--muted);">👤 ' + esc(d.user_name) + ' (' + esc(d.user_phone) + ') • ' +
      new Date(d.created_at).toLocaleString('bn-BD') + ' • ' + (stBn[d.status] || d.status) + '</div>' +
      MANUAL_CSS + (d.html || '') +
      (docs ? '<div style="margin-top:12px;"><div style="color:var(--gold);font-weight:700;margin-bottom:8px;">📎 ডকুমেন্ট</div>' + docs + '</div>' : '') +
      '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
      '<button class="btn" onclick="AdmManual.copyClean()">📋 কপি করুন</button>' +
      '<select id="mm_status" style="flex:1;min-width:120px;">' +
      Object.keys(stBn).map(s => '<option value="' + s + '"' + (d.status === s ? ' selected' : '') + '>' + stBn[s] + '</option>').join('') +
      '</select>' +
      '<button class="btn-secondary" onclick="AdmManual.setStatus(\'' + d.id + '\')">সংরক্ষণ</button>' +
      '</div>' +
      '<div class="field" style="margin-top:10px;"><label>অ্যাডমিন নোট</label>' +
      '<textarea id="mm_note" rows="2">' + esc(d.admin_note || '') + '</textarea></div>'
    );
  },
  copyClean() {
    const t = window._manualClean || '';
    if (!t) return;
    const done = () => alert('📋 কপি হয়েছে! অন্যখানে পেস্ট করুন।');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(done).catch(() => fallbackCopy(t, done));
    } else fallbackCopy(t, done);
    function fallbackCopy(txt, cb) {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      ta.remove(); cb();
    }
  },
  async setStatus(id) {
    const status = document.getElementById('mm_status').value;
    const admin_note = document.getElementById('mm_note').value;
    const r = await ABC.api('/admin/manual/' + id, { method: 'PUT', body: { status, admin_note } });
    if (!r.ok) { alert('ব্যর্থ'); return; }
    alert('✅ সংরক্ষণ হয়েছে'); closeModal(); show('manual');
  },
  async dlDoc(id, filename) {
    try {
      const r = await ABC.api('/admin/manual/' + id + '/documents/' + encodeURIComponent(filename));
      if (!r.ok) { alert('ডাউনলোড ব্যর্থ'); return; }
      const blob = await r.blob();
      const cd = r.headers.get('content-disposition') || '';
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = m ? decodeURIComponent(m[1]) : filename;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } catch (e) { alert('ডাউনলোড ব্যর্থ'); }
  },
  async tplForm() {
    const r = await ABC.api('/manual/template');
    const d = await r.json();
    modal('📝 নমুনা ফরম্যাট',
      '<p style="color:var(--muted);font-size:13px;">গ্রাহকরা এই ফরম্যাট দেখে তথ্য পাঠাবে।</p>' +
      '<div class="field"><label>ফরম্যাট</label><textarea id="mm_tpl" rows="12">' + esc(d.template || '') + '</textarea></div>' +
      '<button class="btn" onclick="AdmManual.tplSave()">💾 সংরক্ষণ</button>'
    );
  },
  async tplSave() {
    const t = document.getElementById('mm_tpl').value;
    const r = await ABC.api('/admin/settings', { method: 'PUT', body: { manual_template: { text: t } } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { alert('ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    alert('✅ নমুনা ফরম্যাট সংরক্ষণ হয়েছে'); closeModal();
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
/* ============================================================
   UNIFIED: Services + Categories (user spec 2026-10-16)
   - One page: category pills (filter) + "+ ক্যাটাগরি"
   - Services grouped under each category
   - Category: inline rename/reorder/delete
   - Service: price + type + on/off + manual config in one place
   ============================================================ */
TABS.services = async () => {
  await loadCats();
  const r = await ABC.api('/admin/services');
  const d = await r.json();
  const services = d.services || [];
  const cats = TABS._cats || [];
  const activeFilter = TABS._svcFilter || '';

  // Group services by category
  const byCat = {};
  const uncategorized = [];
  services.forEach(s => {
    if (s.category_id && cats.find(c => c.id === s.category_id)) {
      (byCat[s.category_id] = byCat[s.category_id] || []).push(s);
    } else {
      uncategorized.push(s);
    }
  });

  // Filter
  const showCat = (catId) => !activeFilter || activeFilter === catId || (activeFilter === '_uncat' && catId === '_uncat');

  let html = '<div style="margin-bottom:14px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">' +
    '<button class="mini-btn' + (!activeFilter ? ' ok' : '') + '" onclick="TABS._svcFilter=\'\';show(\'services\')">সব</button>';
  cats.forEach(c => {
    html += '<button class="mini-btn' + (activeFilter === c.id ? ' ok' : '') + '" onclick="TABS._svcFilter=\'' + c.id + '\';show(\'services\')">' +
      esc(c.icon || '📁') + ' ' + esc(c.name_bn || c.name) + '</button>';
  });
  if (uncategorized.length) {
    html += '<button class="mini-btn' + (activeFilter === '_uncat' ? ' ok' : '') + '" onclick="TABS._svcFilter=\'_uncat\';show(\'services\')">📦 অন্যান্য</button>';
  }
  html += '<button class="mini-btn ok" onclick="AdmCat.createForm()" style="margin-left:auto;">+ ক্যাটাগরি</button>' +
    '<button class="mini-btn ok" onclick="AdmSvc.createForm()">+ নতুন সেবা</button></div>';

  // Render each category section
  const renderCatSection = (cat, list, isUncat) => {
    if (!showCat(isUncat ? '_uncat' : cat.id)) return '';
    let h = '<div style="background:var(--card); border-radius:12px; padding:14px; margin-bottom:14px;">';
    if (!isUncat) {
      h += '<div style="display:flex; align-items:center; gap:10px; margin-bottom:12px;">' +
        '<span style="font-size:24px;">' + esc(cat.icon || '📁') + '</span>' +
        '<b style="font-size:15px;">' + esc(cat.name_bn || cat.name) + '</b>' +
        '<span style="color:var(--dim); font-size:12px;">' + bn(list.length) + 'টি সেবা</span>' +
        '<span style="margin-left:auto; display:flex; gap:6px;">' +
        '<button class="mini-btn" onclick="AdmCat.edit(\'' + cat.id + '\')">✏️</button>' +
        '<button class="mini-btn" onclick="AdmCat.toggle(\'' + cat.id + '\')">' + (cat.status === 'active' ? '🔴 বন্ধ' : '🟢 চালু') + '</button>' +
        '<button class="mini-btn danger" onclick="AdmCat.del(\'' + cat.id + '\')">🗑️</button>' +
        '</span></div>';
    } else {
      h += '<div style="margin-bottom:12px;"><b>📦 অন্যান্য</b> <span style="color:var(--dim); font-size:12px;">' + bn(list.length) + 'টি</span></div>';
    }
    if (!list.length) {
      h += '<div style="color:var(--dim); font-size:13px;">কোনো সেবা নেই</div>';
    } else {
      h += '<div style="display:grid; gap:8px;">';
      list.forEach(s => {
        const isManual = s.type === 'manual';
        h += '<div style="display:flex; align-items:center; gap:12px; padding:10px 12px; background:var(--bg); border-radius:10px;">' +
          '<span style="font-size:20px;">' + esc(s.icon || (isManual ? '📝' : '⚡')) + '</span>' +
          '<div style="flex:1;"><b>' + esc(s.name_bn || s.name) + '</b><br>' +
          '<small style="color:var(--dim);">' + (isManual ? '📝 ম্যানুয়াল' : '⚡ অটো') + ' • ৳' + bn(s.price) +
          (s.engine_id ? ' • 🔌 ' + esc(s.engine_id) : '') + '</small></div>' +
          '<button class="mini-btn" onclick="AdmSvc.toggleType(\'' + s.id + '\',\'' + s.type + '\')" title="ধরন বদলান">' +
          (isManual ? '→ অটো' : '→ ম্যানুয়াল') + '</button>' +
          '<button class="mini-btn" onclick="AdmSvc.toggleStatus(\'' + s.id + '\',\'' + s.status + '\')">' +
          (s.status === 'active' ? '🟢' : '🔴') + '</button>' +
          '<button class="mini-btn" onclick="AdmSvc.edit(\'' + s.id + '\')">✏️</button>' +
          '<button class="mini-btn danger" onclick="AdmSvc.del(\'' + s.id + '\')">🗑️</button>' +
          '</div>';
      });
      h += '</div>';
    }
    return h + '</div>';
  };

  cats.forEach(c => { html += renderCatSection(c, byCat[c.id] || [], false); });
  if (uncategorized.length) html += renderCatSection(null, uncategorized, true);

  content.innerHTML = html;
};
window.AdmSvc = {
  async toggleType(id, cur) {
    const next = cur === 'manual' ? 'automated' : 'manual';
    if (!confirm('ধরন বদলাবেন? (' + (cur === 'manual' ? 'ম্যানুয়াল → অটো' : 'অটো → ম্যানুয়াল') + ')')) return;
    const r = await ABC.api('/admin/services/' + id, { method: 'PUT', body: { type: next } });
    if (!r.ok) { alert('ব্যর্থ'); return; }
    show('services');
  },
  async toggleStatus(id, cur) {
    const next = cur === 'active' ? 'disabled' : 'active';
    const r = await ABC.api('/admin/services/' + id, { method: 'PUT', body: { status: next } });
    if (!r.ok) { alert('ব্যর্থ'); return; }
    show('services');
  },
  createForm() {
    modal('🛎️ নতুন সেবা',
      fld('নাম (বাংলা)', 'text', 'sv_bn') + fld('নাম (English)', 'text', 'sv_name') +
      '<div class="field"><label>ক্যাটাগরি</label><select id="sv_cat">' + catOptions(null) + '</select></div>' +
      '<div class="field"><label>ধরন</label><select id="sv_type" onchange="document.getElementById(\'sv_manualBox\').style.display=this.value===\'manual\'?\'block\':\'none\';document.getElementById(\'sv_engineBox\').style.display=this.value===\'automated\'?\'block\':\'none\'"><option value="manual">📝 ম্যানুয়াল</option><option value="automated">⚡ অটোমেটেড</option></select></div>' +
      '<div id="sv_engineBox" style="display:none;"><div class="field"><label>🔌 Engine</label><select id="sv_engine">' +
      '<option value="">-- বেছে নিন --</option>' +
      '<option value="birth">Birth Engine (:3000)</option>' +
      '<option value="death">Death Engine (:3001)</option>' +
      '<option value="nid">NID Engine</option>' +
      '<option value="apply">Apply Engine (:3102)</option>' +
      '</select><small style="color:var(--dim)">Engine-এর ভেতরে হাত দেওয়া হবে না</small></div></div>' +
      '<div id="sv_manualBox"><div class="field"><label>📋 নির্দেশনা <small style="color:#64748b;">(user কী করবে)</small></label><textarea id="sv_instructions" rows="3" placeholder="যেমন: নিচের ফরম্যাট অনুযায়ী তথ্য দিন। প্রতিটি লাইনে একটি করে তথ্য লিখুন।" style="font-size:14px;line-height:1.6;"></textarea></div>' +
      '<div class="field"><label>📄 নমুনা ফরম্যাট <small style="color:#64748b;">(user কপি করে পূরণ করবে)</small></label><textarea id="sv_sample" rows="5" placeholder="যেমন:&#10;নাম: &#10;এনআইডি নং: &#10;জন্ম তারিখ: " style="font-family:monospace;font-size:13px;line-height:1.7;background:#f8fafc;"></textarea><small style="color:#64748b;">💡 প্রতিটি field নতুন লাইনে লিখুন। User "📋 কপি" বাটনে ক্লিক করে clean copy পাবে।</small></div>' +
      fld('📎 ডকুমেন্ট সংখ্যা (১-৬)', 'number', 'sv_doccount', '1') + '</div>' +
      fld('দাম (৳)', 'number', 'sv_price') +
      fld('ডকুমেন্ট (কমা দিয়ে: NID, Photo)', 'text', 'sv_docs') +
      '<div class="field"><label>নিয়মাবলী</label><textarea id="sv_rules" rows="3"></textarea></div>' +
      '<button class="btn" onclick="AdmSvc.create()">তৈরি করুন</button>');
  },
  async create() {
    const docs = v('sv_docs').split(',').map(x => x.trim()).filter(Boolean);
    const type = document.getElementById('sv_type').value;
    const r = await ABC.api('/admin/services', { method: 'POST', body: {
      name: v('sv_name') || v('sv_bn'), name_bn: v('sv_bn'),
      type: type,
      price: Number(v('sv_price')) || 0,
      category_id: document.getElementById('sv_cat').value || null,
      documents_required: docs, rules_text: v('sv_rules'),
      engine_id: type === 'automated' ? (document.getElementById('sv_engine').value || null) : null,
      manual_instructions: type === 'manual' ? v('sv_instructions') : null,
      manual_sample: type === 'manual' ? v('sv_sample') : null,
      manual_doc_count: type === 'manual' ? (Number(v('sv_doccount')) || 1) : 1,
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
      '<div class="field"><label>নিয়মাবলী <small style="color:#64748b;">(manual-এর জন্য নির্দেশনা ব্যবহার করুন)</small></label><textarea id="esv_rules" rows="3">' + esc(s.rules_text || '') + '</textarea></div>' +
      '<div class="field"><label>📋 নির্দেশনা <small style="color:#64748b;">(manual service)</small></label><textarea id="esv_instructions" rows="3" style="font-size:14px;line-height:1.6;">' + esc(s.manual_instructions || '') + '</textarea></div>' +
      '<div class="field"><label>📄 নমুনা ফরম্যাট <small style="color:#64748b;">(user কপি করবে)</small></label><textarea id="esv_sample" rows="4" style="font-family:monospace;font-size:13px;line-height:1.7;background:#f8fafc;">' + esc(s.manual_sample || '') + '</textarea></div>' +
      fld('📎 ডকুমেন্ট সংখ্যা (১-৬)', 'number', 'esv_doccount', s.manual_doc_count || 1) +
      '<button class="btn" onclick="AdmSvc.save(\'' + id + '\')">সংরক্ষণ</button>');
  },
  async save(id) {
    const docs = v('esv_docs').split(',').map(x => x.trim()).filter(Boolean);
    const r = await ABC.api('/admin/services/' + id, { method: 'PUT', body: {
      name: v('esv_name'), name_bn: v('esv_bn'), price: Number(v('esv_price')) || 0,
      status: document.getElementById('esv_status').value,
      category_id: document.getElementById('esv_cat').value || null,
      documents_required: docs, rules_text: v('esv_rules'),
      manual_instructions: v('esv_instructions') || null,
      manual_sample: v('esv_sample') || null,
      manual_doc_count: Math.min(6, Math.max(1, Number(v('esv_doccount')) || 1)),
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
  if (!r.ok || !d.transactions) { content.innerHTML = '<div style="color:var(--danger)">⚠️ লোড ব্যর্থ! রিফ্রেশ করুন</div>'; return; }
  // Recharge mode: auto (SMS) + manual (user spec 2026-10-16)
  const mode = window._rechargeMode || 'both';
  let html = '<div style="display:flex; gap:8px; margin-bottom:12px; align-items:center; flex-wrap:wrap;">' +
    '<b style="color:var(--gold);">💰 রিচার্জ মোড:</b>' +
    '<button class="mini-btn' + (mode === 'auto' ? ' ok' : '') + '" onclick="window._rechargeMode=\'auto\';show(\'recharge\')" title="শুধু SMS অটো-ম্যাচ">🤖 অটো</button>' +
    '<button class="mini-btn' + (mode === 'manual' ? ' ok' : '') + '" onclick="window._rechargeMode=\'manual\';show(\'recharge\')" title="শুধু ম্যানুয়াল approve">👤 ম্যানুয়াল</button>' +
    '<button class="mini-btn' + (mode === 'both' ? ' ok' : '') + '" onclick="window._rechargeMode=\'both\';show(\'recharge\')" title="দুটোই চালু">🔀 দুটোই</button>' +
    '<button class="mini-btn" onclick="show(\'sms\')" style="margin-left:auto;">📩 SMS লগ</button></div>';
  html += '<h3 style="color:var(--gold);margin-bottom:12px;">⏳ পেন্ডিং রিচার্জ (' + bn(d.total) + ')</h3>';
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
    '<li>Webhook URL বসান:<br><code id="smsSecretUrl" style="color:var(--gold);word-break:break-all;">' +
    location.origin + '/api/sms/incoming?secret=আপনার_SMS_WEBHOOK_SECRET</code><br>' +
    '<button class="mini-btn" onclick="AdmSms.showSecret()">🔑 Secret দেখুন</button></li>' +
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

window.AdmTx = {
  async approve(id) {
    if (!confirm('৳ যোগ করবেন?')) return;
    const r = await ABC.api('/admin/transactions/' + id + '/approve', { method: 'PUT' });
    const d = await r.json();
    if (!r.ok) {
      alert('⚠️ ' + (d.error === 'DUPLICATE_TRANSACTION'
        ? 'এই রিচার্জটি ইতিমধ্যে approve করা হয়েছে (অন্য admin করেছেন)।'
        : 'ব্যর্থ: ' + d.error));
      return;
    }
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
      '<div class="field"><label>📅 মেয়াদ (তারিখ)</label><input type="date" id="cp_exp"></div>' +
      '<div class="field"><label>🛎️ কোন সেবায় (খালি = সব সেবা)</label><select id="cp_svc"><option value="">সব সেবা</option></select></div>' +
      '<button class="btn" onclick="AdmCp.create()">তৈরি করুন</button>');
    // Load services for dropdown
    ABC.api('/admin/services').then(r => r.json()).then(d => {
      const sel = document.getElementById('cp_svc');
      (d.services || []).forEach(s => {
        const o = document.createElement('option');
        o.value = s.id; o.textContent = (s.name_bn || s.name);
        sel.appendChild(o);
      });
    });
  },
  async create() {
    const exp = document.getElementById('cp_exp').value;
    const svc = document.getElementById('cp_svc').value;
    const r = await ABC.api('/admin/coupons', { method: 'POST', body: {
      code: v('cp_code'), type: document.getElementById('cp_type').value,
      percent: Number(v('cp_pct')) || 0, amount: Number(v('cp_amt')) || 0,
      expires_at: exp || null, service_id: svc || null,
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
  const animBn = { slide: '➡️ স্লাইড', fade: '🔄 ফেইড', ticker: '📰 টিকার', bounce: '⬆️ বাউন্স', none: '⏸️ স্থির' };
  let html = '<button class="mini-btn ok" onclick="AdmBn.createForm()" style="margin-bottom:12px;">+ নতুন ব্যানার</button>' +
    '<div style="overflow-x:auto;"><table class="adm"><tr><th>ধরন</th><th>শিরোনাম</th><th>ডিজাইন</th><th>🎬 অ্যানিমেশন</th><th>সক্রিয়</th><th>কাজ</th></tr>';
  for (const b of d.banners) {
    html += '<tr><td>' + esc(b.type) + '</td><td>' + esc(b.title) + '</td><td>#' + b.design_id + '</td>' +
      '<td><small>' + (animBn[b.animation_type] || b.animation_type || '-') + '<br>⚡' + (b.animation_speed || 30) + '</small></td>' +
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
      '<div class="field"><label>🎬 অ্যানিমেশন</label><select id="bn_anim">' +
      '<option value="slide">➡️ স্লাইড (ticker-মতো)</option>' +
      '<option value="fade">🔄 ফেইড</option>' +
      '<option value="ticker">📰 নিউজ টিকার</option>' +
      '<option value="bounce">⬆️ বাউন্স</option>' +
      '<option value="none">⏸️ স্থির</option></select></div>' +
      '<div class="field"><label>⚡ গতি (৫=ধীর, ১২০=দ্রুত)</label>' +
      '<input type="range" id="bn_speed" min="5" max="120" value="30" style="width:100%;" ' +
      'oninput="document.getElementById(\'bn_speed_v\').textContent=this.value">' +
      '<span id="bn_speed_v">30</span></div>' +
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
      '<div class="field"><label>ব্যাকগ্রাউন্ড রং (optional)</label><input type="color" id="bn_bg_color" value="#1e40af" style="width:60px;height:40px;"></div>' +
      '<div class="field"><label>লেখার রং (optional)</label><input type="color" id="bn_text_color" value="#ffffff" style="width:60px;height:40px;"></div>' +
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
    const bgc = document.getElementById('bn_bg_color');
    const txc = document.getElementById('bn_text_color');
    const html = await BannerRender.render({
      design_id: this._selDesign,
      content: {
        text_bn: (bn && bn.value) || d.default_bn,
        text_en: (en && en.value) || d.default_en,
        link: (lk && lk.value) || '',
        bg_color: (bgc && bgc.value) || '',
        text_color: (txc && txc.value) || '',
      },
    });
    const pv = document.getElementById('bnPreview');
    if (pv) pv.innerHTML = html;
  },
  async create() {
    const r = await ABC.api('/admin/banners', { method: 'POST', body: {
      type: document.getElementById('bn_type').value,
      title: v('bn_title'), design_id: this._selDesign,
      animation_type: document.getElementById('bn_anim').value,
      animation_speed: Number(document.getElementById('bn_speed').value) || 30,
      content: { text_bn: v('bn_text_bn'), text_en: v('bn_text_en'), link: v('bn_link'),
        bg_color: v('bn_bg_color'), text_color: v('bn_text_color') },
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
      '<div class="field"><label>🎬 অ্যানিমেশন</label><select id="bn_anim">' +
      '<option value="slide"' + (b.animation_type === 'slide' ? ' selected' : '') + '>➡️ স্লাইড (ticker-মতো)</option>' +
      '<option value="fade"' + (b.animation_type === 'fade' ? ' selected' : '') + '>🔄 ফেইড</option>' +
      '<option value="ticker"' + (b.animation_type === 'ticker' ? ' selected' : '') + '>📰 নিউজ টিকার</option>' +
      '<option value="bounce"' + (b.animation_type === 'bounce' ? ' selected' : '') + '>⬆️ বাউন্স</option>' +
      '<option value="none"' + (b.animation_type === 'none' ? ' selected' : '') + '>⏸️ স্থির</option></select></div>' +
      '<div class="field"><label>⚡ গতি (৫=ধীর, ১২০=দ্রুত)</label>' +
      '<input type="range" id="bn_speed" min="5" max="120" value="' + (b.animation_speed || 30) + '" style="width:100%;" ' +
      'oninput="document.getElementById(\'bn_speed_v\').textContent=this.value">' +
      '<span id="bn_speed_v">' + (b.animation_speed || 30) + '</span></div>' +
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
      animation_type: document.getElementById('bn_anim').value,
      animation_speed: Number(document.getElementById('bn_speed').value) || 30,
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
  if (!r.ok || !d.notices) { content.innerHTML = '<div style="color:var(--danger)">⚠️ লোড ব্যর্থ! রিফ্রেশ করুন</div>'; return; }
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
    '<div class="field"><label><input type="checkbox" id="wa_n_order_completed" ' + ((((s.whatsapp||{}).notify||{}).order_completed !== false) ? 'checked' : '') + '> ✅ অর্ডার সফল মেসেজ পাঠাবে</label></div>' +
    '<div class="field"><label><input type="checkbox" id="wa_n_order_failed" ' + ((((s.whatsapp||{}).notify||{}).order_failed !== false) ? 'checked' : '') + '> ❌ অর্ডার ব্যর্থ মেসেজ পাঠাবে</label></div>' +
    '<div class="field"><label><input type="checkbox" id="wa_n_order_cancelled" ' + ((((s.whatsapp||{}).notify||{}).order_cancelled !== false) ? 'checked' : '') + '> 🚫 অর্ডার বাতিল মেসেজ পাঠাবে</label></div>' +
    '<div class="field"><label><input type="checkbox" id="wa_n_recharge_approved" ' + ((((s.whatsapp||{}).notify||{}).recharge_approved !== false) ? 'checked' : '') + '> 💰 রিচার্জ সফল মেসেজ পাঠাবে</label></div>' +
    '<div class="field"><label><input type="checkbox" id="wa_n_recharge_rejected" ' + ((((s.whatsapp||{}).notify||{}).recharge_rejected !== false) ? 'checked' : '') + '> ⚠️ রিচার্জ বাতিল মেসেজ পাঠাবে</label></div>' +
    fld('WhatsApp বিজনেস নম্বর (ডিসপ্লে)', 'text', 'st_wa_num', ((s.whatsapp || {}).business_number) || '') +
    fld('Phone Number ID', 'text', 'st_wa_phone_id', ((s.whatsapp || {}).phone_number_id) || '') +
    '<div class="field"><label>Access Token (password)</label>' +
    '<input type="password" id="st_wa_token" value="" placeholder="নতুন token বসান (খালি রাখলে আগেরটা থাকবে)" autocomplete="new-password">' +
    '<div class="s" style="margin-top:4px;">' + (((s.whatsapp || {}).access_token_env) ? '✅ Token সেট আছে (ENV)' : ((s.whatsapp || {}).access_token_set ? '✅ Token সেট আছে' : '❌ Token সেট নেই')) + '</div></div>' +
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
    '<h3 style="margin:18px 0 8px;color:var(--gold);">💳 রিচার্জ রিসিভ নম্বর</h3>' +
    '<div class="s" style="margin-bottom:8px;">গ্রাহক এই নম্বরগুলোতে টাকা পাঠিয়ে রিচার্জ রিকোয়েস্ট করবে</div>' +
    fld('বিকাশ পেমেন্ট নম্বর', 'text', 'st_rn_bkash_pay', (((s.recharge_numbers || {}).bkash_payment) || '')) +
    fld('বিকাশ পার্সোনাল নম্বর', 'text', 'st_rn_bkash_per', (((s.recharge_numbers || {}).bkash_personal) || '')) +
    fld('নগদ নম্বর', 'text', 'st_rn_nagad', (((s.recharge_numbers || {}).nagad) || '')) +
    fld('রকেট নম্বর', 'text', 'st_rn_rocket', (((s.recharge_numbers || {}).rocket) || '')) +
    '<button class="btn" onclick="AdmSt.save()">সংরক্ষণ</button></div>' +
    '<div class="form-card" style="margin-top:14px;"><h2>💾 ফাইল স্টোরেজ</h2><div id="stgList"><div style="color:var(--muted)">লোড হচ্ছে…</div></div></div>';
  loadStorage();
};
async function loadStorage(){
  const r = await ABC.api('/admin/storage');
  const d = await r.json();
  const el = document.getElementById('stgList');
  if (!el) return;
  if (!r.ok || !d.files.length) { el.innerHTML = '<div style="color:var(--muted)">কোনো ফাইল নেই</div>'; return; }
  let total = d.files.reduce((s,f)=>s+f.size,0);
  el.innerHTML = '<div style="margin-bottom:8px;">মোট: ' + (total/1024/1024).toFixed(2) + ' MB (' + d.files.length + ' ফাইল)</div>' +
    d.files.map(f=>'<div class="list-row"><div><div class="t">'+esc(f.filename)+'</div><div class="s">'+esc(f.user_phone||'—')+' • '+(f.size_kb)+' KB</div></div><button class="mini-btn" onclick="delFile(\''+esc(f.filename)+'\')">🗑️</button></div>').join('');
}
async function delFile(fn){
  if (!confirm('ডিলিট করবেন?')) return;
  const r = await ABC.api('/admin/storage/' + encodeURIComponent(fn), {method:'DELETE'});
  if (r.ok) loadStorage(); else alert('ব্যর্থ');
}
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
    try {
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
      notify: {
        order_completed: document.getElementById('wa_n_order_completed').checked,
        order_failed: document.getElementById('wa_n_order_failed').checked,
        order_cancelled: document.getElementById('wa_n_order_cancelled').checked,
        recharge_approved: document.getElementById('wa_n_recharge_approved').checked,
        recharge_rejected: document.getElementById('wa_n_recharge_rejected').checked,
      },
    };
    const putBody = {
      welcome_bonus: { enabled: Number(v('st_wb')) > 0, amount: Number(v('st_wb')) || 0 },
      cashback: { enabled: Number(v('st_cb')) > 0, percent: Number(v('st_cb')) || 0 },
      file_upload: { max_mb: Number(v('st_mb')) || 5, allowed: ['pdf', 'jpg', 'jpeg', 'png'] },
      'bdris_apply.pdf_price': Number(v('st_bdris_pdf')) || 0,
      recharge_numbers: {
        bkash_payment: String(v('st_rn_bkash_pay') || '').trim(),
        bkash_personal: String(v('st_rn_bkash_per') || '').trim(),
        nagad: String(v('st_rn_nagad') || '').trim(),
        rocket: String(v('st_rn_rocket') || '').trim(),
      },
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
      const msg = rd.error === 'WRONG_PASSWORD' ? '❌ ভুল password — token পরিবর্তন হয়নি' : '❌ সংরক্ষণ ব্যর্থ: ' + (rd.error || ('HTTP ' + resp.status));
      alert(msg);
      return;
    }
    alert('সংরক্ষণ হয়েছে');
    } catch (e) {
      alert('❌ সংরক্ষণ ব্যর্থ: ' + (e.message || 'নেটওয়ার্ক সমস্যা'));
    }
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
  bg.innerHTML = '<div class="modal"><button class="modal-x" onclick="closeModal()" style="position:absolute;top:8px;right:12px;background:none;border:none;font-size:20px;cursor:pointer;color:#888;">✕</button><h3>' + esc(title) + '</h3>' + bodyHtml + '</div>';
  bg.onclick = (e) => { if (e.target === bg) closeModal(); };
  document.body.appendChild(bg);
  // Escape key closes modal
  bg._escHandler = (e) => { if (e.key === 'Escape') closeModal(); };
  document.addEventListener('keydown', bg._escHandler);
}
function closeModal() {
  const m = document.getElementById('admModal');
  if (m) {
    if (m._escHandler) document.removeEventListener('keydown', m._escHandler);
    m.remove();
  }
}
window.closeModal = closeModal;


/* ---------------- REPORTS (user spec 2026-10-16) ---------------- */
TABS.reports = async () => {
  // Server-side aggregates (was: client-side sum of capped 100-row pages = wrong totals)
  let sum = { revenue: 0, recharge: 0, byStatus: {}, users: 0 };
  try {
    const r = await ABC.api('/admin/reports/summary');
    if (r.ok) sum = await r.json();
  } catch (e) { /* show zeros with error note */ }
  const revenue = sum.revenue || 0;
  const walletTotal = sum.recharge || 0;
  const byStatus = sum.byStatus || {};

  let html = '<h3 style="color:var(--gold); margin-bottom:14px;">📊 রিপোর্ট</h3>' +
    '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(160px,1fr)); gap:12px; margin-bottom:18px;">' +
    '<div style="background:var(--card); padding:16px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">💰 মোট রেভিনিউ</div>' +
    '<div style="font-size:24px; font-weight:700; color:var(--gold);">৳' + bn(revenue) + '</div></div>' +
    '<div style="background:var(--card); padding:16px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">💳 মোট রিচার্জ</div>' +
    '<div style="font-size:24px; font-weight:700; color:#22c55e;">৳' + bn(walletTotal) + '</div></div>' +
    '<div style="background:var(--card); padding:16px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">👥 মোট ইউজার</div>' +
    '<div style="font-size:24px; font-weight:700;">' + bn(sum.users || 0) + '</div></div>' +
    '<div style="background:var(--card); padding:16px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">📦 মোট অর্ডার</div>' +
    '<div style="font-size:24px; font-weight:700;">' + bn(orders.length) + '</div></div></div>';

  html += '<h4 style="color:var(--gold); margin:14px 0 10px;">📦 Status অনুযায়ী অর্ডার</h4>' +
    '<div style="display:grid; gap:8px;">';
  Object.entries(byStatus).forEach(([s, c]) => {
    html += '<div style="display:flex; justify-content:space-between; padding:10px 14px; background:var(--card); border-radius:8px;">' +
      '<span><span class="badge st-' + s + '">' + (STBN[s] || s) + '</span></span>' +
      '<b>' + bn(c) + 'টি</b></div>';
  });
  html += '</div>';
  content.innerHTML = html;
};

/* ---------------- FILE STORAGE TAB (user spec 2026-10-16) ---------------- */
/* ---------------- MONITOR (user spec 2026-10-16) ---------------- */
TABS.monitor = async () => {
  const r = await ABC.api('/admin/monitor');
  const d = await r.json();
  if (!r.ok) { content.innerHTML = '<div style="color:var(--danger)">⚠️ লোড ব্যর্থ!</div>'; return; }

  let html = '<h3 style="color:var(--gold); margin-bottom:14px;">🖥️ মনিটর</h3>' +
    '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:18px;">' +
    '<div style="background:var(--card); padding:14px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">🗄️ ডাটাবেজ</div>' +
    '<div style="font-size:20px; font-weight:700; color:' + (d.db === 'up' ? '#22c55e' : '#ef4444') + ';">' +
    (d.db === 'up' ? '✅ চালু' : '❌ বন্ধ') + '</div></div>' +
    '<div style="background:var(--card); padding:14px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">📦 অর্ডার (২৪ঘ)</div>' +
    '<div style="font-size:20px; font-weight:700;">' + bn(d.last24h.orders) + '</div></div>' +
    '<div style="background:var(--card); padding:14px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">👥 ইউজার (২৪ঘ)</div>' +
    '<div style="font-size:20px; font-weight:700;">' + bn(d.last24h.users) + '</div></div>' +
    '<div style="background:var(--card); padding:14px; border-radius:12px; text-align:center;">' +
    '<div style="font-size:12px; color:var(--dim);">💳 লেনদেন (২৪ঘ)</div>' +
    '<div style="font-size:20px; font-weight:700;">' + bn(d.last24h.transactions) + '</div></div></div>';

  html += '<h4 style="color:var(--gold); margin:14px 0 10px;">📜 সাম্প্রতিক কার্যক্রম</h4>';
  if (!(d.recent_activity || []).length) {
    html += '<div style="color:var(--muted)">কোনো কার্যক্রম নেই</div>';
  } else {
    html += '<div style="display:grid; gap:6px;">';
    d.recent_activity.forEach(a => {
      html += '<div style="display:flex; justify-content:space-between; padding:8px 12px; background:var(--card); border-radius:8px; font-size:13px;">' +
        '<span>' + esc(a.action) + '</span>' +
        '<small style="color:var(--dim);">' + new Date(a.created_at).toLocaleString('bn-BD') + '</small></div>';
    });
    html += '</div>';
  }
  content.innerHTML = html;
};

/* ---------------- FILE STORAGE (defined below) ---------------- */
TABS.storage = async () => {
  const r = await ABC.api('/admin/storage');
  const d = await r.json();
  const files = d.files || [];
  const total = files.reduce((s, f) => s + (f.size || 0), 0);
  let html = '<div style="display:flex; gap:8px; margin-bottom:12px; align-items:center; flex-wrap:wrap;">' +
    '<b style="color:var(--gold);">💾 ফাইল স্টোরেজ</b>' +
    '<span style="color:var(--dim); font-size:12px;">মোট: ' + (total / 1024 / 1024).toFixed(2) + ' MB (' + bn(files.length) + ' ফাইল)</span>' +
    (files.length ? '<button class="mini-btn danger" style="margin-left:auto;" onclick="AdmStorage.delAll()">🗑️ সব ডিলিট</button>' : '') +
    '</div>';
  if (!files.length) {
    html += '<div style="color:var(--muted)">কোনো ফাইল নেই</div>';
  } else {
    html += '<div style="display:grid; gap:8px;">';
    files.forEach(f => {
      html += '<div style="display:flex; align-items:center; gap:12px; padding:10px 12px; background:var(--card); border-radius:10px;">' +
        '<span style="font-size:24px;">📄</span>' +
        '<div style="flex:1;"><b style="font-size:13px;">' + esc(f.filename) + '</b><br>' +
        '<small style="color:var(--dim);">👤 ' + esc(f.user_phone || f.user_name || '—') + ' • ' + (f.size_kb || Math.round((f.size || 0) / 1024)) + ' KB</small></div>' +
        '<button class="mini-btn" onclick="AdmStorage.download(\'' + esc(f.filename) + '\')">⬇️ ডাউনলোড</button>' +
        '<button class="mini-btn danger" onclick="AdmStorage.del(\'' + esc(f.filename) + '\')">🗑️</button></div>';
    });
    html += '</div>';
  }
  content.innerHTML = html;
};
window.AdmStorage = {
  async download(fn) {
    try {
      const r = await fetch('/api/admin/storage/' + encodeURIComponent(fn) + '/download', {
        headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('abc_access_token') },
      });
      if (!r.ok) { alert('ডাউনলোড ব্যর্থ'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fn;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } catch (e) { alert('ডাউনলোড ব্যর্থ'); }
  },
  async del(fn) {
    if (!confirm('ডিলিট করবেন?\n' + fn)) return;
    const r = await ABC.api('/admin/storage/' + encodeURIComponent(fn), { method: 'DELETE' });
    if (r.ok) show('storage'); else alert('ব্যর্থ');
  },
  async delAll() {
    if (!confirm('⚠️ সব ফাইল ডিলিট করবেন?')) return;
    if (!confirm('🔴 শেষ কনফার্মেশন!')) return;
    const r = await ABC.api('/admin/storage', { method: 'DELETE' });
    if (r.ok) { alert('✅ সব ডিলিট হয়েছে'); show('storage'); }
    else alert('ব্যর্থ');
  },
};
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => init().catch((e) => {
    const c = document.getElementById('content');
    if (c) c.innerHTML = '<div class="err">লোড ব্যর্থ: ' + esc(String((e && e.message) || e)) + '</div>';
  }));
} else {
  init().catch((e) => {
    const c = document.getElementById('content');
    if (c) c.innerHTML = '<div class="err">লোড ব্যর্থ: ' + esc(String((e && e.message) || e)) + '</div>';
  });
}
})();
