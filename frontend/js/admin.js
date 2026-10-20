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
// JSON value for use INSIDE a double-quoted HTML attribute (e.g. onclick="fn(...)").
// Raw JSON.stringify output contains " characters that terminate the attribute
// early, leaving a truncated handler like `AdmTx.approve(` -> SyntaxError:
// Unexpected end of input. Encoding the quotes as &quot; keeps the attribute
// intact; the browser decodes them back before compiling the handler.
function jqAttr(v){const s=JSON.stringify(v);return (s===undefined?'""':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');}
function bn(n){return Number(n||0).toLocaleString('bn-BD');}

function getAuthToken() {
  try {
    if (typeof ABC !== 'undefined' && ABC.getAccessToken) {
      const t = ABC.getAccessToken();
      if (t) return t;
    }
    if (typeof localStorage !== 'undefined') {
      const t = localStorage.getItem('abc_access_token');
      if (t) return t;
    }
    if (typeof sessionStorage !== 'undefined') {
      const t = sessionStorage.getItem('abc_access_token');
      if (t) return t;
    }
  } catch (_) {}
  return '';
}

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

window.AdmMobile = {
  toggleSidebar(force) {
    const sb = document.getElementById('admSidebar');
    const bdp = document.getElementById('admBackdrop');
    if (!sb) return;
    const isOpen = typeof force === 'boolean' ? force : !sb.classList.contains('open');
    if (isOpen) {
      sb.classList.add('open');
      if (bdp) bdp.classList.add('open');
      document.body.style.overflow = 'hidden';
    } else {
      sb.classList.remove('open');
      if (bdp) bdp.classList.remove('open');
      document.body.style.overflow = '';
    }
  }
};

let _showGen = 0;
async function show(tab) {
  const gen = ++_showGen;
  const activeTabKey = (tab === 'cats') ? 'services' : tab;
  // Keep sidebar navigation in sync
  document.querySelectorAll('#tabs .side-link').forEach(x => {
    if (x.dataset.t === activeTabKey) x.classList.add('on');
    else x.classList.remove('on');
  });
  // Close mobile sidebar menu when navigating
  if (window.AdmMobile) window.AdmMobile.toggleSidebar(false);
  if (!content) return;
  content.innerHTML = '<div style="color:var(--muted)">লোড হচ্ছে…</div>';
  try {
    if (tab === 'cats') {
      TABS._svcView = 'cats';
      await TABS.services();
    } else {
      if (tab === 'services' && !TABS._svcView) TABS._svcView = 'services';
      await TABS[tab]();
    }
    if (gen !== _showGen) return; // Stale: another show() started, don't overwrite
  } catch (e) {
    if (gen !== _showGen) return;
    const msg = String((e && e.message) || e);
    content.innerHTML = '<div class="err">লোড ব্যর্থ: ' + esc(msg) + '</div>';
  }
}
window.show = show;

/* ============ Phase 3: Premium Voice & Realtime Sound Notifications ============ */
window.admToast = (title, message, type = 'info', badge = 'সফল') => {
  if (window.VoiceAlert && VoiceAlert.showToast) {
    VoiceAlert.showToast({
      title,
      message,
      type: type === 'error' ? 'order' : type,
      badge,
      icon: type === 'error' ? '⚠️' : (type === 'recharge' ? '💰' : '✅'),
      duration: 4000
    });
  } else if (typeof alert !== 'undefined') {
    alert(title + ': ' + message);
  }
};

const VoiceAlert = {
  enabled: typeof localStorage !== 'undefined' && localStorage.getItem('abc_voice') !== 'off',
  _last: { recharge: 0, order: 0, sms: 0 },
  _voices: [],
  _audioCtx: null,
  _unlocked: false,

  _getAudioCtx() {
    try {
      if (!this._audioCtx && typeof window !== 'undefined') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) this._audioCtx = new AudioCtx();
      }
      if (this._audioCtx && this._audioCtx.state === 'suspended') {
        this._audioCtx.resume().catch(() => {});
      }
    } catch (e) {}
    return this._audioCtx;
  },

  unlock() {
    try {
      const ctx = this._getAudioCtx();
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
      if (ctx) {
        // Play 1-sample silent buffer to reliably unlock web audio in all browsers
        const buf = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
      }
      this._unlocked = true;
    } catch (e) {}
  },

  playChime(type = 'order') {
    if (!this.enabled) return;
    try {
      const ctx = this._getAudioCtx();
      if (ctx) {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }
        const now = ctx.currentTime;
        const masterGain = ctx.createGain();
        masterGain.gain.setValueAtTime(0.9, now);
        masterGain.connect(ctx.destination);

        if (type === 'order') {
          // Loud, crisp 4-chord fanfare (C5, E5, G5, C6) with rich triangle harmonics
          [523.25, 659.25, 783.99, 1046.50].forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + idx * 0.07);
            gain.gain.setValueAtTime(0.42, now + idx * 0.07);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.07 + 0.65);
            osc.connect(gain);
            gain.connect(masterGain);
            osc.start(now + idx * 0.07);
            osc.stop(now + idx * 0.07 + 0.7);
          });
        } else if (type === 'recharge') {
          // Bright energetic cash fanfare (G5, B5, D6)
          [783.99, 987.77, 1174.66].forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + idx * 0.08);
            gain.gain.setValueAtTime(0.45, now + idx * 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.7);
            osc.connect(gain);
            gain.connect(masterGain);
            osc.start(now + idx * 0.08);
            osc.stop(now + idx * 0.08 + 0.75);
          });
        } else {
          // Double alert ping
          [880.00, 1318.51].forEach((freq, idx) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = 'triangle';
            osc.frequency.setValueAtTime(freq, now + idx * 0.09);
            gain.gain.setValueAtTime(0.4, now + idx * 0.09);
            gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + 0.55);
            osc.connect(gain);
            gain.connect(masterGain);
            osc.start(now + idx * 0.09);
            osc.stop(now + idx * 0.09 + 0.6);
          });
        }
      }
    } catch (e) {}

    // ALWAYS play the human Bengali voice MP3 alert loudly
    const soundFile = type === 'order' ? 'new-order.mp3' : (type === 'recharge' ? 'new-recharge.mp3' : 'new-message.mp3');
    setTimeout(() => {
      this.playSound(soundFile);
    }, 280);
  },

  playSound(file) {
    if (!this.enabled) return;
    try {
      this.unlock();
      const a = new Audio('/audio/' + file);
      a.volume = 1.0;
      const p = a.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          // If browser blocked autoplay, schedule retry on very next user touch/click
          const retryOnGesture = () => {
            try {
              const a2 = new Audio('/audio/' + file);
              a2.volume = 1.0;
              a2.play().catch(() => {});
            } catch (_) {}
            if (typeof document !== 'undefined') {
              document.removeEventListener('pointerdown', retryOnGesture);
              document.removeEventListener('keydown', retryOnGesture);
              document.removeEventListener('click', retryOnGesture);
              document.removeEventListener('touchstart', retryOnGesture);
            }
          };
          if (typeof document !== 'undefined') {
            document.addEventListener('pointerdown', retryOnGesture, { once: true });
            document.addEventListener('keydown', retryOnGesture, { once: true });
            document.addEventListener('click', retryOnGesture, { once: true });
            document.addEventListener('touchstart', retryOnGesture, { once: true });
          }
        });
      }
    } catch (e) {}
  },

  playAudio(file) {
    this.playSound(file);
  },

  speak(text) {
    if (!this.enabled || typeof window === 'undefined' || !window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.volume = 1.0;
      u.rate = 1.0;
      u.pitch = 1.0;
      const voices = (typeof speechSynthesis.getVoices === 'function') ? speechSynthesis.getVoices() : [];
      const bnVoice = voices.find(v => v.lang && (v.lang.startsWith('bn') || v.lang.includes('Bengali') || v.lang.includes('Bangla')));
      if (bnVoice) {
        u.voice = bnVoice;
        u.lang = bnVoice.lang;
      } else {
        u.lang = 'bn-BD';
      }
      speechSynthesis.speak(u);
    } catch (e) {}
  },

  showToast(opts) {
    if (typeof document === 'undefined') return;
    try {
      const type = opts.type || 'order';
      const title = opts.title || 'নোটিফিকেশন';
      const message = opts.message || '';
      const badge = opts.badge || 'নতুন';
      const icon = opts.icon || '🔔';
      const actionText = opts.actionText || '';
      const onAction = opts.onAction || null;
      const duration = typeof opts.duration === 'number' ? opts.duration : 9000;

      let container = document.getElementById('admToastContainer');
      if (!container) {
        container = document.createElement('div');
        container.id = 'admToastContainer';
        container.className = 'adm-toast-container';
        document.body.appendChild(container);
      }

      const toast = document.createElement('div');
      toast.className = 'adm-toast toast-' + type;

      const actId = 'toastAct_' + Math.random().toString(36).slice(2, 8);
      const closeId = 'toastClose_' + Math.random().toString(36).slice(2, 8);

      toast.innerHTML = 
        '<div class="adm-toast-icon">' + icon + '</div>' +
        '<div class="adm-toast-body">' +
          '<div class="adm-toast-title">' +
            '<span>' + esc(title) + '</span>' +
            '<span class="adm-toast-badge">' + esc(badge) + '</span>' +
          '</div>' +
          '<div class="adm-toast-msg">' + message + '</div>' +
          '<div class="adm-toast-time">এইমাত্র</div>' +
        '</div>' +
        '<div class="adm-toast-actions">' +
          (actionText ? '<button class="adm-toast-btn-view" id="' + actId + '">' + esc(actionText) + '</button>' : '') +
          '<button class="adm-toast-btn-close" id="' + closeId + '" title="বন্ধ করুন">✕</button>' +
        '</div>';

      container.prepend(toast);

      const closeToast = () => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(-12px) scale(0.94)';
        setTimeout(() => toast.remove(), 260);
      };

      const closeBtn = document.getElementById(closeId);
      if (closeBtn) closeBtn.onclick = closeToast;

      if (actionText && onAction) {
        const actBtn = document.getElementById(actId);
        if (actBtn) {
          actBtn.onclick = () => {
            closeToast();
            onAction();
          };
        }
      }

      if (duration > 0) {
        setTimeout(closeToast, duration);
      }
    } catch (e) {}
  },

  init() {
    try {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        const load = () => { this._voices = speechSynthesis.getVoices(); };
        load();
        if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = load;
      }
      const unlockHandler = () => {
        this.unlock();
        if (typeof document !== 'undefined') {
          document.removeEventListener('pointerdown', unlockHandler);
          document.removeEventListener('keydown', unlockHandler);
          document.removeEventListener('click', unlockHandler);
          document.removeEventListener('touchstart', unlockHandler);
        }
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', unlockHandler, { once: true });
        document.addEventListener('keydown', unlockHandler, { once: true });
        document.addEventListener('click', unlockHandler, { once: true });
        document.addEventListener('touchstart', unlockHandler, { once: true });
      }
    } catch (e) {}

    this.updateTopbarBtn();

    if (typeof setInterval !== 'undefined') {
      setInterval(() => this.check(), 12000);
      setTimeout(() => this.check(), 3000);
    }
  },

  updateTopbarBtn() {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('admSoundToggleBtn');
    if (btn) {
      if (this.enabled) {
        btn.innerHTML = '🔊 সাউন্ড: চালু';
        btn.style.color = '#16a34a';
        btn.style.borderColor = '#bbf7d0';
      } else {
        btn.innerHTML = '🔇 সাউন্ড: বন্ধ';
        btn.style.color = '#dc2626';
        btn.style.borderColor = '#fecaca';
      }
    }
  },

  toggleSound() {
    this.enabled = !this.enabled;
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('abc_voice', this.enabled ? 'on' : 'off');
    }
    this.updateTopbarBtn();
    if (this.enabled) {
      this.playChime('order');
      this.speak('ভয়েস ও সাউন্ড নোটিফিকেশন চালু হয়েছে');
      this.showToast({
        type: 'order',
        icon: '🔊',
        title: 'সাউন্ড চালু',
        message: 'অর্ডার ও রিচার্জের প্রিমিয়াম সাউন্ড নোটিফিকেশন চালু করা হয়েছে।',
        badge: 'অন',
        duration: 4000
      });
    } else {
      this.showToast({
        type: 'chat',
        icon: '🔇',
        title: 'সাউন্ড বন্ধ',
        message: 'সাউন্ড নোটিফিকেশন মিউট করা হয়েছে।',
        badge: 'অফ',
        duration: 3500
      });
    }
    return this.enabled;
  },

  toggle() {
    return this.toggleSound();
  },

  testAlert() {
    this.unlock();
    this.playChime('order');
    setTimeout(() => this.speak('সাউন্ড নোটিফিকেশন সিস্টেম কার্যকর আছে'), 450);
    this.showToast({
      type: 'order',
      icon: '🛍️',
      title: 'টেস্ট নোটিফিকেশন',
      message: 'গ্রাহক: <b>মোঃ আরিফুল ইসলাম</b> • সার্ভিস: <b>NID কার্ড ডাউনলোড</b> (৳৫০)',
      badge: 'টেস্ট সফল',
      actionText: 'অর্ডার হাব দেখুন ➤',
      onAction: () => { show('orders'); },
      duration: 10000
    });
  },

  async check() {
    if (typeof me === 'undefined' || !me || me.role !== 'admin') return;
    try {
      const r = await ABC.api('/admin/stats');
      if (!r.ok) return;
      const s = await r.json();
      const pr = Number(s.pending_recharge || 0);
      const no = Number(s.orders_new || 0);

      if (this._last.order && no > this._last.order) {
        this.playChime('order');
        this.speak('নতুন অর্ডার এসেছে');
        try {
          const or = await ABC.api('/admin/orders?status=new&limit=1');
          if (or.ok) {
            const od = await or.json();
            const latest = (od.list || od.orders || [])[0];
            if (latest) {
              this.showToast({
                type: 'order',
                icon: '🛍️',
                title: 'নতুন অর্ডার এসেছে!',
                message: 'গ্রাহক: <b>' + esc(latest.user_name || 'গ্রাহক') + '</b><br>সার্ভিস: <b>' + esc(latest.service_name_bn || latest.service_name || 'সেবা') + '</b> • ৳' + bn(latest.price || 0),
                badge: 'নতুন',
                actionText: 'অর্ডার খুলুন ➤',
                onAction: () => {
                  show('orders');
                  setTimeout(() => AdmOrders.view(latest.id), 250);
                }
              });
            }
          }
        } catch (e) {
          this.showToast({
            type: 'order',
            icon: '🛍️',
            title: 'নতুন অর্ডার এসেছে!',
            message: no + 'টি নতুন অর্ডার অপেক্ষমাণ আছে।',
            actionText: 'অর্ডার দেখুন ➤',
            onAction: () => show('orders')
          });
        }
      }

      if (this._last.recharge && pr > this._last.recharge) {
        this.playChime('recharge');
        this.speak('নতুন রিচার্জ রিকোয়েস্ট এসেছে');
        try {
          const rr = await ABC.api('/admin/recharge/pending');
          if (rr.ok) {
            const rd = await rr.json();
            const latest = (rd.list || rd)[0];
            if (latest) {
              this.showToast({
                type: 'recharge',
                icon: '💰',
                title: 'নতুন রিচার্জ রিকোয়েস্ট!',
                message: 'গ্রাহক: <b>' + esc(latest.user_name || 'গ্রাহক') + '</b><br>পরিমাণ: <b>৳' + bn(latest.amount || 0) + '</b> (' + esc(latest.method || 'পেমেন্ট') + ')',
                badge: 'অপেক্ষমাণ',
                actionText: 'অনুমোদন করুন ➤',
                onAction: () => show('recharge')
              });
            }
          }
        } catch (e) {
          this.showToast({
            type: 'recharge',
            icon: '💰',
            title: 'নতুন রিচার্জ রিকোয়েস্ট!',
            message: pr + 'টি রিচার্জ রিকোয়েস্ট অপেক্ষমাণ আছে।',
            actionText: 'রিচার্জ খুলুন ➤',
            onAction: () => show('recharge')
          });
        }
      }

      this._last.recharge = pr;
      this._last.order = no;

      try {
        const sr = await ABC.api('/admin/stats/sms');
        if (sr.ok) {
          const sd = await sr.json();
          const us = Number(sd.unmatched_sms || 0);
          if (this._last.sms && us > this._last.sms) {
            this.playChime('message');
            this.speak('নতুন পেমেন্ট SMS এসেছে, ম্যাচ হয়নি');
            this.showToast({
              type: 'chat',
              icon: '📩',
              title: 'আনম্যাচড পেমেন্ট SMS!',
              message: 'নতুন এসএমএস এসেছে কিন্তু কোনো রিচার্জের সাথে মেলেনি।',
              badge: 'SMS',
              actionText: 'SMS গেটওয়ে ➤',
              onAction: () => show('sms')
            });
          }
          this._last.sms = us;
        }
      } catch (e) {}
    } catch (e) {}
  }
};
window.VoiceAlert = VoiceAlert;

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
window.PushNotify = PushNotify;

const TABS = {};
window.TABS = TABS;

/* ---------------- STATS ---------------- */
TABS.stats = async () => {
  const r = await ABC.api('/admin/stats');
  if (!r.ok) {
    let why = 'পরিসংখ্যান লোড ব্যর্থ';
    try {
      const d = await r.json();
      if (r.status === 429 || d.error === 'RATE_LIMITED') why += ' — অনেক রিকোয়েস্ট হয়েছে, একটু পরে আবার চেষ্টা করুন';
      else if (d.error) why += ': ' + d.error;
    } catch (e) { why += ' (কোড ' + r.status + ')'; }
    throw new Error(why);
  }
  const s = (await r.json()) || {};
  const num = (v) => (v == null || isNaN(Number(v)) ? 0 : Number(v));

  const pendingRecharge = num(s.pending_recharge);
  const ordersNew = num(s.orders_new);
  const ordersActive = num(s.orders_active);
  const ordersCompleted = num(s.orders_completed);
  const ordersTotal = num(s.orders_total);
  const usersTotal = num(s.users);
  const adminsTotal = num(s.admins);
  const revenueToday = num(s.revenue_today);
  const ordersToday = num(s.orders_today);
  const usersToday = num(s.users_today);
  const servicesActive = num(s.services_active);

  // Urgent action alert banner
  let alertBanner = '';
  if (pendingRecharge > 0 || ordersNew > 0) {
    alertBanner = '<div class="adm-alert-card urgent">' +
      '<div class="adm-alert-icon">⚡</div>' +
      '<div class="adm-alert-body">' +
        '<div class="adm-alert-title">অ্যাকশন প্রয়োজন — নতুন রিকোয়েস্ট অপেক্ষমান</div>' +
        '<div class="adm-alert-desc">গ্রাহকদের দ্রুত সেবা নিশ্চিত করতে অপেক্ষমান অর্ডার ও রিচার্জগুলো অনুমোদন করুন।</div>' +
      '</div>' +
      '<div class="adm-alert-actions">' +
        (pendingRecharge > 0
          ? '<button type="button" class="adm-alert-btn recharge" onclick="if(window.show)show(\'recharge\');else document.querySelector(\'[data-t=recharge]\')?.click()">💳 রিচার্জ অনুমোদন বাকি (' + bn(pendingRecharge) + ')</button>'
          : '') +
        (ordersNew > 0
          ? '<button type="button" class="adm-alert-btn orders" onclick="if(window.TABS)TABS._f=\'new\';if(window.show)show(\'orders\');else document.querySelector(\'[data-t=orders]\')?.click()">📦 নতুন অর্ডার ও আবেদন (' + bn(ordersNew) + ')</button>'
          : '') +
      '</div>' +
    '</div>';
  } else {
    alertBanner = '<div class="adm-alert-card success">' +
      '<div class="adm-alert-icon">✨</div>' +
      '<div class="adm-alert-body">' +
        '<div class="adm-alert-title" style="color:#065f46;">সবকিছু আপ-টু-ডেট আছে!</div>' +
        '<div class="adm-alert-desc" style="color:#047857;">এই মুহূর্তে কোনো পেন্ডিং রিচার্জ বা নতুন অর্ডার জমে নেই। সিস্টেম সম্পূর্ণ স্মুথলি চলছে।</div>' +
      '</div>' +
      '<div class="adm-alert-actions">' +
        '<button type="button" class="adm-alert-btn neutral" onclick="if(window.show)show(\'orders\');else document.querySelector(\'[data-t=orders]\')?.click()">📦 অর্ডার সেন্টার</button>' +
        '<button type="button" class="adm-alert-btn neutral" onclick="if(window.show)show(\'users\');else document.querySelector(\'[data-t=users]\')?.click()">👥 ইউজার তালিকা</button>' +
      '</div>' +
    '</div>';
  }

  // Header Bar
  const headerHtml = '<div class="adm-dashboard-head">' +
    '<div>' +
      '<h1 class="adm-dashboard-title">এডমিন কন্ট্রোল সেন্টার</h1>' +
      '<div class="adm-dashboard-sub">রিয়েলটাইম প্ল্যাটফর্ম ওভারভিউ ও দ্রুত অ্যাকশন হাব</div>' +
    '</div>' +
    '<div class="adm-head-badges">' +
      '<span class="adm-live-badge"><span class="adm-live-dot"></span> সিস্টেম অনলাইন</span>' +
      '<button type="button" class="adm-refresh-btn" onclick="if(window.show)show(\'stats\');else location.reload()" title="ডাটা রিফ্রেশ করুন">🔄 রিফ্রেশ</button>' +
    '</div>' +
  '</div>';

  // 8-Card Stat Grid (Preserves .stat-grid, .stat, .n, .l for complete test compatibility)
  const statGridHtml = '<div class="stat-grid">' +
    statCard('৳' + bn(revenueToday), 'আজকের আয়', '💰', 'recharge', 'text-emerald', revenueToday > 0 ? 'আজকের অনুমোদিত রিচার্জ' : 'আজকের মোট আয়') +
    statCard(bn(ordersNew), 'নতুন অর্ডার', '🆕', 'orders', 'text-amber', ordersNew > 0 ? 'জরুরি প্রসেসিং প্রয়োজন' : 'সব প্রসেসড', 'new') +
    statCard(bn(ordersActive), 'চলমান প্রসেসিং', '⏳', 'orders', 'text-blue', 'প্রসেসিং বা যাচাইধীন', 'processing') +
    statCard(bn(ordersCompleted), 'সম্পন্ন অর্ডার', '✅', 'orders', 'text-teal', 'সফলভাবে তৈরি ও প্রেরিত', 'completed') +
    statCard(bn(ordersTotal), 'মোট অর্ডার', '📦', 'orders', 'text-indigo', ordersToday > 0 ? 'আজকে ' + bn(ordersToday) + ' টি অর্ডার' : 'সর্বমোট অর্ডার') +
    statCard(bn(pendingRecharge), 'পেন্ডিং রিচার্জ', '💳', 'recharge', 'text-rose', pendingRecharge > 0 ? 'অনুমোদনের অপেক্ষায়' : 'সব অনুমোদিত') +
    statCard(bn(usersTotal), 'মোট গ্রাহক', '👥', 'users', 'text-violet', (usersToday > 0 ? 'আজকে +' + bn(usersToday) + ' জন নতুন' : (adminsTotal > 0 ? bn(adminsTotal) + ' জন এডমিন' : 'সক্রিয় গ্রাহক'))) +
    statCard(bn(servicesActive), 'অ্যাক্টিভ ডিজিটাল সেবা', '⚡', 'services', 'text-cyan', 'সেবা ও ক্যাটাগরি কনফিগার') +
  '</div>';

  // Quick Launch Hub
  const launchpadHtml = '<div class="adm-launchpad-card">' +
    '<div class="adm-card-head">' +
      '<div>' +
        '<div class="adm-card-title">🚀 দ্রুত অপারেশন লঞ্চপ্যাড</div>' +
        '<div class="adm-card-desc">সচরাচর ব্যবহৃত অ্যাডমিন মডিউলসমূহে তাৎক্ষণিক প্রবেশ করুন</div>' +
      '</div>' +
    '</div>' +
    '<div class="adm-launchpad-grid">' +
      launchItem('📦', 'অর্ডার ও প্রসেসিং', 'সকল অটো ইঞ্জিন ও ম্যানুয়াল অর্ডার', 'orders') +
      launchItem('💳', 'রিচার্জ ও ব্যালেন্স', 'অপেক্ষমান ব্যালেন্স রিচার্জ ও হিস্টোরি', 'recharge') +
      launchItem('👥', 'গ্রাহক ব্যবস্থাপনা', 'ইউজার তথ্য, ব্যালেন্স অ্যাড ও যাচাই', 'users') +
      launchItem('⚙️', 'সেবা ও ক্যাটাগরি', 'ফি, নির্দেশনা ও ম্যানুয়াল ফর্ম সাজান', 'services') +
      launchItem('📢', 'নোটিশ ও ঘোষণা', 'ব্যবহারকারীদের নোটিশ ও অ্যালার্ট পাঠান', 'notices') +
      launchItem('🎨', 'ব্যানার ও অফার', 'হোমপেজের ব্যানার ও স্পেশাল নোটিফিকেশন', 'banners') +
    '</div>' +
  '</div>';

  // PDF Report Center
  const reportCenterHtml = '<div class="adm-report-card">' +
    '<div class="adm-card-head">' +
      '<div>' +
        '<div class="adm-card-title">📊 অফিশিয়াল PDF রিপোর্ট সেন্টার</div>' +
        '<div class="adm-card-desc">নির্দিষ্ট সময়সীমার লেনদেন ও অর্ডারের প্রিন্ট উপযোগী স্টেটমেন্ট ডাউনলোড করুন</div>' +
      '</div>' +
    '</div>' +
    '<div class="adm-report-body">' +
      '<div class="adm-preset-row">' +
        '<span style="font-size:12px;font-weight:600;color:var(--text-muted);">সময়সীমা প্রিসেট:</span>' +
        '<button type="button" class="adm-chip-btn" onclick="AdmReports.setPreset(\'today\')">📅 আজকের</button>' +
        '<button type="button" class="adm-chip-btn" onclick="AdmReports.setPreset(\'7d\')">🗓️ গত ৭ দিন</button>' +
        '<button type="button" class="adm-chip-btn" onclick="AdmReports.setPreset(\'month\')">📊 চলতি মাস</button>' +
        '<button type="button" class="adm-chip-btn" onclick="AdmReports.setPreset(\'all\')">🌐 সব সময়</button>' +
      '</div>' +
      '<div class="adm-report-form-row">' +
        '<div class="field" style="margin:0;flex:1;min-width:140px;">' +
          '<label style="font-size:12px;font-weight:600;">শুরুর তারিখ (From)</label>' +
          '<input type="date" id="rp_from" class="adm-date-input">' +
        '</div>' +
        '<div class="field" style="margin:0;flex:1;min-width:140px;">' +
          '<label style="font-size:12px;font-weight:600;">শেষের তারিখ (To)</label>' +
          '<input type="date" id="rp_to" class="adm-date-input">' +
        '</div>' +
        '<div class="adm-report-btns">' +
          '<button type="button" class="btn-dl-report orders" onclick="AdmReports.dl(\'orders\')">' +
            '<span>📥</span> <span>অর্ডার রিপোর্ট (PDF)</span>' +
          '</button>' +
          '<button type="button" class="btn-dl-report tx" onclick="AdmReports.dl(\'transactions\')">' +
            '<span>📥</span> <span>লেনদেন স্টেটমেন্ট (PDF)</span>' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';

  content.innerHTML = '<div class="adm-dashboard-wrap">' +
    headerHtml +
    alertBanner +
    statGridHtml +
    launchpadHtml +
    reportCenterHtml +
  '</div>';

  function statCard(n, l, icon, tabTarget, colorClass, subtitle, filterKey) {
    const clickAction = tabTarget ? 'onclick="if(window.TABS&&' + (filterKey ? 'true' : 'false') + ')TABS._f=\'' + (filterKey || '') + '\';if(window.show)show(\'' + tabTarget + '\');"' : '';
    return '<div class="stat clickable ' + (colorClass || '') + '" ' + clickAction + ' title="ক্লিক করে ' + esc(l) + ' দেখুন">' +
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;">' +
        '<div class="l">' + esc(l) + '</div>' +
        '<span style="font-size:20px;line-height:1;">' + (icon || '📊') + '</span>' +
      '</div>' +
      '<div class="n">' + n + '</div>' +
      (subtitle ? '<div class="adm-stat-sub">' + esc(subtitle) + '</div>' : '') +
    '</div>';
  }

  function launchItem(icon, title, desc, tab) {
    return '<div class="adm-launch-item" onclick="if(window.show)show(\'' + tab + '\')">' +
      '<div class="adm-launch-icon">' + icon + '</div>' +
      '<div class="adm-launch-text">' +
        '<div class="adm-launch-title">' + esc(title) + '</div>' +
        '<div class="adm-launch-desc">' + esc(desc) + '</div>' +
      '</div>' +
      '<span class="adm-launch-arrow">→</span>' +
    '</div>';
  }
};

window.AdmReports = {
  dl(kind) {
    const fEl = document.getElementById('rp_from');
    const tEl = document.getElementById('rp_to');
    const f = (fEl && fEl.value) || '';
    const t = (tEl && tEl.value) || '';
    const q = (f ? 'from=' + f : '') + (t ? '&to=' + t : '');
    const token = getAuthToken();
    fetch('/api/admin/reports/' + kind + (q ? '?' + q : ''), {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then(async (r) => {
      if (!r.ok) { alert('রিপোর্ট ডাউনলোড ব্যর্থ হয়েছে'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = kind + '-report.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }).catch(() => alert('রিপোর্ট তৈরি ব্যর্থ হয়েছে'));
  },
  setPreset(preset) {
    const fromEl = document.getElementById('rp_from');
    const toEl = document.getElementById('rp_to');
    if (!fromEl || !toEl) return;
    const now = new Date();
    const fmt = (d) => {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    };
    toEl.value = fmt(now);
    if (preset === 'today') {
      fromEl.value = fmt(now);
    } else if (preset === '7d') {
      const d = new Date(now.getTime() - 7 * 86400000);
      fromEl.value = fmt(d);
    } else if (preset === 'month') {
      const d = new Date(now.getFullYear(), now.getMonth(), 1);
      fromEl.value = fmt(d);
    } else if (preset === 'all') {
      fromEl.value = '';
      toEl.value = '';
    }
  }
};

/* ---------------- USERS (Fintech User Management Hub) ---------------- */
TABS.users = async () => {
  TABS._upage = 1;
  const _q = TABS._uq || '';
  const _st = TABS._ust || '';
  let url = '/admin/users?limit=30';
  if (_q) url += '&q=' + encodeURIComponent(_q);
  if (_st) url += '&status=' + encodeURIComponent(_st);

  let d = { users: [], total: 0 };
  try {
    const r = await ABC.api(url);
    d = await r.json();
  } catch (e) {
    console.error('Failed to load users:', e);
  }

  const usersList = d.users || [];
  const totalUsers = d.total || 0;

  // Calculate high-level summary KPIs
  let totalBal = 0;
  let activeCnt = 0;
  let pendingCnt = 0;
  let blockedCnt = 0;
  usersList.forEach(u => {
    totalBal += Number(u.balance) || 0;
    if (u.status === 'active') activeCnt++;
    else if (u.status === 'pending') pendingCnt++;
    else if (u.status === 'blocked' || u.status === 'disabled') blockedCnt++;
  });

  const statusTabs = [
    { key: '', label: 'সব ইউজার', chip: totalUsers },
    { key: 'active', label: '🟢 সক্রিয়', chip: activeCnt },
    { key: 'pending', label: '🟡 অপেক্ষমান', chip: pendingCnt },
    { key: 'blocked', label: '🔴 ব্লকড', chip: blockedCnt },
  ];

  let html = '<div class="adm-orders-wrap">' +
    '<!-- KPI Metric Cards -->' +
    '<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:12px;">' +
      '<div style="background:#fff; border:1px solid var(--border-light); border-radius:var(--r-lg); padding:14px; box-shadow:var(--shadow-sm);">' +
        '<div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">👥 মোট নিবন্ধিত ইউজার</div>' +
        '<div style="font-size:24px; font-weight:800; color:#0f172a; margin-top:4px;">' + bn(totalUsers) + ' <span style="font-size:12px; font-weight:600; color:#64748b;">জন</span></div>' +
      '</div>' +
      '<div style="background:#fff; border:1px solid var(--border-light); border-radius:var(--r-lg); padding:14px; box-shadow:var(--shadow-sm);">' +
        '<div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">🟢 সক্রিয় অ্যাকাউন্ট</div>' +
        '<div style="font-size:24px; font-weight:800; color:#166534; margin-top:4px;">' + bn(activeCnt) + ' <span style="font-size:12px; font-weight:600; color:#64748b;">টি</span></div>' +
      '</div>' +
      '<div style="background:#fff; border:1px solid var(--border-light); border-radius:var(--r-lg); padding:14px; box-shadow:var(--shadow-sm);">' +
        '<div style="font-size:11px; font-weight:700; color:#64748b; text-transform:uppercase;">💰 বর্তমান ওয়ালেট তারল্য</div>' +
        '<div style="font-size:24px; font-weight:800; color:#1d4ed8; margin-top:4px;">৳ ' + bn(totalBal) + '</div>' +
      '</div>' +
    '</div>' +

    '<!-- Smart Filter & Search Toolbar -->' +
    '<div class="adm-orders-toolbar">' +
      '<div class="adm-tabs-row">' +
        statusTabs.map(s => {
          const isActive = (TABS._ust || '') === s.key;
          return '<button class="adm-tab-btn' + (isActive ? ' active' : '') + '" onclick="AdmUsers.filterStatus(\'' + s.key + '\')">' +
            s.label + ' <span class="adm-tab-chip">' + bn(s.chip) + '</span>' +
          '</button>';
        }).join('') +
      '</div>' +
      '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap;">' +
        '<div style="display:flex; align-items:center; gap:8px; flex:1; min-width:260px;">' +
          '<input type="text" id="uq" class="adm-search-input" placeholder="🔍 নাম, ফোন, WhatsApp বা ইউজার আইডি খুঁজুন..." value="' + esc(_q) + '" onkeydown="if(event.key===\'Enter\')AdmUsers.search()">' +
          '<button class="mini-btn" onclick="AdmUsers.search()">খুঁজুন</button>' +
          (_q || _st ? '<button class="mini-btn danger" onclick="AdmUsers.clearFilter()">✕ রিসেট</button>' : '') +
        '</div>' +
        '<button class="btn-quick-primary" style="padding:9px 16px; font-size:12px;" onclick="AdmUsers.createForm()">+ নতুন ইউজার তৈরি করুন</button>' +
      '</div>' +
    '</div>' +

    '<!-- Modern High-Density Table -->' +
    '<div class="adm-table-card">' +
      '<div style="overflow-x:auto;">' +
        '<table class="adm-table" id="uTable">' +
          '<thead>' +
            '<tr>' +
              '<th>ব্যবহারকারী / কাস্টমার</th>' +
              '<th>যোগাযোগ (ফোন ও WhatsApp)</th>' +
              '<th>ধর্ম ও রোল</th>' +
              '<th>ওয়ালেট ব্যালেন্স</th>' +
              '<th>অ্যাকাউন্ট স্টেটাস</th>' +
              '<th style="text-align:right;">ব্যবস্থাপনা ও অ্যাকশন</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>';

  for (const u of usersList) {
    html += AdmUsers.row(u);
  }
  if (!usersList.length) {
    html += '<tr><td colspan="6" style="text-align:center; padding:36px; color:#64748b;">কোনো ইউজার পাওয়া যায়নি</td></tr>';
  }

  const shown = usersList.length;
  html += '</tbody></table></div>' +
    '<div style="display:flex; align-items:center; justify-content:space-between; padding:12px 16px; background:#f8fafc; border-top:1px solid #eef2f7; font-size:12px; color:#64748b;">' +
      '<div>মোট ইউজার: <b>' + bn(totalUsers) + '</b> জন (দেখানো হয়েছে: <b>' + bn(shown) + '</b> জন)</div>' +
      '<div id="uMore">' + (totalUsers > shown ? '<button class="mini-btn" onclick="AdmUsers.more()">আরো দেখুন ↓</button>' : '') + '</div>' +
    '</div>' +
  '</div></div>';

  content.innerHTML = html;
};

window.AdmUsers = {
  row(u) {
    const myId = (typeof me !== 'undefined' && me && me.id) || '';
    const initial = (u.name || 'ইউ').charAt(0).toUpperCase();
    const isVerified = u.email_verified !== false;

    let stBadge = '<span class="st-badge st-processing">অজ্ঞাত</span>';
    if (u.status === 'active') stBadge = '<span class="st-badge st-completed">🟢 সক্রিয়</span>';
    else if (u.status === 'pending') stBadge = '<span class="st-badge st-pending">🟡 অপেক্ষমান</span>';
    else if (u.status === 'blocked') stBadge = '<span class="st-badge st-failed">🔴 ব্লকড</span>';
    else if (u.status === 'disabled') stBadge = '<span class="st-badge st-failed">🔒 নিষ্ক্রিয়</span>';

    const roleBadge = u.role === 'admin'
      ? '<span style="display:inline-block; padding:2px 6px; border-radius:5px; background:#eff6ff; color:#1d4ed8; font-weight:700; font-size:10px;">🛡️ অ্যাডমিন</span>'
      : '<span style="color:#64748b; font-size:11px;">কাস্টমার</span>';

    const waLink = u.whatsapp
      ? '<a href="https://wa.me/88' + esc(u.whatsapp.replace(/\D/g, '')) + '" target="_blank" style="color:#16a34a; font-weight:600; text-decoration:none;" title="হোয়াটসঅ্যাপে চ্যাট করুন">💬 ' + esc(u.whatsapp) + '</a>'
      : '<span style="color:#94a3b8;">নেই</span>';

    return '<tr>' +
      '<td>' +
        '<div class="adm-user-cell">' +
          '<div class="adm-user-avatar">' + esc(initial) + '</div>' +
          '<div>' +
            '<div class="adm-user-name">' + esc(u.name) + '</div>' +
            '<div style="display:flex; align-items:center; gap:6px; margin-top:2px;">' +
              '<span class="adm-order-tag" title="ক্লিক করে আইডি কপি করুন" style="cursor:pointer;" onclick="navigator.clipboard&&navigator.clipboard.writeText(\'' + escJs(u.id) + '\');alert(\'ইউজার আইডি কপি হয়েছে\')">#' + esc(u.id.slice(0, 8)) + '</span>' +
              (u.email ? '<span style="font-size:10px; color:#64748b;">' + esc(u.email) + '</span>' : '') +
            '</div>' +
            (u.email_verified === false ? '<div style="margin-top:2px;"><small style="color:#f59e0b; font-weight:600;">⚠️ ইমেইল অযাচাইকৃত</small></div>' : '') +
          '</div>' +
        '</div>' +
      '</td>' +
      '<td>' +
        '<div style="font-size:12px; font-weight:600; color:#0f172a;">📞 ' + esc(u.phone) + '</div>' +
        '<div style="font-size:11px; margin-top:3px;">' + waLink + '</div>' +
      '</td>' +
      '<td>' +
        '<div style="font-size:12px; font-weight:600; color:#334155;">' + esc(u.religion || 'অনির্দিষ্ট') + '</div>' +
        '<div style="margin-top:3px;">' + roleBadge + '</div>' +
      '</td>' +
      '<td>' +
        '<div class="adm-price-badge">৳ ' + bn(u.balance) + '</div>' +
      '</td>' +
      '<td>' + stBadge + '</td>' +
      '<td style="text-align:right;">' +
        '<div style="display:inline-flex; align-items:center; gap:6px;">' +
          '<button class="mini-btn ok" style="padding:6px 10px; font-size:11px; font-weight:700;" onclick="AdmUsers.edit(\'' + u.id + '\')">⚙️ নিয়ন্ত্রণ</button>' +
          (u.id !== myId
            ? '<button class="mini-btn danger" style="padding:6px 9px;" onclick="AdmUsers.del(\'' + u.id + '\',\'' + escJs(u.name) + '\')" title="ডিলিট করুন">🗑️</button>'
            : '<span style="font-size:11px; color:#94a3b8; padding:0 6px;">(নিজ একাউন্ট)</span>') +
        '</div>' +
      '</td>' +
    '</tr>';
  },

  async filterStatus(st) {
    TABS._ust = st;
    TABS._upage = 1;
    show('users');
  },

  clearFilter() {
    TABS._uq = '';
    TABS._ust = '';
    TABS._upage = 1;
    show('users');
  },

  async more() {
    TABS._upage = (TABS._upage || 1) + 1;
    const _q = TABS._uq || '';
    const _st = TABS._ust || '';
    let url = '/admin/users?limit=30&page=' + TABS._upage;
    if (_q) url += '&q=' + encodeURIComponent(_q);
    if (_st) url += '&status=' + encodeURIComponent(_st);

    const r = await ABC.api(url);
    const d = await r.json();
    const tbl = document.getElementById('uTable');
    if (tbl && tbl.querySelector('tbody')) {
      const tbody = tbl.querySelector('tbody');
      (d.users || []).forEach(u => {
        tbody.insertAdjacentHTML('beforeend', AdmUsers.row(u));
      });
    }
    const shown = tbl ? tbl.querySelectorAll('tbody tr').length : 0;
    const moreBox = document.getElementById('uMore');
    if (moreBox) {
      moreBox.innerHTML = (d.total > shown)
        ? '<button class="mini-btn" onclick="AdmUsers.more()">আরো দেখুন ↓ (' + bn(shown) + '/' + bn(d.total) + ')</button>'
        : '<div style="color:var(--muted);font-size:12px;">সব দেখানো হয়েছে (' + bn(d.total) + ')</div>';
    }
  },

  async search() {
    const q = (document.getElementById('uq') || {}).value || '';
    TABS._uq = q;
    TABS._upage = 1;
    show('users');
  },

  createForm() {
    modal('👥 নতুন ব্যবহারকারী তৈরি করুন',
      '<div style="display:grid; gap:12px;">' +
        fld('পূর্ণ নাম *', 'text', 'cu_name', '', 'গ্রাহকের পুরো নাম লিখুন') +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' +
          fld('মোবাইল নম্বর * (01XXXXXXXXX)', 'text', 'cu_phone', '', '01XXXXXXXXX') +
          fld('WhatsApp নম্বর * (01XXXXXXXXX)', 'text', 'cu_wa', '', '01XXXXXXXXX') +
        '</div>' +
        fld('ইমেইল অ্যাড্রেস (ঐচ্ছিক)', 'email', 'cu_email', '', 'name@example.com') +
        fld('অ্যাকাউন্ট পাসওয়ার্ড (৮+ অক্ষর, অক্ষর ও সংখ্যা)', 'password', 'cu_pw', '', '••••••••') +
        '<div class="field"><label>ধর্ম</label><select id="cu_religion">' +
          ['islam', 'hindu', 'buddhist', 'christian', 'other'].map(x => '<option value="' + x + '">' + x + '</option>').join('') +
        '</select></div>' +
        '<button class="btn-quick-primary" style="margin-top:10px; width:100%; justify-content:center; padding:12px;" onclick="AdmUsers.create()">✅ ইউজার তৈরি ও সংরক্ষণ</button>' +
      '</div>');
  },

  async create() {
    const body = {
      name: v('cu_name'),
      phone: v('cu_phone'),
      whatsapp: v('cu_wa'),
      email: v('cu_email'),
      password: v('cu_pw'),
      religion: v('cu_religion'),
    };
    const r = await ABC.api('/admin/users', { method: 'POST', body });
    const d = await r.json();
    if (!r.ok) {
      const msg = {
        PHONE_TAKEN: 'এই ফোন নম্বরটি ইতিমধ্যে ব্যবহৃত হয়েছে',
        EMAIL_TAKEN: 'এই ইমেইলটি ইতিমধ্যে ব্যবহৃত হয়েছে',
        INVALID_INPUT: 'নাম ও সঠিক ফোন নম্বর প্রদান করুন',
        INVALID_WHATSAPP: 'সঠিক WhatsApp নম্বর প্রদান করুন (১১ ডিজিট)',
        WEAK_PASSWORD: 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষর, অক্ষর+সংখ্যা থাকতে হবে',
      }[d.error] || ('ব্যর্থ: ' + d.error);
      alert(msg); return;
    }
    alert('✅ নতুন ইউজার সফলভাবে তৈরি হয়েছে');
    closeModal();
    show('users');
  },

  async edit(id) {
    let u = null;
    try {
      const r = await ABC.api('/admin/users/' + id);
      if (r.ok) {
        const d = await r.json();
        u = d.user;
      }
    } catch (e) {}

    if (!u) {
      const r = await ABC.api('/admin/users?limit=100');
      u = (await r.json()).users.find(x => x.id === id);
    }
    if (!u) {
      alert('ইউজার ডাটা লোড করা সম্ভব হয়নি');
      return;
    }

    const tabs = [
      { id: 'profile', icon: '📝', label: 'প্রোফাইল' },
      { id: 'balance', icon: '💰', label: 'ব্যালেন্স' },
      { id: 'services', icon: '🛎️', label: 'সেবা' },
      { id: 'security', icon: '🔒', label: 'সিকিউরিটি' },
    ];
    const activeTab = window._usrTab || 'profile';

    let tabBtns = '<div style="display:flex; gap:6px; margin-bottom:16px; border-bottom:2px solid var(--border-light); padding-bottom:10px; flex-wrap:wrap;">';
    tabs.forEach(t => {
      tabBtns += '<button class="mini-btn' + (activeTab === t.id ? ' ok' : '') + '" ' +
        'style="padding:8px 14px; font-weight:700; border-radius:8px;" ' +
        'onclick="window._usrTab=\'' + t.id + '\';AdmUsers.edit(\'' + id + '\')">' + t.icon + ' ' + t.label + '</button>';
    });
    tabBtns += '</div>';

    let body = '';
    if (activeTab === 'profile') {
      body = '<div style="display:grid; gap:12px;">' +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' +
          fld('পূর্ণ নাম', 'text', 'eu_name', u.name) +
          fld('ফোন নম্বর', 'text', 'eu_phone', u.phone || '') +
        '</div>' +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' +
          fld('WhatsApp নম্বর', 'text', 'eu_wa', u.whatsapp || '') +
          fld('ইমেইল অ্যাড্রেস', 'email', 'eu_email', u.email || '') +
        '</div>' +
        '<div style="display:grid; grid-template-columns:1fr 1fr; gap:10px;">' +
          '<div class="field"><label>ধর্ম</label><select id="eu_religion">' +
            ['islam', 'hindu', 'buddhist', 'christian', 'other'].map(x =>
              '<option value="' + x + '"' + (u.religion === x ? ' selected' : '') + '>' + x + '</option>').join('') +
          '</select></div>' +
          '<div class="field"><label>অ্যাকাউন্ট স্ট্যাটাস</label><select id="eu_status">' +
            ['active', 'pending', 'disabled', 'blocked'].map(x =>
              '<option value="' + x + '"' + (u.status === x ? ' selected' : '') + '>' + x + '</option>').join('') +
          '</select></div>' +
        '</div>' +
        '<button class="btn-quick-primary" style="margin-top:8px; justify-content:center; padding:11px;" onclick="AdmUsers.saveProfile(\'' + id + '\')">💾 প্রোফাইল তথ্য সংরক্ষণ করুন</button>' +
      '</div>';
    } else if (activeTab === 'balance') {
      body = '<div style="background:#eff6ff; border:1px solid #bfdbfe; padding:18px; border-radius:12px; margin-bottom:16px; text-align:center;">' +
        '<div style="font-size:12px; font-weight:700; color:#1e40af; text-transform:uppercase;">বর্তমান ওয়ালেট ব্যালেন্স</div>' +
        '<div style="font-size:32px; font-weight:800; color:#1d4ed8; margin-top:4px;">৳ ' + bn(u.balance) + '</div>' +
      '</div>' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px;">' +
        [100, 500, 1000, 5000].map(amt =>
          '<button type="button" class="mini-btn" style="padding:6px 10px; font-weight:700;" onclick="document.getElementById(\'eu_bal\').value=\'' + amt + '\'">+৳' + amt + '</button>'
        ).join('') +
      '</div>' +
      fld('টাকার পরিমাণ (সংখ্যা লিখুন)', 'number', 'eu_bal', '', 'যেমন: ৫০০') +
      fld('লেনদেনের কারণ / অডিট নোট (বাধ্যতামূলক)', 'text', 'eu_bal_note', '', 'যেমন: অ্যাডমিন ব্যালেন্স সমন্বয় / রিচার্জ') +
      '<div style="display:flex; gap:10px; margin-top:14px;">' +
        '<button class="btn-quick-primary" style="flex:1; justify-content:center; padding:12px; background:#16a34a;" onclick="AdmUsers.adjustBalance(\'' + id + '\',1)">➕ ব্যালেন্স যোগ করুন</button>' +
        '<button class="btn" style="flex:1; justify-content:center; padding:12px; background:#dc2626; color:#fff;" onclick="AdmUsers.adjustBalance(\'' + id + '\',-1)">➖ ব্যালেন্স কাটুন</button>' +
      '</div>';
    } else if (activeTab === 'services') {
      body = '<div id="usrSvcList" style="color:#64748b; padding:12px 0;">সেবাসমূহ লোড হচ্ছে...</div>';
      setTimeout(() => AdmUsers.loadUserServices(id), 50);
    } else if (activeTab === 'security') {
      body = '<div style="display:grid; gap:12px;">' +
        '<div style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">' +
          '<div>' +
            '<div style="font-size:12px; font-weight:700; color:#0f172a;">লগইন সীমাবদ্ধতা ও নিরাপত্তা</div>' +
            '<div style="font-size:11px; color:#64748b;">ভুল পাসওয়ার্ডে ব্লক হলে আনলক করুন</div>' +
          '</div>' +
          '<button class="mini-btn ok" style="padding:7px 12px;" onclick="AdmUsers.unblock(\'' + id + '\')">🔓 লিমিট আনব্লক</button>' +
        '</div>' +
        '<div style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">' +
          '<div>' +
            '<div style="font-size:12px; font-weight:700; color:#0f172a;">ইমেইল ভেরিফিকেশন স্ট্যাটাস</div>' +
            '<div style="font-size:11px; color:#64748b;">' + (u.email || 'কোনো ইমেইল যুক্ত নেই') + '</div>' +
          '</div>' +
          (u.email_verified ? '<div style="color:#22c55e;">✅ ইমেইল যাচাইকৃত</div>'
            : '<button class="btn-secondary" onclick="AdmUsers.verifyEmail(\'' + id + '\')">✅ ইমেইল যাচাই করুন</button>') +
        '</div>' +
        '<div style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">' +
          '<div>' +
            '<div style="font-size:12px; font-weight:700; color:#0f172a;">পাসওয়ার্ড রিসেট</div>' +
            '<div style="font-size:11px; color:#64748b;">স্বয়ংক্রিয় নতুন র‍্যান্ডম পাসওয়ার্ড তৈরি হবে</div>' +
          '</div>' +
          '<button class="mini-btn" style="padding:7px 12px;" onclick="AdmUsers.resetPw(\'' + id + '\')">🔑 রিসেট পাসওয়ার্ড</button>' +
        '</div>' +
        '<div style="display:flex; align-items:center; justify-content:space-between; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">' +
          '<div>' +
            '<div style="font-size:12px; font-weight:700; color:#0f172a;">কার্যক্রম ও হিস্ট্রি সামারি</div>' +
            '<div style="font-size:11px; color:#64748b;">অর্ডার ও লেনদেনের বিস্তারিত সংখ্যা</div>' +
          '</div>' +
          '<button class="mini-btn" style="padding:7px 12px;" onclick="AdmUsers.viewData(\'' + id + '\')">📊 ইউজার ডেটা দেখুন</button>' +
        '</div>' +
        '<div style="margin-top:10px; padding:14px; border:1px solid #fecaca; background:#fff1f2; border-radius:10px;">' +
          '<div style="font-size:12px; font-weight:700; color:#991b1b;">⚠️ বিপদজনক অঞ্চল (Danger Zone)</div>' +
          '<div style="font-size:11px; color:#7f1d1d; margin:4px 0 10px 0;">ইউজার মুছে ফেললে তার সমস্ত অর্ডার, ব্যালেন্স ও ট্রানজ্যাকশন ডাটা চিরতরে নষ্ট হবে।</div>' +
          '<button class="btn" style="background:#dc2626; color:#fff; width:100%; justify-content:center; padding:10px;" onclick="AdmUsers.del(\'' + id + '\',\'' + escJs(u.name) + '\')">🗑️ ইউজার সম্পূর্ণ ডিলিট করুন</button>' +
        '</div>' +
      '</div>';
    }

    modal('👤 ব্যবহারকারী ব্যবস্থাপনা — ' + esc(u.name), tabBtns + body);
  },

  async saveProfile(id) {
    const body = {
      name: v('eu_name'),
      phone: v('eu_phone'),
      whatsapp: v('eu_wa'),
      email: v('eu_email'),
      religion: v('eu_religion'),
      status: v('eu_status'),
    };
    const r = await ABC.api('/admin/users/' + id, { method: 'PUT', body });
    const d = await r.json();
    if (!r.ok) { alert('সংরক্ষণ ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    alert('✅ ব্যবহারকারীর প্রোফাইল সফলভাবে আপডেট হয়েছে');
    closeModal();
    show('users');
  },

  async adjustBalance(id, dir) {
    let amt = Number(v('eu_bal')) || 0;
    if (amt <= 0) { alert('টাকার সঠিক পরিমাণ লিখুন'); return; }
    amt = dir * Math.abs(amt);
    const note = v('eu_bal_note');
    if (!note) {
      if (!confirm('আপনি কোনো কারণ/নোট লেখেননি। নোট ছাড়া এগিয়ে যাবেন?')) return;
    }
    const r = await ABC.api('/admin/users/' + id, {
      method: 'PUT',
      body: { balance_adjust: amt, balance_note: note, admin_note: note }
    });
    if (!r.ok) { alert('ব্যালেন্স পরিবর্তন ব্যর্থ হয়েছে'); return; }
    alert('✅ ব্যালেন্স সফলভাবে ' + (amt > 0 ? 'যোগ' : 'কর্তন') + ' করা হয়েছে');
    closeModal();
    show('users');
  },

  async loadUserServices(userId) {
    try {
      const [svcR, ovR] = await Promise.all([
        ABC.api('/admin/services'),
        ABC.api('/admin/users/' + userId + '/service-overrides'),
      ]);
      const services = (await svcR.json()).services || [];
      const overrides = (await ovR.json()).overrides || {};

      let h = '<div style="display:grid; gap:8px; max-height:420px; overflow-y:auto; padding-right:4px;">';
      services.forEach(s => {
        const ov = overrides[s.id] || {};
        const enabled = ov.access_enabled !== false;
        const customPrice = ov.custom_price != null ? ov.custom_price : '';
        h += '<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:10px 12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:9px;">' +
          '<div style="display:flex; align-items:center; gap:10px; flex:1;">' +
            '<span style="font-size:20px;">' + esc(s.icon || '📦') + '</span>' +
            '<div>' +
              '<div style="font-size:12px; font-weight:700; color:#0f172a;">' + esc(s.name_bn || s.name) + '</div>' +
              '<div style="font-size:11px; color:#64748b;">ডিফল্ট রেট: <b>৳ ' + bn(s.price) + '</b></div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex; align-items:center; gap:8px;">' +
            '<div style="display:flex; align-items:center; gap:4px;">' +
              '<span style="font-size:11px; color:#64748b;">কাস্টম রেট:</span>' +
              '<input type="number" id="usv_price_' + s.id + '" value="' + customPrice + '" ' +
              'placeholder="৳ ' + s.price + '" style="width:85px; padding:6px 8px; border-radius:6px; border:1px solid #cbd5e1; font-size:12px; font-weight:700; text-align:right;">' +
            '</div>' +
            '<button class="mini-btn' + (enabled ? ' ok' : ' danger') + '" style="padding:6px 10px; font-size:11px; font-weight:700;" onclick="AdmUsers.toggleSvc(\'' + userId + '\',\'' + s.id + '\',' + enabled + ')">' +
              (enabled ? '🟢 চালু' : '🔴 বন্ধ') +
            '</button>' +
          '</div>' +
        '</div>';
      });
      h += '</div>' +
        '<button class="btn-quick-primary" style="margin-top:14px; width:100%; justify-content:center; padding:11px;" onclick="AdmUsers.saveSvcPrices(\'' + userId + '\')">💾 কাস্টম রেটসমূহ সংরক্ষণ করুন</button>';

      const el = document.getElementById('usrSvcList');
      if (el) el.innerHTML = h;
      window._usrSvcList = services;
    } catch (e) {
      const el = document.getElementById('usrSvcList');
      if (el) el.innerHTML = '<div style="color:#dc2626; padding:12px;">সেবার তালিকা লোড ব্যর্থ হয়েছে</div>';
    }
  },

  async toggleSvc(userId, serviceId, cur) {
    const r = await ABC.api('/admin/users/' + userId + '/service-access', {
      method: 'PUT', body: { service_id: serviceId, enabled: !cur },
    });
    if (!r.ok) { alert('সেবা স্টেটাস পরিবর্তন ব্যর্থ'); return; }
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
    alert('✅ ইউজারের কাস্টম রেট সফলভাবে সংরক্ষিত হয়েছে');
  },

  async resetPw(id) {
    if (!confirm('পাসওয়ার্ড রিসেট করবেন? নতুন পাসওয়ার্ড তৈরি হয়ে পর্দায় প্রদর্শিত হবে।')) return;
    const r = await ABC.api('/admin/users/' + id + '/reset-password', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { alert('রিসেট ব্যর্থ: ' + (d.error || '')); return; }
    alert('✅ নতুন পাসওয়ার্ড:\n\n' + d.new_password + '\n\nপাসওয়ার্ডটি কপি করে কাস্টমারকে সরবরাহ করুন।');
  },

  async viewData(id) {
    const r = await ABC.api('/admin/users/' + id + '/data');
    const d = await r.json();
    alert('📊 ব্যবহারকারীর সারাংশ:\n\n' +
      '• মোট সম্পন্ন অর্ডার: ' + (d.orders || 0) + ' টি\n' +
      '• মোট লেনদেন: ' + (d.transactions || 0) + ' টি\n' +
      '• বর্তমান ওয়ালেট ব্যালেন্স: ৳ ' + (d.balance || 0));
  },

  async unblock(id) {
    await ABC.api('/admin/users/' + id + '/unblock', { method: 'POST' });
    alert('✅ ব্যবহারকারীর লগইন লিমিট সফলভাবে আনব্লক করা হয়েছে');
    closeModal();
    show('users');
  },

  async verifyEmail(id) {
    if (!confirm('এই ইউজারের ইমেইল যাচাইকৃত হিসেবে চিহ্নিত করবেন?')) return;
    const r = await ABC.api('/admin/users/' + id + '/verify-email', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { alert('ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    alert('✅ ইমেইল যাচাই হয়েছে — এখন লগইন করতে পারবে');
    closeModal();
    show('users');
  },

  async del(id, name) {
    if (!confirm('⚠️ সত্যিই ডিলিট করবেন?\n\n' + name + '\n\nসব ডাটা মুছে যাবে: অর্ডার, লেনদেন, কুপন, নোটিশ, চ্যাট, ডকুমেন্ট!')) return;
    if (!confirm('🔴 শেষ কনফার্মেশন — ফিরিয়ে আনা যাবে না!')) return;
    const r = await ABC.api('/admin/users/' + id + '?confirm=yes', { method: 'DELETE' });
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + d.error); return; }
    alert('✅ ব্যবহারকারী সফলভাবে মুছে ফেলা হয়েছে');
    show('users');
  },
};

/* ---------------- ORDERS (Fintech Order Hub Redesign) ---------------- */
const ORDER_LABELS_BN = {
  nid: 'জাতীয় পরিচয়পত্র (NID)',
  nid_number: 'NID নম্বর',
  nid_no: 'NID নম্বর',
  dob: 'জন্ম তারিখ',
  birth_date: 'জন্ম তারিখ',
  birth_registration_number: 'জন্মনিবন্ধন নম্বর',
  brn: 'জন্মনিবন্ধন নম্বর',
  name: 'নাম',
  full_name: 'পূর্ণ নাম',
  user_name: 'গ্রাহকের নাম',
  phone: 'মোবাইল নম্বর',
  user_phone: 'মোবাইল নম্বর',
  email: 'ইমেইল',
  father_name: 'পিতার নাম',
  mother_name: 'মাতার নাম',
  spouse_name: 'স্বামী/স্ত্রীর নাম',
  division: 'বিভাগ',
  district: 'জেলা',
  upazila: 'উপজেলা/থানা',
  thana: 'উপজেলা/থানা',
  union: 'ইউনিয়ন/পৌরসভা',
  post_office: 'ডাকঘর',
  village: 'গ্রাম/মহল্লা',
  ward: 'ওয়ার্ড',
  tracking_number: 'ট্র্যাকিং নম্বর',
  application_id: 'আবেদন আইডি',
  comments: 'মন্তব্য',
  note: 'নোট',
  gender: 'লিঙ্গ'
};

TABS.orders = async () => {
  const _f = TABS._f || '';
  const _q = TABS._q || '';
  const _type = TABS._orderType || '';
  let url = '/admin/orders?limit=50';
  if (_f) url += '&status=' + encodeURIComponent(_f);
  if (_q) url += '&q=' + encodeURIComponent(_q);
  if (_type) url += '&type=' + encodeURIComponent(_type);

  const [ordersRes, statsRes] = await Promise.all([
    ABC.api(url),
    ABC.api('/admin/stats').catch(() => ({ ok: false }))
  ]);

  const d = await ordersRes.json().catch(() => ({}));
  if (!ordersRes.ok) throw new Error(d.error && d.error !== 'FAILED' ? d.error : 'অর্ডার লোড ব্যর্থ (সার্ভার সমস্যা)');
  const stats = statsRes.ok ? await statsRes.json().catch(() => ({})) : {};
  TABS._orders = d.orders || [];
  const pendingManual = Number(stats.manual_new) || 0;
  const orderTypeTabs = [
    { key: '', label: 'সব প্রসেসিং', icon: '📦' },
    { key: 'auto', label: 'অটো সেবা', icon: '⚙️' },
    { key: 'manual', label: 'ম্যানুয়াল আবেদন', icon: '📝' }
  ];

  const statusList = [
    { key: '', label: 'সব অর্ডার', count: stats.orders_total },
    { key: 'new', label: 'নতুন', count: stats.orders_new },
    { key: 'processing', label: 'প্রসেসিং', count: stats.orders_active },
    { key: 'completed', label: 'সম্পন্ন', count: stats.orders_completed },
    { key: 'delivered', label: 'ডেলিভার্ড' },
    { key: 'pending', label: 'অপেক্ষমান' },
    { key: 'cancelled', label: 'বাতিল' },
    { key: 'refunded', label: 'রিফান্ডেড' }
  ];

  let html = '<div class="adm-orders-wrap">' +
    '<!-- Top Toolbar & Search -->' +
    '<div class="adm-orders-toolbar">' +
      '<div class="adm-orders-type-switch" role="tablist" aria-label="অর্ডারের ধরন">' +
        orderTypeTabs.map(t => '<button type="button" class="adm-type-tab' + (_type === t.key ? ' active' : '') + '" onclick="AdmOrders.filterType(\'' + t.key + '\')">' + t.icon + ' ' + esc(t.label) + (t.key === 'manual' && pendingManual > 0 ? '<span class="adm-type-count">' + bn(pendingManual) + '</span>' : '') + '</button>').join('') +
      '</div>' +
      '<div class="adm-tabs-row">' +
        statusList.map(s => {
          const isActive = _f === s.key;
          const countBadge = (s.count !== undefined && s.count !== null) ? '<span class="adm-tab-chip">' + bn(s.count) + '</span>' : '';
          return '<button class="adm-tab-btn' + (isActive ? ' active' : '') + '" onclick="AdmOrders.filter(\'' + s.key + '\')">' +
            esc(s.label) + countBadge + '</button>';
        }).join('') +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-left:auto;">' +
        '<input type="text" id="admOrderSearch" class="adm-search-input" placeholder="🔍 গ্রাহকের নাম, মোবাইল বা সার্ভিস খুঁজুন..." value="' + esc(_q) + '" onkeydown="if(event.key===\'Enter\')AdmOrders.search(this.value)">' +
        '<button class="mini-btn" onclick="AdmOrders.search(document.getElementById(\'admOrderSearch\').value)">খুঁজুন</button>' +
        (_q ? '<button class="mini-btn danger" onclick="AdmOrders.clearSearch()">✕ ক্লিয়ার</button>' : '') +
      '</div>' +
    '</div>' +

    '<!-- Orders Table Card -->' +
    '<div class="adm-table-card">' +
      '<div style="overflow-x:auto;">' +
        '<table class="adm-table">' +
          '<thead><tr>' +
            '<th>অর্ডার ও গ্রাহক</th>' +
            '<th>সেবা</th>' +
            '<th>মূল্য</th>' +
            '<th>স্ট্যাটাস</th>' +
            '<th>তারিখ ও সময়</th>' +
            '<th style="text-align:right;">অ্যাকশন ও প্রসেসিং</th>' +
          '</tr></thead>' +
          '<tbody>';

  if (!TABS._orders.length) {
    html += '<tr><td colspan="6" style="text-align:center;padding:48px 20px;color:var(--text-muted);">' +
      '<div style="font-size:36px;margin-bottom:8px;">📦</div>' +
      '<div style="font-size:15px;font-weight:600;">কোনো অর্ডার পাওয়া যায়নি</div>' +
      '<div style="font-size:12px;margin-top:4px;">অন্য কোনো ফিল্টার বা সার্চ দিয়ে চেষ্টা করুন।</div>' +
      '</td></tr>';
  } else {
    for (const o of TABS._orders) {
      const uName = o.user_name || 'গ্রাহক';
      const initials = uName.slice(0, 2).toUpperCase();
      const stClass = 'st-' + (o.status || 'new');
      const stText = STBN[o.status] || o.status;

      // Smart Quick Action button
      let quickActionBtn = '';
      if (o.status === 'new' || o.status === 'pending') {
        quickActionBtn = '<button class="btn-quick-primary" onclick="AdmOrders.startProcessing(\'' + o.id + '\')">▶️ গ্রহণ করুন</button>';
      } else if (o.status === 'processing' || o.status === 'received' || o.status === 'registered') {
        quickActionBtn = '<button class="btn-quick-success" onclick="AdmOrders.openQuickComplete(\'' + o.id + '\')">✅ সম্পন্ন ও ডেলিভারি</button>';
      } else if (o.status === 'completed') {
        quickActionBtn = '<button class="btn-quick-emerald" onclick="AdmOrders.markDelivered(\'' + o.id + '\')">🚀 ডেলিভার্ড করুন</button>';
      } else if (o.status === 'delivered') {
        quickActionBtn = '<span style="color:#059669;font-weight:700;font-size:11px;">✓ ডেলিভার্ড সম্পন্ন</span>';
      }

      html += '<tr>' +
        '<td>' +
          '<div class="adm-user-cell">' +
            '<div class="adm-user-avatar">' + esc(initials) + '</div>' +
            '<div>' +
              '<div class="adm-user-name">' + esc(uName) + '</div>' +
              '<div class="adm-user-phone">' +
                '<span>📞 <a href="tel:' + esc(o.user_phone) + '" style="color:inherit;text-decoration:none;">' + esc(o.user_phone) + '</a></span>' +
                '<span class="adm-order-tag">#' + esc(String(o.id).slice(0, 8)) + '</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</td>' +
        '<td>' +
          '<div class="adm-svc-title">' + esc(o.service_name_bn || o.service_name || 'সেবা') + '</div>' +
          '<div class="adm-order-meta">' +
            (o.service_type === 'manual' || (o.data && (typeof o.data === 'object' ? o.data._manual_form : String(o.data).includes('_manual_form')))
              ? '<span class="adm-type-badge manual">📝 ম্যানুয়াল</span>'
              : '<span class="adm-type-badge auto">⚙️ অটো</span>') +
            (o.service_engine ? '<span class="adm-engine-mini">' + esc(o.service_engine) + '</span>' : '') +
          '</div>' +
        '</td>' +
        '<td>' +
          '<span class="adm-price-badge">৳' + bn(o.price) + '</span>' +
        '</td>' +
        '<td>' +
          '<span class="st-badge ' + stClass + '">' + esc(stText) + '</span>' +
        '</td>' +
        '<td>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text-main);">' + new Date(o.created_at).toLocaleDateString('bn-BD') + '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);">' + new Date(o.created_at).toLocaleTimeString('bn-BD', {hour:'2-digit', minute:'2-digit'}) + '</div>' +
        '</td>' +
        '<td>' +
          '<div class="adm-action-grp" style="justify-content:flex-end;">' +
            quickActionBtn +
            '<button class="adm-icon-btn" title="সম্পূর্ণ তথ্য পর্যালোচনা ও ডেলিভারি" onclick="AdmOrders.view(\'' + o.id + '\')">👁️ বিস্তারিত</button>' +
            '<button class="adm-icon-btn" title="গ্রাহকের সাথে সাপোর্ট চ্যাট" onclick="AdmOrders.supportForm(\'' + o.id + '\')">💬</button>' +
            '<button class="adm-icon-btn" title="ডেলিভারি ফাইল আপলোড" onclick="AdmOrders.deliForm(\'' + o.id + '\')">📎</button>' +
            '<button class="adm-icon-btn danger" title="অর্ডার ডিলিট করুন" onclick="AdmOrders.deleteOrder(\'' + o.id + '\')">🗑️</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }
  }

  html += '</tbody></table></div></div></div>';
  html += '<div class="card" style="margin-top:16px;"><h3>🕘 BDRIS আবেদনসমূহ (অটো সেবা)</h3>' +
    '<div id="admBdrisApps" class="s">⏳ লোড হচ্ছে…</div></div>';
  content.innerHTML = html;
  AdmOrders.loadBdrisApps();
};

window.AdmOrders = {
  async loadBdrisApps() {
    const box = document.getElementById('admBdrisApps');
    if (!box) return;
    try {
      const r = await ABC.api('/admin/bdris-applications');
      const d = await r.json();
      const apps = d.applications || [];
      if (!apps.length) { box.textContent = 'এখনো কোনো BDRIS আবেদন জমা হয়নি।'; return; }
      box.innerHTML = '<div class="tw"><table><thead><tr><th>আবেদন নম্বর</th><th>আবেদনকারী</th><th>গ্রাহক</th><th>সময়</th><th></th></tr></thead><tbody>' +
        apps.map(a =>
          '<tr><td>' + esc(a.ack_no) + '</td><td>' + esc(a.applicant_name || '') + '</td>' +
          '<td>' + esc(a.user_name || '') + ' <span class="s">' + esc(a.user_phone || '') + '</span></td>' +
          '<td class="s">' + new Date(a.created_at).toLocaleString('bn-BD') + '</td>' +
          '<td><button class="mini-btn danger" onclick="AdmOrders.deleteBdrisApp(' + jqAttr(a.id) + ')">🗑️ ডিলিট</button></td></tr>'
        ).join('') + '</tbody></table></div>';
    } catch (e) { box.textContent = 'লোড ব্যর্থ হয়েছে।'; }
  },
  async deleteBdrisApp(id) {
    if (!confirm('এই BDRIS আবেদনের রেকর্ড মুছে ফেলবেন? (আসল আবেদন সরকারি পোর্টালে থেকে যাবে — শুধু এখানের রেকর্ড মুছবে)')) return;
    const r = await ABC.api('/admin/bdris-applications/' + id, { method: 'DELETE' });
    if (!r.ok) { alert('ডিলিট ব্যর্থ হয়েছে'); return; }
    AdmOrders.loadBdrisApps();
  },
  copyData() {
    const t = TABS._viewRaw || '';
    if (!t) { alert('কপি করার মতো ডেটা নেই'); return; }
    navigator.clipboard.writeText(t).then(() => alert('✅ সব তথ্য সফলভাবে কপি হয়েছে')).catch(() => alert('কপি ব্যর্থ'));
  },

  copyVal(val) {
    if (!val) return;
    navigator.clipboard.writeText(String(val)).then(() => alert('✅ কপি হয়েছে: ' + val)).catch(() => alert('কপি ব্যর্থ'));
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

  async search(q) {
    TABS._q = (q || '').trim();
    show('orders');
  },

  clearSearch() {
    TABS._q = '';
    show('orders');
  },

  filterType(type) {
    TABS._orderType = type;
    show('orders');
  },

  async filter(s) {
    TABS._f = s;
    show('orders');
  },

  // Smart transition compliant with backend ORDER_TRANSITIONS
  async smartTransition(id, fromStatus, targetStatus, adminNote) {
    if (fromStatus === targetStatus) return true;
    const path = [];
    if (targetStatus === 'delivered') {
      if (fromStatus === 'new') path.push('processing', 'completed', 'delivered');
      else if (fromStatus === 'pending') path.push('processing', 'completed', 'delivered');
      else if (fromStatus === 'processing' || fromStatus === 'received' || fromStatus === 'registered') path.push('completed', 'delivered');
      else if (fromStatus === 'completed') path.push('delivered');
      else path.push('delivered');
    } else if (targetStatus === 'completed') {
      if (fromStatus === 'new') path.push('processing', 'completed');
      else if (fromStatus === 'pending') path.push('processing', 'completed');
      else if (fromStatus === 'processing' || fromStatus === 'received' || fromStatus === 'registered') path.push('completed');
      else path.push('completed');
    } else if (targetStatus === 'processing') {
      if (fromStatus === 'new' || fromStatus === 'pending') path.push('processing');
      else path.push('processing');
    } else {
      path.push(targetStatus);
    }

    for (const st of path) {
      const r = await ABC.api('/admin/orders/' + id + '/status', {
        method: 'PUT',
        body: { status: st, admin_note: adminNote || undefined }
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || ('স্ট্যাটাস পরিবর্তন ব্যর্থ (' + st + ')'));
      }
    }
    return true;
  },

  async setStatus(id, status, adminNote) {
    const o = (TABS._orders || []).find(x => x.id === id);
    const fromStatus = o ? o.status : 'new';
    try {
      await this.smartTransition(id, fromStatus, status, adminNote);
      alert('✅ অর্ডার স্ট্যাটাস সফলভাবে আপডেট করা হয়েছে (' + (STBN[status] || status) + ')');
      closeModal();
      show('orders');
    } catch (e) {
      alert('❌ ব্যর্থ: ' + e.message);
    }
  },

  async startProcessing(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    if (!confirm('অর্ডারটি গ্রহণ করে প্রসেসিং শুরু করতে চান?')) return;
    try {
      await this.smartTransition(id, o ? o.status : 'new', 'processing');
      alert('✅ অর্ডার গৃহীত ও প্রসেসিং শুরু হয়েছে');
      show('orders');
    } catch (e) {
      alert('❌ ব্যর্থ: ' + e.message);
    }
  },

  async markCompleted(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    if (!confirm('অর্ডারটির কাজ সম্পন্ন হিসেবে মার্ক করতে চান?')) return;
    try {
      await this.smartTransition(id, o ? o.status : 'processing', 'completed');
      alert('✅ অর্ডার সম্পন্ন মার্ক করা হয়েছে');
      closeModal();
      show('orders');
    } catch (e) {
      alert('❌ ব্যর্থ: ' + e.message);
    }
  },

  async markDelivered(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    if (!confirm('অর্ডারটি গ্রাহককে ডেলিভার্ড হিসেবে মার্ক করতে চান?')) return;
    try {
      await this.smartTransition(id, o ? o.status : 'completed', 'delivered');
      alert('✅ অর্ডার ডেলিভার্ড মার্ক করা হয়েছে এবং গ্রাহককে নোটিফিকেশন পাঠানো হয়েছে');
      closeModal();
      show('orders');
    } catch (e) {
      alert('❌ ব্যর্থ: ' + e.message);
    }
  },

  async cancelOrder(id) {
    const note = prompt('অর্ডার বাতিলের কারণ লিখুন (ঐচ্ছিক):');
    if (note === null) return;
    const o = (TABS._orders || []).find(x => x.id === id);
    try {
      const r = await ABC.api('/admin/orders/' + id + '/status', {
        method: 'PUT',
        body: { status: 'cancelled', admin_note: note || 'এডমিন কর্তৃক বাতিল' }
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'বাতিল ব্যর্থ');
      alert('অর্ডার বাতিল করা হয়েছে');
      closeModal();
      show('orders');
    } catch (e) {
      alert('❌ ব্যর্থ: ' + e.message);
    }
  },

  async refundOrder(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    if (!confirm('অর্ডারের মূল্য ৳' + bn(o ? o.price : 0) + ' গ্রাহকের ওয়ালেটে রিফান্ড ফেরত দিতে চান?')) return;
    try {
      const r = await ABC.api('/admin/orders/' + id + '/status', {
        method: 'PUT',
        body: { status: 'refunded', admin_note: 'এডমিন কর্তৃক ওয়ালেট রিফান্ড' }
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'রিফান্ড ব্যর্থ');
      alert('✅ অর্ডারের মূল্য সফলভাবে গ্রাহকের ওয়ালেটে রিফান্ড করা হয়েছে');
      closeModal();
      show('orders');
    } catch (e) {
      alert('❌ রিফান্ড ব্যর্থ: ' + e.message);
    }
  },

  deleteOrder(id) {
    const o = (TABS._orders || []).find(x => String(x.id) === String(id));
    const orderNum = o ? ('#' + String(o.id).slice(0, 8)) : ('#' + String(id).slice(0, 8));
    const price = o ? Number(o.price || 0) : 0;
    const userName = o ? (o.user_name || 'গ্রাহক') : 'গ্রাহক';
    const isRefundable = price > 0 && o && o.status !== 'refunded';

    let confirmHtml = '<div style="padding:10px 0;">' +
      '<div style="background:#fee2e2;border:1px solid #fca5a5;color:#991b1b;padding:12px;border-radius:8px;margin-bottom:14px;font-size:13px;line-height:1.5;">' +
        '⚠️ <b>সতর্কতা:</b> অর্ডার ' + esc(orderNum) + ' মুছে ফেললে এটি এবং এর সাথে সম্পর্কিত সব চ্যাট ও ডকুমেন্টস স্থায়ীভাবে ডাটাবেজ থেকে মুছে যাবে।' +
      '</div>' +
      '<div style="margin-bottom:16px;font-size:13px;line-height:1.6;color:var(--text-main);">' +
        '• <b>গ্রাহক:</b> ' + esc(userName) + '<br>' +
        '• <b>সেবা:</b> ' + esc(o ? (o.service_name_bn || o.service_name || 'সেবা') : 'সেবা') + '<br>' +
        '• <b>অর্ডারের মূল্য:</b> <span class="adm-price-badge" style="font-size:13px;padding:2px 8px;">৳' + bn(price) + '</span><br>' +
        '• <b>বর্তমান স্ট্যাটাস:</b> <b>' + esc(o ? (STBN[o.status] || o.status) : '') + '</b>' +
      '</div>';

    if (isRefundable) {
      confirmHtml += '<div style="margin-bottom:14px;font-weight:700;font-size:13px;color:var(--text-main);">ডিলিট করার ধরণ বেছে নিন:</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<button class="btn-quick-emerald" style="padding:12px;font-size:13px;text-align:center;" onclick="AdmOrders.confirmDelete(\'' + id + '\', true)">' +
            '💰 ৳' + bn(price) + ' রিফান্ড দিয়ে ডিলিট করুন (গ্রাহকের ওয়ালেটে টাকা ফেরত যাবে)' +
          '</button>' +
          '<button class="mini-btn danger" style="padding:12px;font-size:13px;text-align:center;" onclick="AdmOrders.confirmDelete(\'' + id + '\', false)">' +
            '🗑️ কোনো রিফান্ড ছাড়া সরাসরি ডিলিট করুন (টেস্ট/ফেক অর্ডারের জন্য)' +
          '</button>' +
          '<button class="btn-secondary" style="padding:10px;text-align:center;" onclick="closeModal()">✕ ফিরে যান</button>' +
        '</div>';
    } else {
      confirmHtml += '<div style="display:flex;gap:10px;justify-content:flex-end;">' +
        '<button class="btn-secondary" onclick="closeModal()">✕ বাতিল</button>' +
        '<button class="mini-btn danger" style="padding:10px 18px;" onclick="AdmOrders.confirmDelete(\'' + id + '\', false)">🗑️ নিশ্চিতভাবে মুছে ফেলুন</button>' +
      '</div>';
    }
    confirmHtml += '</div>';

    modal('🗑️ অর্ডার মুছে ফেলার কনফার্মেশন ' + esc(orderNum), confirmHtml);
  },

  async confirmDelete(id, refund) {
    try {
      const q = refund ? '?refund=yes' : '?refund=no';
      const r = await ABC.api('/admin/orders/' + id + q, { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'অর্ডার মুছতে ব্যর্থ');
      alert(refund ? '✅ অর্ডারের মূল্য রিফান্ড করে সফলভাবে মুছে ফেলা হয়েছে' : '✅ অর্ডার সফলভাবে মুছে ফেলা হয়েছে');
      closeModal();
      show('orders');
    } catch (e) {
      alert('❌ মুছে ফেলা ব্যর্থ: ' + e.message);
    }
  },

  async saveAdminNote(id) {
    const note = document.getElementById('admOrderNoteInput');
    if (!note) return;
    const txt = note.value.trim();
    const o = (TABS._orders || []).find(x => x.id === id);
    try {
      const r = await ABC.api('/admin/orders/' + id + '/status', {
        method: 'PUT',
        body: { status: o ? o.status : 'processing', admin_note: txt }
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'নোট সংরক্ষণ ব্যর্থ');
      alert('✅ এডমিন নোট সংরক্ষিত হয়েছে');
    } catch (e) {
      alert('❌ সংরক্ষণ ব্যর্থ: ' + e.message);
    }
  },

  openQuickComplete(id) {
    this.view(id);
  },

  view(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    if (!o) { alert('অর্ডার পাওয়া যায়নি'); return; }

    // Parse Submitted Form Data
    let dataCardsHtml = '';
    let rawText = 'অর্ডার: ' + (o.service_name_bn || o.service_name || '') + '\n' +
      'গ্রাহক: ' + (o.user_name || '') + ' (' + (o.user_phone || '') + ')\n\n--- ফর্ম ডেটা ---\n';

    try {
      const data = typeof o.data === 'string' ? JSON.parse(o.data) : (o.data || {});
      let manualFormHtml = '';
      if (data._manual_form) {
        manualFormHtml = '<div style="margin:12px 0;padding:14px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">' +
          '<div style="font-weight:700;margin-bottom:8px;color:#166534;display:flex;justify-content:space-between;align-items:center;">' +
            '<span>📝 ইউজার কর্তৃক পূরণকৃত আবেদন</span>' +
            '<button onclick="AdmOrders.copyVal(' + jqAttr(String(data._manual_form)).replace(/</g, '\\u003c') + ')" class="mini-btn ok">📋 কপি করুন</button>' +
          '</div>' +
          '<pre style="white-space:pre-wrap;font-family:monospace;font-size:13px;margin:0;color:#1e293b;">' + esc(String(data._manual_form)) + '</pre>' +
        '</div>';
        rawText += String(data._manual_form) + '\n';
        delete data._manual_form;
      }

      const entries = Object.entries(data);
      if (entries.length) {
        dataCardsHtml = '<div class="adm-fields-grid">' +
          entries.map(([k, v]) => {
            const label = ORDER_LABELS_BN[k] || String(k).replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
            const val = String(v == null ? '' : v).trim();
            rawText += label + ': ' + val + '\n';
            return '<div class="adm-field-card">' +
              '<div class="adm-field-head">' +
                '<span class="adm-field-label">' + esc(label) + '</span>' +
                '<button class="adm-copy-chip" onclick="AdmOrders.copyVal(' + jqAttr(val).replace(/</g, '\\u003c') + ')">📋 কপি</button>' +
              '</div>' +
              '<div class="adm-field-val">' + (val ? esc(val) : '<span style="color:#94a3b8;font-weight:normal;">(খালি)</span>') + '</div>' +
            '</div>';
          }).join('') +
        '</div>';
      } else if (!manualFormHtml) {
        dataCardsHtml = '<div style="color:var(--text-muted);padding:10px 0;">কোনো ফর্ম ডেটা জমা দেওয়া হয়নি</div>';
      }
      dataCardsHtml = manualFormHtml + dataCardsHtml;
      TABS._viewRaw = rawText;
    } catch (e) {
      dataCardsHtml = '<div style="color:var(--danger);padding:10px 0;">ডেটা প্রসেস করতে ব্যর্থ</div>';
    }

    // Customer Attached Documents
    let docsHtml = '';
    try {
      const docs = typeof o.documents === 'string' ? JSON.parse(o.documents || '[]') : (o.documents || []);
      const userDocs = docs.filter(d => !d.uploaded_by || d.uploaded_by === 'user');
      const adminDocs = docs.filter(d => d.uploaded_by === 'admin' || d.type === 'delivery');

      if (userDocs.length) {
        docsHtml = '<div class="adm-docs-grid">' +
          userDocs.map((d, i) => {
            const origIdx = docs.indexOf(d);
            return '<div class="adm-doc-card">' +
              '<div style="display:flex;align-items:center;gap:8px;overflow:hidden;">' +
                '<span style="font-size:22px;">📎</span>' +
                '<div style="overflow:hidden;">' +
                  '<div style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="' + esc(d.originalname || d.filename) + '">' +
                    esc(d.originalname || d.filename || 'ডকুমেন্ট') +
                  '</div>' +
                  '<div style="font-size:10px;color:var(--text-muted);">গ্রাহকের ফাইল</div>' +
                '</div>' +
              '</div>' +
              '<button class="mini-btn ok" onclick="AdmOrders.dlDoc(\'' + o.id + '\',' + origIdx + ')">⬇️ ডাউনলোড</button>' +
            '</div>';
          }).join('') +
        '</div>';
      } else {
        docsHtml = '<div style="color:var(--text-muted);font-size:13px;padding:6px 0;">গ্রাহক কোনো ডকুমেন্ট যুক্ত করেননি</div>';
      }

      let adminDocsHtml = '';
      if (adminDocs.length) {
        adminDocsHtml = '<div style="margin-top:14px;"><div style="font-weight:700;font-size:13px;color:#059669;margin-bottom:6px;">📤 ইতিমধ্যে ডেলিভারিকৃত ডকুমেন্ট:</div><div class="adm-docs-grid">' +
          adminDocs.map((d, i) => {
            const origIdx = docs.indexOf(d);
            return '<div class="adm-doc-card" style="border-color:#a7f3d0;background:#f0fdf4;">' +
              '<div style="display:flex;align-items:center;gap:8px;overflow:hidden;">' +
                '<span style="font-size:22px;">✅</span>' +
                '<div style="overflow:hidden;">' +
                  '<div style="font-weight:600;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(d.originalname || d.filename) + '</div>' +
                  '<div style="font-size:10px;color:#16a34a;">ডেলিভারি ফাইল</div>' +
                '</div>' +
              '</div>' +
              '<button class="mini-btn ok" onclick="AdmOrders.dlDoc(\'' + o.id + '\',' + origIdx + ')">⬇️ ডাউনলোড</button>' +
            '</div>';
          }).join('') +
        '</div></div>';
      }
      docsHtml += adminDocsHtml;
      TABS._viewDocs = docs;
    } catch (e) {
      docsHtml = '<div style="color:var(--danger);font-size:13px;">ডকুমেন্ট তালিকা লোড ব্যর্থ</div>';
    }

    // Visual Pipeline Stepper
    const stepOrder = ['new', 'processing', 'completed', 'delivered'];
    const curStatus = o.status || 'new';
    let activeIdx = stepOrder.indexOf(curStatus);
    if (curStatus === 'pending') activeIdx = 0;
    if (curStatus === 'received' || curStatus === 'registered') activeIdx = 1;
    if (activeIdx === -1 && curStatus === 'completed') activeIdx = 2;
    if (activeIdx === -1 && curStatus === 'delivered') activeIdx = 3;

    const pipelineHtml = '<div class="adm-pipeline-steps">' +
      '<div class="adm-step-item' + (activeIdx >= 0 ? (activeIdx === 0 ? ' active' : ' done') : '') + '">' +
        '<div class="adm-step-dot">' + (activeIdx > 0 ? '✓' : '১') + '</div>' +
        '<div class="adm-step-label">নতুন অর্ডার</div>' +
      '</div>' +
      '<div style="flex:1;height:2px;background:' + (activeIdx >= 1 ? '#16a34a' : '#cbd5e1') + ';margin:0 8px;"></div>' +
      '<div class="adm-step-item' + (activeIdx >= 1 ? (activeIdx === 1 ? ' active' : ' done') : '') + '">' +
        '<div class="adm-step-dot">' + (activeIdx > 1 ? '✓' : '২') + '</div>' +
        '<div class="adm-step-label">প্রসেসিং</div>' +
      '</div>' +
      '<div style="flex:1;height:2px;background:' + (activeIdx >= 2 ? '#16a34a' : '#cbd5e1') + ';margin:0 8px;"></div>' +
      '<div class="adm-step-item' + (activeIdx >= 2 ? (activeIdx === 2 ? ' active' : ' done') : '') + '">' +
        '<div class="adm-step-dot">' + (activeIdx > 2 ? '✓' : '৩') + '</div>' +
        '<div class="adm-step-label">সম্পন্ন</div>' +
      '</div>' +
      '<div style="flex:1;height:2px;background:' + (activeIdx >= 3 ? '#16a34a' : '#cbd5e1') + ';margin:0 8px;"></div>' +
      '<div class="adm-step-item' + (activeIdx >= 3 ? ' active done' : '') + '">' +
        '<div class="adm-step-dot">' + (activeIdx >= 3 ? '✓' : '৪') + '</div>' +
        '<div class="adm-step-label">ডেলিভার্ড</div>' +
      '</div>' +
    '</div>';

    // Action Hub (Clear, prominent controls for completion & delivery)
    let actionHubHtml = '';
    if (curStatus === 'new' || curStatus === 'pending') {
      actionHubHtml = '<div class="adm-hub-card">' +
        '<div class="adm-hub-title">' +
          '<span>🎯 পরবর্তী অ্যাকশন: অর্ডার গ্রহণ</span>' +
          '<span class="st-badge st-' + curStatus + '">' + (STBN[curStatus] || curStatus) + '</span>' +
        '</div>' +
        '<p style="color:var(--text-muted);font-size:12px;margin:4px 0 10px;">গ্রাহকের প্রদত্ত তথ্য পরীক্ষা করুন এবং কাজ শুরু করার জন্য গ্রহণ করুন।</p>' +
        '<div class="adm-hub-actions">' +
          '<button class="btn-quick-primary" style="padding:10px 18px;font-size:13px;" onclick="AdmOrders.startProcessing(\'' + o.id + '\')">▶️ অর্ডার গ্রহণ ও প্রসেসিং শুরু করুন</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.cancelOrder(\'' + o.id + '\')">❌ বাতিল করুন</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.deleteOrder(\'' + o.id + '\')">🗑️ মুছে ফেলুন</button>' +
        '</div>' +
      '</div>';
    } else if (curStatus === 'processing' || curStatus === 'received' || curStatus === 'registered') {
      actionHubHtml = '<div class="adm-hub-card" style="border-left-color:#16a34a;background:linear-gradient(135deg, #f0fdf4, #ffffff);">' +
        '<div class="adm-hub-title" style="color:#166534;">' +
          '<span>🎯 অর্ডার ডেলিভারি ও সমাপ্তকরণ</span>' +
          '<span class="st-badge st-processing">প্রসেসিং চলছে</span>' +
        '</div>' +
        '<p style="color:var(--text-muted);font-size:12px;margin:4px 0 10px;">গ্রাহককে প্রস্তুতকৃত ডকুমেন্ট (PDF/ছবি) ডেলিভারি দিন অথবা সরাসরি কাজ সম্পন্ন মার্ক করুন।</p>' +

        '<!-- Delivery File Box -->' +
        '<div style="background:#ffffff;border:2px dashed #bbf7d0;border-radius:8px;padding:14px;text-align:center;margin-bottom:12px;">' +
          '<input type="file" id="admModalDeliFile" accept=".pdf,.jpg,.jpeg,.png" style="display:none;" onchange="AdmOrders.modalFileSelected(this)">' +
          '<div id="admModalDeliPreview" style="color:var(--text-muted);font-size:13px;">' +
            '📄 ডেলিভারি ফাইল যুক্ত করুন (PDF, JPG, PNG)<br>' +
            '<button class="mini-btn" style="margin-top:6px;" onclick="document.getElementById(\'admModalDeliFile\').click()">📁 ফাইল বেছে নিন</button>' +
          '</div>' +
        '</div>' +

        '<div class="adm-hub-actions">' +
          '<button class="btn-quick-emerald" id="admModalUploadDeliverBtn" style="padding:10px 18px;font-size:13px;" onclick="AdmOrders.modalDeliverWithFile(\'' + o.id + '\')" disabled>🚀 ডেলিভারি ফাইল আপলোড ও সমাপ্ত করুন</button>' +
          '<button class="btn-quick-success" style="padding:10px 18px;font-size:13px;" onclick="AdmOrders.markCompleted(\'' + o.id + '\')">✅ ফাইল ছাড়া সম্পন্ন মার্ক করুন</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.cancelOrder(\'' + o.id + '\')">❌ বাতিল/ব্যর্থ</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.deleteOrder(\'' + o.id + '\')">🗑️ মুছে ফেলুন</button>' +
        '</div>' +
      '</div>';
    } else if (curStatus === 'completed') {
      actionHubHtml = '<div class="adm-hub-card" style="border-left-color:#059669;background:linear-gradient(135deg, #ecfdf5, #ffffff);">' +
        '<div class="adm-hub-title" style="color:#065f46;">' +
          '<span>🎯 অর্ডার সম্পন্ন: গ্রাহককে ডেলিভার্ড মার্ক করুন</span>' +
          '<span class="st-badge st-completed">সম্পন্ন</span>' +
        '</div>' +
        '<p style="color:var(--text-muted);font-size:12px;margin:4px 0 10px;">অর্ডারটির কাজ সম্পন্ন হয়েছে। গ্রাহককে চূড়ান্ত ডেলিভারি কনফার্ম করুন।</p>' +
        '<div class="adm-hub-actions">' +
          '<button class="btn-quick-emerald" style="padding:10px 18px;font-size:13px;" onclick="AdmOrders.markDelivered(\'' + o.id + '\')">🚀 ডেলিভার্ড মার্ক করুন ও নোটিফিকেশন দিন</button>' +
          '<button class="mini-btn" onclick="AdmOrders.deliForm(\'' + o.id + '\')">📎 অতিরিক্ত ডেলিভারি ফাইল যোগ করুন</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.refundOrder(\'' + o.id + '\')">↩️ রিফান্ড করুন</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.deleteOrder(\'' + o.id + '\')">🗑️ মুছে ফেলুন</button>' +
        '</div>' +
      '</div>';
    } else if (curStatus === 'delivered') {
      actionHubHtml = '<div class="adm-hub-card" style="border-left-color:#10b981;background:#f0fdf4;">' +
        '<div class="adm-hub-title" style="color:#065f46;">' +
          '<span>🎉 অর্ডার সফলভাবে ডেলিভার্ড সম্পন্ন</span>' +
          '<span class="st-badge st-delivered">ডেলিভার্ড</span>' +
        '</div>' +
        '<p style="color:#166534;font-size:12px;margin:4px 0 10px;">গ্রাহক ইতিমধ্যে তাঁর ডেলিভারি ডকুমেন্ট পেয়েছেন এবং কাজ সম্পন্ন হয়েছে।</p>' +
        '<div class="adm-hub-actions">' +
          '<button class="mini-btn" onclick="AdmOrders.deliForm(\'' + o.id + '\')">📎 অতিরিক্ত ফাইল সংযোজন</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.refundOrder(\'' + o.id + '\')">↩️ রিফান্ড করুন</button>' +
          '<button class="mini-btn danger" onclick="AdmOrders.deleteOrder(\'' + o.id + '\')">🗑️ মুছে ফেলুন</button>' +
        '</div>' +
      '</div>';
    }

    const bodyHtml = '<div class="adm-modal-content">' +
      '<!-- Top Info Box -->' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;border-bottom:1px solid var(--border-light);padding-bottom:14px;margin-bottom:14px;">' +
        '<div>' +
          '<div style="font-size:18px;font-weight:800;color:var(--primary-800);">' + esc(o.service_name_bn || o.service_name || 'সেবা') + '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;margin-top:4px;font-size:13px;color:var(--text-muted);">' +
            '<span>👤 <b>' + esc(o.user_name || 'গ্রাহক') + '</b></span> • ' +
            '<span>📞 <a href="tel:' + esc(o.user_phone) + '" style="color:var(--primary-600);text-decoration:none;font-weight:600;">' + esc(o.user_phone) + '</a></span> • ' +
            '<span><a href="https://wa.me/' + esc(String(o.user_phone).replace(/[^0-9]/g, '')) + '" target="_blank" style="color:#16a34a;text-decoration:none;font-weight:700;">💬 WhatsApp</a></span>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">🕘 জমাদানের তারিখ: ' + new Date(o.created_at).toLocaleString('bn-BD') + '</div>' +
        '</div>' +
        '<div style="text-align:right;">' +
          '<div class="adm-price-badge" style="font-size:16px;padding:4px 14px;">৳' + bn(o.price) + '</div>' +
          '<div style="margin-top:6px;"><button class="mini-btn" onclick="AdmOrders.copyData()">📋 সব তথ্য কপি</button></div>' +
        '</div>' +
      '</div>' +

      pipelineHtml +
      actionHubHtml +

      '<!-- Submitted Data Grid -->' +
      '<div style="margin-top:16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
          '<div style="font-size:14px;font-weight:800;color:var(--primary-800);">📝 গ্রাহকের পূরণকৃত তথ্য (১-ক্লিক কপি)</div>' +
          '<button class="adm-copy-chip" onclick="AdmOrders.copyData()">📋 পুরো ফর্ম কপি</button>' +
        '</div>' +
        dataCardsHtml +
      '</div>' +

      '<!-- Uploaded Documents -->' +
      '<div style="margin-top:20px;">' +
        '<div style="font-size:14px;font-weight:800;color:var(--primary-800);margin-bottom:8px;">📎 গ্রাহক ও ডেলিভারি ডকুমেন্টসমূহ</div>' +
        docsHtml +
      '</div>' +

      '<!-- Admin Notes -->' +
      '<div style="margin-top:20px;background:#f8fafc;padding:14px;border-radius:8px;border:1px solid var(--border-light);">' +
        '<div style="font-weight:700;font-size:13px;margin-bottom:6px;color:var(--text-main);">👨‍💼 এডমিন ইন্টারনাল নোট (শুধুমাত্র এডমিনদের জন্য দৃশ্যমান):</div>' +
        '<div style="display:flex;gap:6px;">' +
          '<input type="text" id="admOrderNoteInput" value="' + esc(o.admin_note || '') + '" placeholder="এখানে ইন্টারনাল নোট লিখুন..." style="flex:1;font-size:12px;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px;">' +
          '<button class="mini-btn ok" style="padding:8px 14px;font-size:12px;" onclick="AdmOrders.saveAdminNote(\'' + o.id + '\')">💾 নোট সংরক্ষণ</button>' +
        '</div>' +
      '</div>' +

      '<!-- Customer Support & Live Messaging (Phase 3) -->' +
      '<div style="margin-top:18px;background:#fff;border:1px solid #bfdbfe;border-radius:10px;padding:16px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
          '<div style="font-weight:800;font-size:13px;color:var(--primary-800);">💬 কাস্টমার সাপোর্ট ও লাইভ চ্যাট মেসেজ</div>' +
          '<span class="st-badge st-processing">সরাসরি যোগাযোগ</span>' +
        '</div>' +
        '<div style="margin-bottom:8px;">' +
          '<div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:5px;">⚡ দ্রুত রেডিমেড টেমপ্লেট পাঠান (১-ক্লিক):</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;">' +
            '<button class="adm-icon-btn" onclick="AdmOrders.useInModalTpl(\'' + o.id + '\', \'🌐 সাময়িক সার্ভার সমস্যার কারণে কিছুটা বিলম্ব হচ্ছে, অনুগ্রহ করে অপেক্ষা করুন।\')">🌐 সার্ভার সমস্যা</button>' +
            '<button class="adm-icon-btn" onclick="AdmOrders.useInModalTpl(\'' + o.id + '\', \'⏳ আপনার অর্ডারের কাজ প্রসেসিং চলছে। অতি শীঘ্রই ডেলিভারি পাবেন।\')">⏳ কাজ চলছে</button>' +
            '<button class="adm-icon-btn" onclick="AdmOrders.useInModalTpl(\'' + o.id + '\', \'📄 অনুগ্রহ করে সঠিক তথ্য অথবা ক্লিয়ার ডকুমেন্টটি দিন।\')">📄 ডকুমেন্ট সমস্যা</button>' +
            '<button class="adm-icon-btn" onclick="AdmOrders.useInModalTpl(\'' + o.id + '\', \'✅ আপনার অর্ডারটি সফলভাবে সম্পন্ন হয়েছে। ফাইলটি ডাউনলোড করুন।\')">✅ কাজ সম্পন্ন</button>' +
            '<button class="adm-icon-btn" onclick="AdmOrders.useInModalTpl(\'' + o.id + '\', \'💰 আপনার পেমেন্ট যাচাই সম্পন্ন হয়েছে।\')">💰 পেমেন্ট নিশ্চিত</button>' +
          '</div>' +
        '</div>' +
        '<div id="admOrderChatThread_' + o.id + '" class="adm-chat-thread">' +
          '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:10px;">মেসেজ লোড হচ্ছে...</div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:10px;">' +
          '<input type="text" id="admInModalSupMsg_' + o.id + '" placeholder="গ্রাহককে সরাসরি মেসেজ লিখুন..." style="flex:1;font-size:12px;padding:8px 12px;border:1px solid #cbd5e1;border-radius:7px;" onkeydown="if(event.key===\'Enter\') AdmOrders.sendInModalSupport(\'' + o.id + '\')">' +
          '<button class="btn-quick-primary" style="padding:8px 16px;font-size:12px;" onclick="AdmOrders.sendInModalSupport(\'' + o.id + '\')">পাঠান ➤</button>' +
        '</div>' +
      '</div>' +

      '<!-- Order Status Timeline & Audit Trail (Phase 3) -->' +
      '<div class="adm-timeline-box" style="margin-top:18px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<div style="font-weight:800;font-size:13px;color:var(--primary-800);">📜 অর্ডার স্ট্যাটাস ও অডিট হিস্ট্রি টাইমলাইন</div>' +
          '<button class="mini-btn" onclick="AdmOrders.loadHistory(\'' + o.id + '\')">🔄 রিফ্রেশ</button>' +
        '</div>' +
        '<div id="admOrderTimeline_' + o.id + '" class="adm-timeline-list">' +
          '<div style="font-size:11px;color:var(--text-muted);">হিস্ট্রি লোড হচ্ছে...</div>' +
        '</div>' +
      '</div>' +

      '<div style="margin-top:20px;display:flex;justify-content:space-between;align-items:center;">' +
        '<button class="mini-btn danger" onclick="AdmOrders.deleteOrder(\'' + o.id + '\')">🗑️ এই অর্ডারটি মুছে ফেলুন</button>' +
        '<button class="btn-secondary" onclick="closeModal()">✕ বন্ধ করুন</button>' +
      '</div>' +
    '</div>';

    modal('📦 অর্ডার প্রসেসিং ও ডেলিভারি হাব - #' + esc(String(o.id).slice(0, 8)), bodyHtml);
    window._modalDeliFile = null;
    setTimeout(() => {
      AdmOrders.loadHistory(o.id);
      AdmOrders.loadInModalChat(o.id);
    }, 60);
  },

  
  async loadHistory(orderId) {
    const el = document.getElementById('admOrderTimeline_' + orderId);
    if (!el) return;
    try {
      const r = await ABC.api('/admin/orders/' + orderId + '/history');
      if (!r.ok) throw new Error('ইতিহাস লোড করা যায়নি');
      const d = await r.json();
      const list = d.history || [];
      if (!list.length) {
        el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:4px 0;">এখনো কোনো স্ট্যাটাস পরিবর্তন হয়নি।</div>';
        return;
      }
      el.innerHTML = list.map(item => {
        const fromSt = item.from_status ? (STBN[item.from_status] || item.from_status) : 'শুরু';
        const toSt = item.to_status ? (STBN[item.to_status] || item.to_status) : '—';
        const dateStr = item.created_at ? new Date(item.created_at).toLocaleString('bn-BD') : '—';
        const adminName = item.admin_name || 'সিস্টেম এডমিন';
        const note = item.note ? ('<div style="color:#334155;margin-top:2px;font-style:italic;">নোট: ' + esc(item.note) + '</div>') : '';
        return '<div class="adm-timeline-item">' +
          '<div class="adm-timeline-dot"></div>' +
          '<div class="adm-timeline-title">' +
            '<span class="st-badge st-' + (item.from_status || 'new') + '" style="font-size:9px;padding:2px 6px;">' + esc(fromSt) + '</span>' +
            ' ➔ ' +
            '<span class="st-badge st-' + (item.to_status || 'processing') + '" style="font-size:9px;padding:2px 6px;">' + esc(toSt) + '</span>' +
          '</div>' +
          '<div class="adm-timeline-meta">' +
            '<span>🕒 ' + esc(dateStr) + '</span> • <span>👤 <b>' + esc(adminName) + '</b></span>' +
          '</div>' +
          note +
        '</div>';
      }).join('');
    } catch (e) {
      el.innerHTML = '<div style="font-size:11px;color:var(--danger);">ইতিহাস লোড ব্যর্থ: ' + esc(e.message) + '</div>';
    }
  },

  async loadInModalChat(orderId) {
    const el = document.getElementById('admOrderChatThread_' + orderId);
    if (!el) return;
    try {
      const r = await ABC.api('/admin/orders/' + orderId + '/support-messages');
      if (!r.ok) throw new Error('মেসেজ লোড ব্যর্থ');
      const d = await r.json();
      const msgs = (d.messages || []).slice().reverse(); // Show chronological
      if (!msgs.length) {
        el.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:12px;">গ্রাহকের সাথে এখনো কোনো কথোপকথন শুরু হয়নি।</div>';
        return;
      }
      el.innerHTML = msgs.map(m => {
        const isAdmin = !!m.admin_id;
        const senderLabel = isAdmin ? (m.admin_name || 'এডমিন') : 'গ্রাহক';
        const timeStr = m.created_at ? new Date(m.created_at).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '';
        return '<div class="adm-chat-bubble ' + (isAdmin ? 'from-admin' : 'from-user') + '">' +
          '<div style="font-weight:700;font-size:10px;opacity:0.8;margin-bottom:2px;">' + esc(senderLabel) + ':</div>' +
          '<div>' + esc(m.message) + '</div>' +
          '<div class="adm-chat-meta">' + esc(timeStr) + '</div>' +
        '</div>';
      }).join('');
      el.scrollTop = el.scrollHeight;
    } catch (e) {
      el.innerHTML = '<div style="font-size:11px;color:var(--danger);text-align:center;">চ্যাট লোড ব্যর্থ: ' + esc(e.message) + '</div>';
    }
  },

  useInModalTpl(orderId, text) {
    const inp = document.getElementById('admInModalSupMsg_' + orderId);
    if (inp) {
      inp.value = text;
      inp.focus();
    }
  },

  async sendInModalSupport(orderId) {
    const inp = document.getElementById('admInModalSupMsg_' + orderId);
    if (!inp) return;
    const msg = inp.value.trim();
    if (!msg) { alert('মেসেজ লিখুন'); return; }
    try {
      inp.disabled = true;
      const r = await ABC.api('/admin/orders/' + orderId + '/support-message', {
        method: 'POST',
        body: { message: msg }
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'পাঠানো যায়নি');
      inp.value = '';
      inp.disabled = false;
      this.loadInModalChat(orderId);
    } catch (e) {
      alert('মেসেজ পাঠানো ব্যর্থ: ' + e.message);
      inp.disabled = false;
    }
  },

  modalFileSelected(inp) {
    const f = inp.files[0];
    if (!f) return;
    window._modalDeliFile = f;
    const pv = document.getElementById('admModalDeliPreview');
    const btn = document.getElementById('admModalUploadDeliverBtn');
    if (pv) {
      pv.innerHTML = '<span style="font-size:20px;">✅</span> <b>' + esc(f.name) + '</b> (' + Math.round(f.size / 1024) + ' KB)' +
        '<br><button class="mini-btn danger" style="margin-top:6px;" onclick="AdmOrders.modalFileClear()">বাদ দিন</button>';
    }
    if (btn) btn.disabled = false;
  },

  modalFileClear() {
    window._modalDeliFile = null;
    const inp = document.getElementById('admModalDeliFile');
    const pv = document.getElementById('admModalDeliPreview');
    const btn = document.getElementById('admModalUploadDeliverBtn');
    if (inp) inp.value = '';
    if (pv) pv.innerHTML = '📄 ডেলিভারি ফাইল যুক্ত করুন (PDF, JPG, PNG)<br><button class="mini-btn" style="margin-top:6px;" onclick="document.getElementById(\'admModalDeliFile\').click()">📁 ফাইল বেছে নিন</button>';
    if (btn) btn.disabled = true;
  },

  async modalDeliverWithFile(id) {
    const f = window._modalDeliFile;
    if (!f) { alert('ফাইল বেছে নিন'); return; }
    const btn = document.getElementById('admModalUploadDeliverBtn');
    if (btn) { btn.disabled = true; btn.innerText = 'আপলোড ও ডেলিভারি হচ্ছে…'; }

    try {
      // 1. Upload delivery doc
      const fd = new FormData();
      fd.append('file', f);
      fd.append('doc_type', 'delivery');
      const r = await fetch('/api/admin/orders/' + id + '/delivery-docs', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + getAuthToken() },
        body: fd
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'ডেলিভারি ফাইল আপলোড ব্যর্থ');

      // 2. Advance status smoothly to delivered
      const o = (TABS._orders || []).find(x => x.id === id);
      await this.smartTransition(id, o ? o.status : 'processing', 'delivered');

      alert('✅ ডেলিভারি ফাইল সফলভাবে গ্রাহকের কাছে পৌঁছে গেছে এবং অর্ডারটি ডেলিভার্ড সম্পন্ন হয়েছে!');
      closeModal();
      show('orders');
    } catch (e) {
      alert('❌ ডেলিভারি ব্যর্থ: ' + e.message);
      if (btn) { btn.disabled = false; btn.innerText = '🚀 ডেলিভারি ফাইল আপলোড ও সমাপ্ত করুন'; }
    }
  },

  async deliForm(id) {
    const o = (TABS._orders || []).find(x => x.id === id);
    modal('📎 ডেলিভারি ডকুমেন্ট আপলোড',
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
      headers: { 'Authorization': 'Bearer ' + getAuthToken() },
      body: fd
    });
    const d = await r.json();
    if (r.ok) {
      alert('✅ ডকুমেন্ট আপলোড হয়েছে');
      const o = (TABS._orders || []).find(x => x.id === id);
      if (o && o.status !== 'delivered') {
        if (confirm('অর্ডার স্ট্যাটাস "ডেলিভার্ড" সম্পন্ন করতে চান?')) {
          try {
            await this.smartTransition(id, o.status, 'delivered');
          } catch (e) {
            alert('স্ট্যাটাস আপডেট ব্যর্থ: ' + e.message);
          }
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
 '.mp-sec{margin-bottom:14px;border:1px solid var(--border-light, #e2e8f0);border-radius:12px;overflow:hidden;background:#ffffff;box-shadow:0 1px 3px rgba(0,0,0,0.05);}' +
 '.mp-title{background:linear-gradient(135deg, #1e3a8a, #0284c7);color:#ffffff;font-weight:700;padding:10px 14px;font-size:14px;letter-spacing:.3px;}' +
 '.mp-table{width:100%;border-collapse:collapse;}' +
 '.mp-table td{padding:9px 14px;border-top:1px solid #f1f5f9;font-size:13px;vertical-align:top;}' +
 '.mp-table tr:first-child td{border-top:none;}' +
 '.mp-key{color:#64748b;width:38%;font-weight:600;}' +
 '.mp-val{color:#0f172a;}' +
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
    TABS._cats = catCache;
  } catch (e) { catCache = []; TABS._cats = []; }
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
   PREMIUM: Unified Services & Categories Hub
   - Single unified center for Auto Services, Manual Services & Categories
   - Sub-navigation: [ 📦 সেবা তালিকা ] & [ 📂 ক্যাটাগরি তালিকা ]
   - Metric stat counters (মোট, সক্রিয়, ম্যানুয়াল, অটোমেটেড)
   - Live search (বাংলা/ইংরেজি) + category pills + type pills
   - One-click duplicate/clone, inline status toggle, inline edit
   - Category ordering, edit, creation without leaving services
   ============================================================ */
TABS.services = async () => {
  await loadCats();
  const r = await ABC.api('/admin/services');
  const d = await r.json();
  const allServices = d.services || [];
  const cats = catCache || [];
  window._allAdminServices = allServices;

  const currentView = TABS._svcView || 'services';
  const totalCount = allServices.length;
  const activeCount = allServices.filter(s => s.status === 'active').length;
  const manualCount = allServices.filter(s => s.type === 'manual').length;
  const autoCount = allServices.filter(s => s.type === 'automated').length;

  let html = '<div class="adm-svc-hub">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap;border-bottom:1px solid #e2e8f0;padding-bottom:14px;">' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<button class="adm-tab-btn ' + (currentView === 'services' ? 'active' : '') + '" onclick="TABS._svcView=\'services\';show(\'services\')" style="font-size:13px;padding:9px 14px;">' +
          '<span>📦 সেবা তালিকা</span> <span class="adm-tab-chip">' + bn(totalCount) + '</span>' +
        '</button>' +
        '<button class="adm-tab-btn ' + (currentView === 'cats' ? 'active' : '') + '" onclick="TABS._svcView=\'cats\';show(\'services\')" style="font-size:13px;padding:9px 14px;">' +
          '<span>📂 ক্যাটাগরি তালিকা</span> <span class="adm-tab-chip">' + bn(cats.length) + '</span>' +
        '</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
        (currentView === 'services'
          ? '<button class="mini-btn ok" onclick="AdmSvc.createForm()" style="padding:9px 14px;font-weight:700;">+ নতুন সেবা</button>' +
            '<button class="mini-btn" onclick="TABS._svcView=\'cats\';show(\'services\')" style="padding:9px 14px;font-weight:700;">📂 ক্যাটাগরি সাজান</button>'
          : '<button class="mini-btn ok" onclick="AdmCat.createForm()" style="padding:9px 14px;font-weight:700;">+ নতুন ক্যাটাগরি</button>' +
            '<button class="mini-btn" onclick="TABS._svcView=\'services\';show(\'services\')" style="padding:9px 14px;font-weight:700;">← সেবা তালিকায় ফিরুন</button>'
        ) +
      '</div>' +
    '</div>';

  if (currentView === 'cats') {
    if (!cats.length) {
      html += '<div style="background:#ffffff;border:1px dashed #cbd5e1;border-radius:var(--r-xl);padding:40px 20px;text-align:center;color:#64748b;">' +
        '<div style="font-size:32px;margin-bottom:8px;">📁</div>' +
        '<b style="font-size:15px;color:#0f172a;">কোনো ক্যাটাগরি তৈরি করা হয়নি</b><br>' +
        '<span style="font-size:13px;">প্রথম ক্যাটাগরি তৈরি করুন (যেমন: জন্মনিবন্ধন সেবা, NID সেবা ইত্যাদি)।</span>' +
        '<div style="margin-top:14px;"><button class="mini-btn ok" onclick="AdmCat.createForm()">+ নতুন ক্যাটাগরি তৈরি করুন</button></div>' +
        '</div>';
    } else {
      html += '<div style="background:#ffffff;border:1px solid var(--border-light);border-radius:var(--r-xl);overflow:hidden;box-shadow:var(--shadow-xs);">' +
        '<table class="adm" style="margin:0;border:none;">' +
          '<thead>' +
            '<tr>' +
              '<th style="width:40px;text-align:center;">#</th>' +
              '<th style="width:50px;text-align:center;">আইকন</th>' +
              '<th>ক্যাটাগরির নাম</th>' +
              '<th style="text-align:center;">সেবা সংখ্যা</th>' +
              '<th style="text-align:center;">স্ট্যাটাস</th>' +
              '<th style="text-align:center;">ক্রম (Order)</th>' +
              '<th style="text-align:right;">কাজ</th>' +
            '</tr>' +
          '</thead>' +
          '<tbody>';

      cats.forEach((c, i) => {
        const isActive = c.status === 'active';
        html += '<tr>' +
          '<td style="text-align:center;color:#64748b;font-weight:600;">' + bn(i + 1) + '</td>' +
          '<td style="text-align:center;font-size:24px;">' + esc(c.icon || '📁') + '</td>' +
          '<td>' +
            '<b style="font-size:14px;color:#0f172a;">' + esc(c.name_bn || c.name) + '</b>' +
            (c.name_bn && c.name && c.name_bn !== c.name ? '<br><small style="color:#64748b;">' + esc(c.name) + '</small>' : '') +
          '</td>' +
          '<td style="text-align:center;"><span class="badge" style="background:#f1f5f9;color:#334155;font-weight:700;">' + bn(c.service_count || 0) + 'টি</span></td>' +
          '<td style="text-align:center;"><span class="badge ' + (isActive ? 'st-active' : 'st-disabled') + '">' + (isActive ? '🟢 সক্রিয়' : '🔴 নিষ্ক্রিয়') + '</span></td>' +
          '<td style="text-align:center;">' +
            '<button class="mini-btn" onclick="AdmCat.move(\'' + c.id + '\',-1)"' + (i === 0 ? ' disabled' : '') + ' style="padding:4px 8px;">↑</button> ' +
            '<button class="mini-btn" onclick="AdmCat.move(\'' + c.id + '\',1)"' + (i === cats.length - 1 ? ' disabled' : '') + ' style="padding:4px 8px;">↓</button>' +
          '</td>' +
          '<td style="text-align:right;">' +
            '<button class="mini-btn" onclick="AdmCat.edit(\'' + c.id + '\')" style="margin-right:4px;">✏️ এডিট</button>' +
            '<button class="mini-btn danger" onclick="AdmCat.del(\'' + c.id + '\')">🗑️ ডিলিট</button>' +
          '</td>' +
        '</tr>';
      });

      html += '</tbody></table></div>' +
        '<div style="color:#64748b;margin-top:14px;font-size:12px;display:flex;align-items:center;gap:6px;">' +
          '<span>💡</span> ক্যাটাগরি ডিলিট করলে ভিতরের সেবাগুলো অক্ষত থাকবে — সেগুলো স্বয়ংক্রিয়ভাবে "অন্যান্য সেবা" ক্যাটাগরিতে স্থানান্তরিত হবে।' +
        '</div>';
    }
  } else {
    const activeCat = TABS._svcCatFilter || '';
    const activeType = TABS._svcTypeFilter || '';
    const searchQ = (TABS._svcSearch || '').trim().toLowerCase();

    const filtered = allServices.filter(s => {
      if (activeCat === '_uncat') {
        if (s.category_id && cats.some(c => c.id === s.category_id)) return false;
      } else if (activeCat && s.category_id !== activeCat) {
        return false;
      }
      if (activeType && s.type !== activeType) return false;
      if (searchQ) {
        const bnName = (s.name_bn || '').toLowerCase();
        const enName = (s.name || '').toLowerCase();
        const cat = (s.category_name_bn || s.category_name || '').toLowerCase();
        if (!bnName.includes(searchQ) && !enName.includes(searchQ) && !cat.includes(searchQ)) return false;
      }
      return true;
    });

    html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:20px;">' +
      '<div style="background:#ffffff;border:1px solid var(--border-light);border-radius:var(--r-lg);padding:14px;box-shadow:var(--shadow-xs);cursor:pointer;" onclick="TABS._svcTypeFilter=\'\';TABS._svcCatFilter=\'\';show(\'services\')">' +
        '<div style="font-size:12px;color:#64748b;font-weight:600;">মোট সেবা</div>' +
        '<div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:2px;">' + bn(totalCount) + '</div>' +
      '</div>' +
      '<div style="background:#ffffff;border:1px solid #bbf7d0;border-radius:var(--r-lg);padding:14px;box-shadow:var(--shadow-xs);">' +
        '<div style="font-size:12px;color:#166534;font-weight:600;">সক্রিয় সেবা</div>' +
        '<div style="font-size:22px;font-weight:800;color:#15803d;margin-top:2px;">' + bn(activeCount) + '</div>' +
      '</div>' +
      '<div style="background:#ffffff;border:1px solid #bfdbfe;border-radius:var(--r-lg);padding:14px;box-shadow:var(--shadow-xs);cursor:pointer;" onclick="TABS._svcTypeFilter=\'manual\';show(\'services\')" title="শুধু ম্যানুয়াল সেবা ফিল্টার">' +
        '<div style="font-size:12px;color:#1e40af;font-weight:600;">ম্যানুয়াল আবেদন</div>' +
        '<div style="font-size:22px;font-weight:800;color:#2563eb;margin-top:2px;">' + bn(manualCount) + '</div>' +
      '</div>' +
      '<div style="background:#ffffff;border:1px solid #e9d5ff;border-radius:var(--r-lg);padding:14px;box-shadow:var(--shadow-xs);cursor:pointer;" onclick="TABS._svcTypeFilter=\'automated\';show(\'services\')" title="শুধু অটো ইঞ্জিন সেবা ফিল্টার">' +
        '<div style="font-size:12px;color:#6b21a8;font-weight:600;">অটোমেটেড ইঞ্জিন</div>' +
        '<div style="font-size:22px;font-weight:800;color:#7c3aed;margin-top:2px;">' + bn(autoCount) + '</div>' +
      '</div>' +
    '</div>' +

    '<div style="background:#ffffff;border:1px solid var(--border-light);border-radius:var(--r-xl);padding:16px;margin-bottom:20px;box-shadow:var(--shadow-xs);">' +
      '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;margin-bottom:12px;">' +
        '<div style="flex:1;min-width:240px;position:relative;">' +
          '<input type="text" id="admSvcSearch" value="' + esc(TABS._svcSearch || '') + '" ' +
            'placeholder="🔍 সেবার নাম লিখে খুঁজুন (বাংলা বা ইংরেজি)..." ' +
            'style="width:100%;padding:10px 14px 10px 36px;border:1px solid #cbd5e1;border-radius:10px;font-size:14px;" ' +
            'oninput="AdmSvc.onSearch(this.value)">' +
          '<span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);color:#94a3b8;font-size:14px;">🔍</span>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<button class="mini-btn ok" onclick="AdmSvc.createForm()" style="padding:9px 14px;font-weight:700;">+ নতুন সেবা</button>' +
          '<button class="mini-btn" onclick="TABS._svcView=\'cats\';show(\'services\')" style="padding:9px 14px;font-weight:700;">📂 ক্যাটাগরি সাজান</button>' +
        '</div>' +
      '</div>' +

      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid #f1f5f9;padding-top:12px;">' +
        '<span style="font-size:12px;font-weight:700;color:#64748b;margin-right:4px;">ক্যাটাগরি:</span>' +
        '<button class="mini-btn' + (!activeCat ? ' ok' : '') + '" onclick="TABS._svcCatFilter=\'\';show(\'services\')">সব (' + bn(totalCount) + ')</button>';

    cats.forEach(c => {
      const cCount = allServices.filter(s => s.category_id === c.id).length;
      html += '<button class="mini-btn' + (activeCat === c.id ? ' ok' : '') + '" onclick="TABS._svcCatFilter=\'' + c.id + '\';show(\'services\')">' +
        esc(c.icon || '📁') + ' ' + esc(c.name_bn || c.name) + ' (' + bn(cCount) + ')</button>';
    });

    const uncatCount = allServices.filter(s => !s.category_id || !cats.some(c => c.id === s.category_id)).length;
    if (uncatCount > 0) {
      html += '<button class="mini-btn' + (activeCat === '_uncat' ? ' ok' : '') + '" onclick="TABS._svcCatFilter=\'_uncat\';show(\'services\')">📦 অন্যান্য (' + bn(uncatCount) + ')</button>';
    }

    html += '<button class="mini-btn" onclick="TABS._svcView=\'cats\';show(\'services\')" style="border-style:dashed;color:#2563eb;" title="ক্যাটাগরি সাজান বা নতুন ক্যাটাগরি যোগ করুন">⚙️ ক্যাটাগরি সাজান</button>' +
      '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;">' +
        '<span style="font-size:12px;font-weight:700;color:#64748b;margin-right:4px;">ধরন:</span>' +
        '<button class="mini-btn' + (!activeType ? ' ok' : '') + '" onclick="TABS._svcTypeFilter=\'\';show(\'services\')">সকল ধরন</button>' +
        '<button class="mini-btn' + (activeType === 'manual' ? ' ok' : '') + '" onclick="TABS._svcTypeFilter=\'manual\';show(\'services\')">📝 ম্যানুয়াল (' + bn(manualCount) + ')</button>' +
        '<button class="mini-btn' + (activeType === 'automated' ? ' ok' : '') + '" onclick="TABS._svcTypeFilter=\'automated\';show(\'services\')">⚡ অটোমেটেড (' + bn(autoCount) + ')</button>' +
      '</div>' +
    '</div>';

    if (!filtered.length) {
      html += '<div style="background:#ffffff;border:1px dashed #cbd5e1;border-radius:var(--r-xl);padding:40px 20px;text-align:center;color:#64748b;">' +
        '<div style="font-size:32px;margin-bottom:8px;">🔍</div>' +
        '<b style="font-size:16px;color:#0f172a;">কোনো সেবা পাওয়া যায়নি</b>' +
        '<p style="font-size:13px;margin-top:4px;">সার্চ বা ফিল্টার পরিবর্তন করুন অথবা নতুন সেবা যোগ করুন।</p>' +
        '</div>';
    } else {
      html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px;">';
      filtered.forEach(s => {
        const isManual = s.type === 'manual';
        const isActive = s.status === 'active';
        const cat = cats.find(c => c.id === s.category_id);
        const catName = cat ? (cat.name_bn || cat.name) : (s.category_name_bn || s.category_name || 'অন্যান্য');
        const catIcon = cat ? (cat.icon || '📁') : '📦';

        html += '<div style="background:#ffffff;border:1px solid ' + (isActive ? 'var(--border-light)' : '#fecaca') + ';border-radius:var(--r-lg);padding:16px;box-shadow:var(--shadow-xs);display:flex;flex-direction:column;justify-content:space-between;transition:box-shadow 0.2s;">' +
          '<div>' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:8px;">' +
              '<div style="display:flex;align-items:center;gap:10px;">' +
                '<span style="font-size:24px;background:#f1f5f9;width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:10px;">' + esc(s.icon || (isManual ? '📝' : '⚡')) + '</span>' +
                '<div>' +
                  '<h4 style="margin:0;font-size:15px;font-weight:700;color:#0f172a;">' + esc(s.name_bn || s.name) + '</h4>' +
                  (s.name_bn && s.name && s.name_bn !== s.name ? '<small style="color:#64748b;font-size:12px;">' + esc(s.name) + '</small>' : '') +
                '</div>' +
              '</div>' +
              '<span style="font-size:16px;font-weight:800;color:var(--primary-700);white-space:nowrap;">৳' + bn(s.price) + '</span>' +
            '</div>' +

            '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:10px 0;">' +
              '<span class="badge" style="background:' + (isManual ? '#eff6ff;color:#1e40af;border:1px solid #bfdbfe;' : '#f5f3ff;color:#6b21a8;border:1px solid #ddd6fe;') + '">' + (isManual ? '📝 ম্যানুয়াল' : '⚡ অটোমেটেড') + '</span>' +
            '<button class="mini-btn" onclick="AdmSvc.toggleStatus(\'' + s.id + '\',\'' + s.status + '\')" style="padding:6px 10px;" title="চালু/বন্ধ">' + (isActive ? '🔴 বন্ধ' : '🟢 চালু') + '</button>' +
              '<span class="badge" style="background:#f8fafc;color:#475569;border:1px solid #e2e8f0;">' + esc(catIcon) + ' ' + esc(catName) + '</span>' +
              (s.engine_id ? '<span class="badge" style="background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;">🔌 ' + esc(s.engine_id) + '</span>' : '') +
            '</div>' +

            (isManual && s.manual_doc_count ? '<div style="font-size:12px;color:#64748b;margin-bottom:6px;">📎 সর্বোচ্চ ডকুমেন্ট: <b>' + bn(s.manual_doc_count) + 'টি</b></div>' : '') +
            (s.documents_required && s.documents_required.length ? '<div style="font-size:11px;color:#64748b;margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">📄 আবশ্যক: ' + esc(s.documents_required.join(', ')) + '</div>' : '') +
          '</div>' +

          '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-top:1px solid #f1f5f9;padding-top:12px;margin-top:10px;">' +
            '<button class="mini-btn" onclick="AdmSvc.edit(\'' + s.id + '\')" style="flex:1;min-width:60px;">✏️ এডিট</button>' +
            '<button class="mini-btn" onclick="AdmSvc.duplicate(\'' + s.id + '\')" title="এই সেবার হুবহু কপি তৈরি করুন" style="flex:1;min-width:65px;">📋 ডুপ্লিকেট</button>' +
            '<button class="mini-btn" onclick="AdmSvc.toggleStatus(\'' + s.id + '\',\'' + s.status + '\')" style="padding:6px 10px;" title="চালু/বন্ধ">' + (isActive ? '🔴 বন্ধ' : '🟢 চালু') + '</button>' +
            '<button class="mini-btn danger" onclick="AdmSvc.del(\'' + s.id + '\')" style="padding:6px 10px;" title="ডিলিট">🗑️</button>' +
          '</div>' +
        '</div>';
      });
      html += '</div>';
    }
  }

  html += '</div>';
  content.innerHTML = html;
};

TABS.cats = async () => {
  TABS._svcView = 'cats';
  return TABS.services();
};

window.AdmSvc = {
  onSearch(val) {
    TABS._svcSearch = val;
    clearTimeout(window._svcSearchTimer);
    window._svcSearchTimer = setTimeout(() => { show('services'); }, 250);
  },
  onTypeChange(val, prefix) {
    const isMan = val === 'manual';
    const mb = document.getElementById(prefix + '_manualBox');
    const eb = document.getElementById(prefix + '_engineBox');
    if (mb) mb.style.display = isMan ? 'block' : 'none';
    if (eb) eb.style.display = !isMan ? 'block' : 'none';
  },
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
  async duplicate(id) {
    if (!confirm('এই সেবাটির একটি হুবহু কপি (ডুপ্লিকেট) তৈরি করবেন?')) return;
    const r = await ABC.api('/admin/services/' + id + '/duplicate', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) { alert('ডুপ্লিকেট ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    alert('✅ সেবা সফলভাবে ডুপ্লিকেট হয়েছে! এটি নিষ্ক্রিয় (disabled) অবস্থায় সেভ হয়েছে, প্রয়োজনমতো এডিট করে চালু করুন।');
    show('services');
  },
  createForm() {
    modal('🛎️ নতুন সেবা তৈরি করুন',
      fld('নাম (বাংলা) *', 'text', 'sv_bn') +
      fld('নাম (English) *', 'text', 'sv_name') +
      '<div class="field"><label>ক্যাটাগরি</label>' +
        '<div style="display:flex;gap:8px;">' +
          '<select id="sv_cat" style="flex:1;">' + catOptions(null) + '</select>' +
          '<button type="button" class="mini-btn ok" onclick="AdmCat.inlineCreate(\'sv_cat\')" style="white-space:nowrap;padding:7px 12px;font-weight:700;">+ নতুন</button>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>সেবার ধরন *</label><select id="sv_type" onchange="AdmSvc.onTypeChange(this.value,\'sv\')">' +
        '<option value="manual">📝 ম্যানুয়াল আবেদন</option>' +
        '<option value="automated">⚡ অটোমেটেড ইঞ্জিন</option>' +
      '</select></div>' +
      '<div id="sv_engineBox" style="display:none;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:12px;margin-bottom:14px;">' +
        '<div style="font-size:12px;color:#6b21a8;font-weight:700;margin-bottom:8px;">⚡ অটোমেটেড ইঞ্জিন কনফিগারেশন</div>' +
        '<div class="field" style="margin-bottom:6px;"><label>🔌 অটোমেশন ইঞ্জিন বেছে নিন *</label><select id="sv_engine">' +
          '<option value="">-- ইঞ্জিন বেছে নিন --</option>' +
          '<option value="bdris-certificate">জন্মনিবন্ধন সনদ ইঞ্জিন (Port 3000)</option>' +
          '<option value="death-verify">মৃত্যুনিবন্ধন যাচাই ইঞ্জিন (Port 3104)</option>' +
          '<option value="nid-replica">এনআইডি রেপ্লিকা ইঞ্জিন</option>' +
          '<option value="bdris-apply">BDRIS অনলাইন আবেদন ইঞ্জিন (Port 3102)</option>' +
        '</select></div>' +
        '<small style="color:#64748b;font-size:11px;">গ্রাহক অর্ডার প্লেস করলে ইঞ্জিন ব্যাকগ্রাউন্ডে স্বয়ংক্রিয়ভাবে প্রসেস করে রেজাল্ট প্রদান করবে।</small>' +
      '</div>' +
      '<div id="sv_manualBox" style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;margin-bottom:14px;">' +
        '<div style="font-size:12px;color:#1e40af;font-weight:700;margin-bottom:8px;">📝 ম্যানুয়াল সেবা কনফিগারেশন</div>' +
        '<div class="field"><label>📄 ম্যানুয়াল নমুনা ফরম্যাট <small style="color:#64748b;">(গ্রাহক এটি কপি করে পূরণ করবে)</small></label>' +
        '<textarea id="sv_sample" rows="6" placeholder="যেমন: নাম, এনআইডি নং, জন্ম তারিখ ইত্যাদি" style="font-family:monospace;font-size:13px;line-height:1.7;background:#ffffff;width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;"></textarea>' +
        '<small style="color:#64748b;font-size:11px;">💡 প্রতিটি তথ্যের লেবেল নতুন লাইনে লিখুন।</small></div>' +
        '<div class="field"><label>📋 ম্যানুয়াল আবেদনের নির্দেশনা</label>' +
        '<textarea id="sv_man_inst" rows="3" placeholder="গ্রাহকের জন্য বিশেষ কোনো নির্দেশনা থাকলে লিখুন..." style="width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:13px;background:#ffffff;"></textarea></div>' +
        fld('📎 প্রয়োজনীয় ডকুমেন্ট সংখ্যা (১-৬)', 'number', 'sv_doccount', '1') +
      '</div>' +
      fld('সেবা মূল্য (৳) *', 'number', 'sv_price', '0') +
      fld('প্রয়োজনীয় ডকুমেন্টের নাম (কমা দিয়ে, যেমন: NID, Photo, Signature)', 'text', 'sv_docs') +
      '<div class="field"><label>📜 সাধারণ নিয়মাবলী ও শর্তাবলী</label><textarea id="sv_rules" rows="3" style="width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:13px;"></textarea></div>' +
      '<button class="btn" onclick="AdmSvc.create()" style="width:100%;padding:12px;font-weight:700;margin-top:10px;">✅ সেবা সংরক্ষণ করুন</button>');
  },
  async create() {
    const docs = v('sv_docs').split(',').map(x => x.trim()).filter(Boolean);
    const type = document.getElementById('sv_type').value;
    const bnName = v('sv_bn');
    const enName = v('sv_name') || bnName;
    if (!bnName && !enName) { alert('অনুগ্রহ করে সেবার নাম দিন'); return; }
    const r = await ABC.api('/admin/services', { method: 'POST', body: {
      name: enName, name_bn: bnName,
      type: type,
      price: Number(v('sv_price')) || 0,
      category_id: document.getElementById('sv_cat').value || null,
      documents_required: docs,
      rules_text: v('sv_rules') || null,
      engine_id: type === 'automated' ? (document.getElementById('sv_engine').value || null) : null,
      manual_sample: type === 'manual' ? (v('sv_sample') || null) : null,
      manual_instructions: type === 'manual' ? (v('sv_man_inst') || null) : null,
      manual_doc_count: type === 'manual' ? Math.min(6, Math.max(1, Number(v('sv_doccount')) || 1)) : 1,
    }});
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    closeModal(); show('services');
  },
  async edit(id) {
    const r = await ABC.api('/admin/services');
    const s = (await r.json()).services.find(x => x.id === id);
    if (!s) return;
    const isManual = s.type === 'manual';
    modal('✏️ ' + (s.name_bn || s.name),
      fld('নাম (বাংলা) *', 'text', 'esv_bn', s.name_bn || '') +
      fld('নাম (English) *', 'text', 'esv_name', s.name || '') +
      '<div class="field"><label>ক্যাটাগরি</label>' +
        '<div style="display:flex;gap:8px;">' +
          '<select id="esv_cat" style="flex:1;">' + catOptions(s.category_id) + '</select>' +
          '<button type="button" class="mini-btn ok" onclick="AdmCat.inlineCreate(\'esv_cat\')" style="white-space:nowrap;padding:7px 12px;font-weight:700;">+ নতুন</button>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>সেবার ধরন *</label><select id="esv_type" onchange="AdmSvc.onTypeChange(this.value,\'esv\')">' +
        '<option value="manual"' + (isManual ? ' selected' : '') + '>📝 ম্যানুয়াল আবেদন</option>' +
        '<option value="automated"' + (!isManual ? ' selected' : '') + '>⚡ অটোমেটেড ইঞ্জিন</option>' +
      '</select></div>' +
      '<div id="esv_engineBox" style="display:' + (!isManual ? 'block' : 'none') + ';background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:12px;margin-bottom:14px;">' +
        '<div style="font-size:12px;color:#6b21a8;font-weight:700;margin-bottom:8px;">⚡ অটোমেটেড ইঞ্জিন কনফিগারেশন</div>' +
        '<div class="field" style="margin-bottom:6px;"><label>🔌 অটোমেশন ইঞ্জিন</label><select id="esv_engine">' +
          '<option value="">-- ইঞ্জিন বেছে নিন --</option>' +
          '<option value="bdris-certificate"' + (s.engine_id === 'bdris-certificate' ? ' selected' : '') + '>জন্মনিবন্ধন সনদ ইঞ্জিন (Port 3000)</option>' +
          '<option value="death-verify"' + (s.engine_id === 'death-verify' ? ' selected' : '') + '>মৃত্যুনিবন্ধন যাচাই ইঞ্জিন (Port 3104)</option>' +
          '<option value="nid-replica"' + (s.engine_id === 'nid-replica' ? ' selected' : '') + '>এনআইডি রেপ্লিকা ইঞ্জিন</option>' +
          '<option value="bdris-apply"' + (s.engine_id === 'bdris-apply' ? ' selected' : '') + '>BDRIS অনলাইন আবেদন ইঞ্জিন (Port 3102)</option>' +
        '</select></div>' +
      '</div>' +
      '<div id="esv_manualBox" style="display:' + (isManual ? 'block' : 'none') + ';background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px;margin-bottom:14px;">' +
        '<div style="font-size:12px;color:#1e40af;font-weight:700;margin-bottom:8px;">📝 ম্যানুয়াল সেবা কনফিগারেশন</div>' +
        '<div class="field"><label>📄 ম্যানুয়াল নমুনা ফরম্যাট <small style="color:#64748b;">(গ্রাহক এটি কপি করে পূরণ করবে)</small></label>' +
        '<textarea id="esv_sample" rows="6" style="font-family:monospace;font-size:13px;line-height:1.7;background:#ffffff;width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;">' + esc(s.manual_sample || '') + '</textarea>' +
        '<small style="color:#64748b;font-size:11px;">💡 প্রতিটি তথ্যের লেবেল নতুন লাইনে লিখুন।</small></div>' +
        '<div class="field"><label>📋 ম্যানুয়াল আবেদনের নির্দেশনা</label>' +
        '<textarea id="esv_man_inst" rows="3" style="width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:13px;background:#ffffff;">' + esc(s.manual_instructions || '') + '</textarea></div>' +
        fld('📎 প্রয়োজনীয় ডকুমেন্ট সংখ্যা (১-৬)', 'number', 'esv_doccount', s.manual_doc_count || 1) +
      '</div>' +
      fld('দাম (৳) *', 'number', 'esv_price', s.price) +
      '<div class="field"><label>স্ট্যাটাস</label><select id="esv_status">' +
      ['active', 'disabled'].map(x => '<option value="' + x + '"' + (s.status === x ? ' selected' : '') + '>' + (x === 'active' ? '🟢 সক্রিয়' : '🔴 নিষ্ক্রিয়') + '</option>').join('') +
      '</select></div>' +
      fld('প্রয়োজনীয় ডকুমেন্টের নাম (কমা দিয়ে)', 'text', 'esv_docs', (s.documents_required || []).join(', ')) +
      '<div class="field"><label>📜 সাধারণ নিয়মাবলী ও শর্তাবলী</label><textarea id="esv_rules" rows="3" style="width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-size:13px;">' + esc(s.rules_text || '') + '</textarea></div>' +
      '<button class="btn" onclick="AdmSvc.save(\'' + id + '\')" style="width:100%;padding:12px;font-weight:700;margin-top:10px;">💾 পরিবর্তন সংরক্ষণ করুন</button>');
  },
  async save(id) {
    const docs = v('esv_docs').split(',').map(x => x.trim()).filter(Boolean);
    const type = document.getElementById('esv_type').value;
    const r = await ABC.api('/admin/services/' + id, { method: 'PUT', body: {
      name: v('esv_name'),
      name_bn: v('esv_bn'),
      type: type,
      price: Number(v('esv_price')) || 0,
      status: document.getElementById('esv_status').value,
      category_id: document.getElementById('esv_cat').value || null,
      documents_required: docs,
      engine_id: type === 'automated' ? (document.getElementById('esv_engine').value || null) : null,
      manual_sample: type === 'manual' ? (v('esv_sample') || null) : null,
      manual_instructions: type === 'manual' ? (v('esv_man_inst') || null) : null,
      manual_doc_count: type === 'manual' ? Math.min(6, Math.max(1, Number(v('esv_doccount')) || 1)) : 1,
      rules_text: v('esv_rules') || null,
    }});
    if (!r.ok) { alert('সংরক্ষণ ব্যর্থ'); return; }
    closeModal(); show('services');
  },
  async del(id) {
    if (!confirm('সেবাটি ডিলিট করতে চান?')) return;
    const r = await ABC.api('/admin/services/' + id + '?confirm=yes', { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (d.error === 'SERVICE_IN_USE') {
        alert('⚠️ ' + (d.message || 'এই সার্ভিসে ইতিমধ্যে অর্ডার বিদ্যমান। ডিলিট করার পরিবর্তে এটি নিষ্ক্রিয় (disabled) করুন।'));
      } else {
        alert('ডিলিট ব্যর্থ: ' + (d.error || 'UNKNOWN'));
      }
      return;
    }
    show('services');
  },
};

window.AdmCat = {
  createForm() {
    modal('📁 নতুন ক্যাটাগরি তৈরি করুন',
      fld('নাম (বাংলা) *', 'text', 'ct_bn') +
      fld('নাম (English) *', 'text', 'ct_name') +
      fld('আইকন (Emoji) *', 'text', 'ct_icon', '📁') +
      '<button class="btn" onclick="AdmCat.create()" style="width:100%;padding:12px;font-weight:700;margin-top:10px;">✅ ক্যাটাগরি সংরক্ষণ</button>');
  },
  async inlineCreate(selectId) {
    const name = prompt('নতুন ক্যাটাগরির নাম লিখুন:');
    if (!name || !name.trim()) return;
    const r = await ABC.api('/admin/service-categories', {
      method: 'POST',
      body: { name: name.trim(), name_bn: name.trim(), icon: '📁' }
    });
    const d = await r.json();
    if (!r.ok) { alert('ক্যাটাগরি তৈরি ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    await loadCats();
    const sel = document.getElementById(selectId);
    if (sel) {
      sel.innerHTML = catOptions(d.category ? d.category.id : null);
    }
  },
  async create() {
    const bnName = v('ct_bn');
    const enName = v('ct_name') || bnName;
    if (!bnName && !enName) { alert('অনুগ্রহ করে ক্যাটাগরির নাম দিন'); return; }
    const r = await ABC.api('/admin/service-categories', { method: 'POST', body: {
      name: enName, name_bn: bnName, icon: v('ct_icon') || '📁',
    }});
    const d = await r.json();
    if (!r.ok) { alert('ব্যর্থ: ' + (d.error || 'UNKNOWN')); return; }
    await loadCats();
    closeModal();
    show('services');
  },
  async edit(id) {
    await loadCats();
    const c = (catCache || []).find(x => x.id === id);
    if (!c) return;
    modal('✏️ ' + (c.name_bn || c.name),
      fld('নাম (বাংলা) *', 'text', 'ect_bn', c.name_bn || '') +
      fld('নাম (English) *', 'text', 'ect_name', c.name || '') +
      fld('আইকন (Emoji)', 'text', 'ect_icon', c.icon || '📁') +
      '<div class="field"><label>স্ট্যাটাস</label><select id="ect_status">' +
      ['active', 'disabled'].map(x => '<option value="' + x + '"' + (c.status === x ? ' selected' : '') + '>' + (x === 'active' ? '🟢 সক্রিয়' : '🔴 নিষ্ক্রিয়') + '</option>').join('') +
      '</select></div>' +
      '<button class="btn" onclick="AdmCat.save(\'' + id + '\')" style="width:100%;padding:12px;font-weight:700;margin-top:10px;">💾 পরিবর্তন সংরক্ষণ</button>');
  },
  async save(id) {
    const r = await ABC.api('/admin/service-categories/' + id, { method: 'PUT', body: {
      name: v('ect_name'), name_bn: v('ect_bn'), icon: v('ect_icon') || '📁',
      status: document.getElementById('ect_status').value,
    }});
    if (!r.ok) { alert('সংরক্ষণ ব্যর্থ'); return; }
    await loadCats();
    closeModal();
    show('services');
  },
  async del(id) {
    if (!confirm('ক্যাটাগরি ডিলিট করবেন? ভেতরের সেবাগুলো "অন্যান্য" বিভাগে চলে যাবে।')) return;
    const r = await ABC.api('/admin/service-categories/' + id + '?confirm=yes', { method: 'DELETE' });
    if (!r.ok) { alert('ডিলিট ব্যর্থ'); return; }
    await loadCats();
    show('services');
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
    if (!rr.ok) { alert('ক্রম পরিবর্তন ব্যর্থ'); return; }
    await loadCats();
    show('services');
  },
};

/* ---------------- RECHARGE ---------------- */
TABS.recharge = async () => {
  const st = TABS._rchStatus !== undefined ? TABS._rchStatus : 'pending';
  const url = '/admin/transactions?type=recharge' + (st ? '&status=' + encodeURIComponent(st) : '') + '&limit=50';
  const r = await ABC.api(url);
  const d = await r.json();
  if (!r.ok || !d.transactions) { content.innerHTML = '<div style="color:var(--danger)">⚠️ রিচার্জ তথ্য লোড ব্যর্থ! রিফ্রেশ করুন</div>'; return; }
  
  TABS._rchList = d.transactions || [];
  const q = (TABS._rchQuery || '').trim().toLowerCase();
  const filtered = q
    ? TABS._rchList.filter(t =>
        (t.trxid || '').toLowerCase().includes(q) ||
        (t.user_phone || '').includes(q) ||
        (t.sender_no || '').includes(q) ||
        (t.user_name || '').toLowerCase().includes(q)
      )
    : TABS._rchList;

  let html = '<div style="display:flex; flex-direction:column; gap:14px; margin-bottom:16px;">' +
    '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">' +
      '<div><h3 style="margin:0; font-size:18px; font-weight:800; color:#0f172a;">💳 রিচার্জ ও ডিপোজিট কন্ট্রোল</h3>' +
      '<p style="margin:4px 0 0; font-size:12px; color:#64748b;">গ্রাহকদের ওয়ালেট রিচার্জ যাচাই, অনুমোদন ও লেনদেন অডিট</p></div>' +
      '<button class="mini-btn" onclick="show(\'sms\')" style="display:inline-flex; align-items:center; gap:6px;">📩 SMS গেটওয়ে অডিট লগ</button>' +
    '</div>' +

    '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; background:#fff; padding:12px 14px; border:1px solid #e2e8f0; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.02);">' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
        '<button class="mini-btn' + (st === 'pending' ? ' ok' : '') + '" onclick="TABS._rchStatus=\'pending\';show(\'recharge\')">⏳ অপেক্ষমান (' + (st === 'pending' ? bn(d.total) : '•') + ')</button>' +
        '<button class="mini-btn' + (st === 'approved' ? ' ok' : '') + '" onclick="TABS._rchStatus=\'approved\';show(\'recharge\')">✅ অনুমোদিত</button>' +
        '<button class="mini-btn' + (st === 'rejected' ? ' ok' : '') + '" onclick="TABS._rchStatus=\'rejected\';show(\'recharge\')">❌ বাতিলকৃত</button>' +
        '<button class="mini-btn' + (st === '' ? ' ok' : '') + '" onclick="TABS._rchStatus=\'\';show(\'recharge\')">📋 সকল লেনদেন</button>' +
      '</div>' +
      '<div style="flex:1; min-width:220px; max-width:360px;">' +
        '<input type="text" id="admRchSearchInput" placeholder="🔍 TrxID বা মোবাইল নম্বর খুঁজুন…" value="' + esc(TABS._rchQuery || '') + '" oninput="AdmTx.search(this.value)" style="width:100%; padding:7px 12px; font-size:12px; border-radius:8px; border:1px solid #cbd5e1;">' +
      '</div>' +
    '</div>' +
  '</div>';

  if (!filtered.length) {
    html += '<div style="text-align:center; padding:48px 16px; background:#ffffff; border:1px dashed #cbd5e1; border-radius:14px; color:#64748b;">' +
      '<div style="font-size:32px; margin-bottom:8px;">' + (q ? '🔍' : '🎉') + '</div>' +
      '<b style="font-size:15px; color:#0f172a;">' + (q ? 'কোনো রিচার্জ মেলেনি' : (st === 'pending' ? 'কোনো অপেক্ষমান রিচার্জ রিকোয়েস্ট নেই' : 'কোনো লেনদেন পাওয়া যায়নি')) + '</b><br>' +
      '<span style="font-size:13px;">' + (q ? 'অন্য নম্বর বা TrxID দিয়ে চেষ্টা করুন।' : 'সবগুলো রিকোয়েস্ট সফলভাবে নিষ্পত্তি করা হয়েছে।') + '</span>' +
      '</div>';
  } else {
    html += '<div style="display:grid; gap:10px;">';
    for (const t of filtered) {
      const mLow = (t.method || '').toLowerCase();
      let mBadge = '<span style="display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#e0f2fe; color:#0369a1;">' + esc(t.method) + '</span>';
      if (mLow.includes('bkash')) {
        mBadge = '<span style="display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#fdf2f8; color:#db2777; border:1px solid #fbcfe8;">bKash</span>';
      } else if (mLow.includes('nagad')) {
        mBadge = '<span style="display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#fff7ed; color:#ea580c; border:1px solid #ffedd5;">Nagad</span>';
      } else if (mLow.includes('rocket')) {
        mBadge = '<span style="display:inline-block; padding:2px 8px; border-radius:6px; font-size:11px; font-weight:700; background:#faf5ff; color:#9333ea; border:1px solid #f3e8ff;">Rocket</span>';
      }

      let actionBlock = '';
      if (t.status === 'pending') {
        actionBlock = '<div style="display:flex; align-items:center; gap:8px;">' +
          '<button class="mini-btn ok" style="padding:7px 14px; font-size:12px; font-weight:700; background:#16a34a; color:#fff;" onclick="AdmTx.approve(' + jqAttr(t.id) + ', ' + t.amount + ', ' + jqAttr(t.user_name) + ')">✅ Approve</button>' +
          '<button class="mini-btn danger" style="padding:7px 12px; font-size:12px; font-weight:600;" onclick="AdmTx.reject(' + jqAttr(t.id) + ', ' + t.amount + ', ' + jqAttr(t.user_name) + ')">❌ Reject</button>' +
        '</div>';
      } else if (t.status === 'approved') {
        actionBlock = '<span style="display:inline-block; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:700; background:#dcfce7; color:#15803d; border:1px solid #bbf7d0;">✅ অনুমোদিত</span>';
      } else if (t.status === 'rejected') {
        actionBlock = '<span style="display:inline-block; padding:4px 10px; border-radius:6px; font-size:12px; font-weight:700; background:#fee2e2; color:#b91c1c; border:1px solid #fecaca;">❌ বাতিলকৃত</span>';
      } else {
        actionBlock = '<span class="badge">' + esc(t.status) + '</span>';
      }

      html += '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px; display:flex; gap:14px; align-items:center; flex-wrap:wrap; box-shadow:0 1px 3px rgba(0,0,0,0.03);">' +
        '<div style="flex:1; min-width:240px;">' +
          '<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">' +
            '<b style="font-size:15px; color:#0f172a;">' + esc(t.user_name) + '</b>' +
            mBadge +
          '</div>' +
          '<div style="font-size:13px; color:#475569; display:flex; flex-wrap:wrap; gap:12px; align-items:center;">' +
            '<span>📞 ' + esc(t.sender_no || t.user_phone) + '</span>' +
            '<span>TrxID: <button style="background:#f1f5f9; border:1px solid #cbd5e1; border-radius:6px; padding:1px 6px; font-family:monospace; font-size:12px; cursor:pointer;" onclick="navigator.clipboard.writeText(' + jqAttr(t.trxid) + ');admToast(\'কপি সফল\', \'TrxID কপি করা হয়েছে\')">📋 ' + esc(t.trxid) + '</button></span>' +
          '</div>' +
          '<div style="font-size:11px; color:#94a3b8; margin-top:4px;">🕒 ' + new Date(t.created_at).toLocaleString('bn-BD') + '</div>' +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:12px; margin-left:auto;">' +
          '<div style="background:#f0fdf4; border:1px solid #bbf7d0; color:#15803d; font-size:18px; font-weight:800; padding:6px 14px; border-radius:10px;">৳' + bn(t.amount) + '</div>' +
          actionBlock +
        '</div>' +
      '</div>';
    }
    html += '</div>';
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
  const list = d.sms || [];

  let html = '<div class="adm-page-head">' +
    '<div>' +
      '<h2 class="adm-page-title">📩 SMS গেটওয়ে ও অটো-ম্যাচ হাব</h2>' +
      '<p class="adm-page-sub">ব্যাংকিং SMS পর্যালোচনা ও রিচার্জ অটোমেশন অডিট</p>' +
    '</div>' +
    '<div class="adm-head-actions">' +
      '<button class="mini-btn' + (f === 'no' ? ' ok' : '') + '" onclick="window._smsFilter=\'no\';show(\'sms\')">⏳ আনম্যাচড</button>' +
      '<button class="mini-btn' + (f === 'yes' ? ' ok' : '') + '" onclick="window._smsFilter=\'yes\';show(\'sms\')">✅ ম্যাচড</button>' +
      '<button class="mini-btn' + (f === '' ? ' ok' : '') + '" onclick="window._smsFilter=\'\';show(\'sms\')">📋 সব SMS</button>' +
    '</div>' +
  '</div>';

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
            (!matched
              ? '<select id="sms-tx-' + s.id + '" class="mini-btn" style="max-width:200px;font-size:12px;">' +
                  '<option value="">পেন্ডিং রিচার্জ বাছুন…</option>' +
                  pend.map(p => '<option value="' + p.id + '">৳' + bn(p.amount) + ' • ' + esc(p.user_name) + ' • ' + esc(p.trxid || '') + '</option>').join('') +
                '</select>' +
                '<div style="display:flex;gap:6px;">' +
                  '<button class="mini-btn ok" onclick="AdmSms.match(\'' + s.id + '\')">🔗 ম্যাচ করুন</button>' +
                  '<button class="mini-btn danger" onclick="AdmSms.ignore(\'' + s.id + '\')">🙈 বাদ দিন</button>' +
                '</div>'
              : '<span style="color:#059669;font-size:12px;font-weight:700;">✓ অটো প্রসেসড</span>') +
          '</div>' +
        '</div>' +
      '</div>';
    }
    html += '</div>';
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
  search(q) {
    TABS._rchQuery = q;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      show('recharge');
    }, 250);
  },
  approve(id, amount, name) {
    modal('💰 রিচার্জ অনুমোদন নিশ্চিত করুন',
      '<div style="text-align:center; padding:10px 0;">' +
        '<div style="font-size:32px; font-weight:800; color:#15803d; margin-bottom:8px;">৳' + bn(amount || 0) + '</div>' +
        '<div style="font-size:14px; color:#334155; margin-bottom:18px;">গ্রাহক: <b>' + esc(name || 'গ্রাহক') + '</b>-এর ওয়ালেটে টাকা যোগ করা হবে।</div>' +
        '<div style="display:flex; gap:10px; justify-content:center;">' +
          '<button class="btn ok" style="background:#16a34a; font-weight:700;" onclick="AdmTx._doApprove(\'' + id + '\')">অনুমোদন নিশ্চিত করুন</button>' +
          '<button class="btn-secondary" onclick="closeModal()">বাতিল</button>' +
        '</div>' +
      '</div>'
    );
  },
  async _doApprove(id) {
    closeModal();
    try {
      const r = await ABC.api('/admin/transactions/' + id + '/approve', { method: 'PUT' });
      const d = await r.json();
      if (!r.ok) {
        admToast('অনুমোদন ব্যর্থ', d.error === 'DUPLICATE_TRANSACTION' ? 'এই রিচার্জটি ইতিমধ্যে অন্য অ্যাডমিন দ্বারা অনুমোদিত হয়েছে।' : 'ব্যর্থ: ' + (d.error || 'UNKNOWN'), 'error');
        return;
      }
      admToast('রিচার্জ সফল 🎉', 'গ্রাহকের ওয়ালেটে সফলভাবে ব্যালেন্স যোগ হয়েছে।', 'recharge');
      show('recharge');
    } catch (e) {
      admToast('নেটওয়ার্ক ত্রুটি', 'সার্ভারে সংযোগ করা যায়নি', 'error');
    }
  },
  reject(id, amount, name) {
    modal('❌ রিচার্জ বাতিল করুন',
      '<div style="text-align:center; padding:10px 0;">' +
        '<div style="font-size:15px; color:#334155; margin-bottom:14px;">আপনি কি <b>' + esc(name || 'গ্রাহক') + '</b>-এর <b>৳' + bn(amount || 0) + '</b> রিচার্জ রিকোয়েস্ট বাতিল করতে চান?</div>' +
        '<div style="display:flex; gap:10px; justify-content:center;">' +
          '<button class="btn danger" style="background:#dc2626; font-weight:700;" onclick="AdmTx._doReject(\'' + id + '\')">বাতিল নিশ্চিত করুন</button>' +
          '<button class="btn-secondary" onclick="closeModal()">ফিরে যান</button>' +
        '</div>' +
      '</div>'
    );
  },
  async _doReject(id) {
    closeModal();
    try {
      const r = await ABC.api('/admin/transactions/' + id + '/reject', { method: 'PUT' });
      const d = await r.json();
      if (!r.ok) {
        admToast('বাতিল ব্যর্থ', 'ত্রুটি: ' + (d.error || 'NOT_PENDING'), 'error');
        return;
      }
      admToast('বাতিল সম্পন্ন', 'রিচার্জ রিকোয়েস্টটি সফলভাবে বাতিল করা হয়েছে।', 'info');
      show('recharge');
    } catch (e) {
      admToast('নেটওয়ার্ক ত্রুটি', 'সার্ভারে সংযোগ করা যায়নি', 'error');
    }
  },
};

/* ---------------- COUPONS ---------------- */
TABS.coupons = async () => {
  const r = await ABC.api('/admin/coupons');
  const d = await r.json();
  const coupons = d.coupons || [];
  const activeCount = coupons.filter(c => c.status === 'active').length;

  let html = '<div class="adm-page-head">' +
    '<div>' +
      '<h2 class="adm-page-title">🎟️ কুপন ও ডিসকাউন্ট ভাউচার</h2>' +
      '<p class="adm-page-sub">গ্রাহকদের প্রমোশনাল ডিসকাউন্ট ও ক্যাশব্যাক কুপন কোড ব্যবস্থাপনা</p>' +
    '</div>' +
    '<div class="adm-head-actions">' +
      '<span class="st-badge info">মোট কুপন: ' + bn(coupons.length) + '</span>' +
      '<span class="st-badge active">সক্রিয়: ' + bn(activeCount) + '</span>' +
      '<button class="btn ok" onclick="AdmCp.createForm()">+ নতুন কুপন তৈরি করুন</button>' +
    '</div>' +
  '</div>';

  if (!coupons.length) {
    html += '<div class="adm-empty-state">' +
      '<div class="adm-empty-icon">🎟️</div>' +
      '<div class="adm-empty-title">কোনো কুপন তৈরি করা হয়নি</div>' +
      '<div class="adm-empty-desc">গ্রাহকদের জন্য প্রোমো বা ক্যাশব্যাক কুপন কোড তৈরি করতে উপরের বাটনে চাপ দিন।</div>' +
      '<div style="margin-top:14px;"><button class="btn ok" onclick="AdmCp.createForm()">+ নতুন কুপন তৈরি করুন</button></div>' +
    '</div>';
  } else {
    html += '<div class="adm-table-card">' +
      '<div style="overflow-x:auto;">' +
        '<table class="adm-table">' +
          '<thead><tr>' +
            '<th>কুপন কোড</th>' +
            '<th>ধরন</th>' +
            '<th>ডিসকাউন্ট রেট</th>' +
            '<th>ফিক্সড ছাড়</th>' +
            '<th>স্ট্যাটাস</th>' +
            '<th style="text-align:right;">অ্যাকশন</th>' +
          '</tr></thead><tbody>';

    for (const c of coupons) {
      const isActive = c.status === 'active';
      const stClass = isActive ? 'active' : 'disabled';
      const stText = isActive ? 'সক্রিয়' : 'নিষ্ক্রিয়';
      const typeBadge = c.type === 'cashback'
        ? '<span class="st-badge info">💰 ক্যাশব্যাক</span>'
        : '<span class="st-badge active">🎁 প্রোমো</span>';

      html += '<tr>' +
        '<td>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<span class="adm-code-chip" onclick="AdmInv.copyText(\'' + esc(c.code) + '\')" title="ক্লিক করে কোড কপি করুন">' + esc(c.code) + ' 📋</span>' +
          '</div>' +
        '</td>' +
        '<td>' + typeBadge + '</td>' +
        '<td>' + (c.percent ? '<b style="color:#0f172a;">' + bn(c.percent) + '%</b>' : '<span style="color:#94a3b8;">—</span>') + '</td>' +
        '<td>' + (c.amount ? '<b style="color:#15803d;">৳' + bn(c.amount) + '</b>' : '<span style="color:#94a3b8;">—</span>') + '</td>' +
        '<td><span class="st-badge ' + stClass + '">' + stText + '</span></td>' +
        '<td style="text-align:right;">' +
          (isActive
            ? '<button class="mini-btn danger" onclick="AdmCp.set(\'' + c.id + '\',\'disabled\')">বন্ধ করুন</button>'
            : '<button class="mini-btn ok" onclick="AdmCp.set(\'' + c.id + '\',\'active\')">চালু করুন</button>') +
        '</td>' +
      '</tr>';
    }
    html += '</tbody></table></div></div>';
  }
  content.innerHTML = html;
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
  const invites = d.invites || [];

  let html = '<div class="adm-page-head">' +
    '<div>' +
      '<h2 class="adm-page-title">🔗 ইনভাইট ও রেজিস্ট্রেশন কোড</h2>' +
      '<p class="adm-page-sub">রেজিস্ট্রেশন বন্ধ থাকলেও এই এক্সক্লুসিভ লিংক দিয়ে একাউন্ট তৈরি করা যাবে</p>' +
    '</div>' +
    '<div class="adm-head-actions">' +
      '<span class="st-badge info">মোট ইনভাইট: ' + bn(invites.length) + '</span>' +
      '<button class="btn ok" onclick="AdmInv.createForm()">+ নতুন ইনভাইট লিংক</button>' +
    '</div>' +
  '</div>';

  if (!invites.length) {
    html += '<div class="adm-empty-state">' +
      '<div class="adm-empty-icon">🔗</div>' +
      '<div class="adm-empty-title">কোনো ইনভাইট লিংক তৈরি করা হয়নি</div>' +
      '<div class="adm-empty-desc">ব্যবহারকারীদের আমন্ত্রণ জানাতে নতুন ইনভাইটেশন লিংক তৈরি করুন।</div>' +
      '<div style="margin-top:14px;"><button class="btn ok" onclick="AdmInv.createForm()">+ নতুন ইনভাইট লিংক</button></div>' +
    '</div>';
  } else {
    html += '<div class="adm-table-card">' +
      '<div style="overflow-x:auto;">' +
        '<table class="adm-table">' +
          '<thead><tr>' +
            '<th>ইনভাইট কোড ও নোট</th>' +
            '<th>ব্যবহার</th>' +
            '<th>মেয়াদ</th>' +
            '<th>স্ট্যাটাস</th>' +
            '<th style="text-align:right;">অ্যাকশন</th>' +
          '</tr></thead><tbody>';

    for (const x of invites) {
      const used = Number(x.used_count) || 0;
      const max = x.max_uses == null ? '∞' : bn(x.max_uses);
      const exp = x.expires_at ? new Date(x.expires_at).toLocaleString('bn-BD') : 'মেয়াদহীন';
      const isExpired = x.expires_at && new Date(x.expires_at) <= new Date();
      const isFull = x.max_uses != null && used >= Number(x.max_uses);

      let stBadge = '';
      if (!x.is_active) {
        stBadge = '<span class="st-badge disabled">বন্ধ</span>';
      } else if (isExpired) {
        stBadge = '<span class="st-badge danger">মেয়াদ শেষ</span>';
      } else if (isFull) {
        stBadge = '<span class="st-badge warn">পূর্ণ</span>';
      } else {
        stBadge = '<span class="st-badge active">সক্রিয়</span>';
      }

      html += '<tr>' +
        '<td>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            '<span class="adm-code-chip" onclick="AdmInv.copyLink(\'' + esc(x.code) + '\')" title="ক্লিক করে লিংক কপি করুন">' + esc(x.code) + ' 📋</span>' +
          '</div>' +
          (x.note ? '<div style="font-size:11px;color:var(--text-muted);margin-top:4px;">' + esc(x.note) + '</div>' : '') +
        '</td>' +
        '<td><b>' + bn(used) + '</b> / ' + max + '</td>' +
        '<td><span style="font-size:12px;color:var(--text-muted);">' + exp + '</span></td>' +
        '<td>' + stBadge + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="mini-btn" onclick="AdmInv.copyLink(\'' + esc(x.code) + '\')" title="লিংক কপি">📋 কপি</button> ' +
          (x.is_active
            ? '<button class="mini-btn danger" onclick="AdmInv.set(\'' + x.id + '\',false)">বন্ধ</button>'
            : '<button class="mini-btn ok" onclick="AdmInv.set(\'' + x.id + '\',true)">চালু</button>') + ' ' +
          '<button class="mini-btn danger" onclick="AdmInv.del(\'' + x.id + '\')" title="মুছে ফেলুন">🗑️</button>' +
        '</td>' +
      '</tr>';
    }
    html += '</tbody></table></div></div>';
  }
  content.innerHTML = html;
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
  const banners = d.banners || [];
  const animBn = { slide: '➡️ স্লাইড', fade: '🔄 ফেইড', ticker: '📰 টিকার', bounce: '⬆️ বাউন্স', none: '⏸️ স্থির' };
  const typeLabels = {
    banner: '<span class="pill" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;">🖼️ ব্যানার</span>',
    ad: '<span class="pill" style="background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0;">📢 বিজ্ঞাপন</span>',
    popup: '<span class="pill" style="background:#fef3c7;color:#b45309;border:1px solid #fde68a;">💬 পপআপ</span>'
  };

  let rows = '';
  if (!banners.length) {
    rows = '<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text-muted);">এখনো কোনো ব্যানার তৈরি করা হয়নি। উপরের বাটন দিয়ে নতুন ব্যানার তৈরি করুন।</td></tr>';
  } else {
    for (const b of banners) {
      const c = b.content || {};
      const typeBadge = typeLabels[b.type] || ('<span class="pill">' + esc(b.type) + '</span>');
      rows += '<tr>' +
        '<td>' + typeBadge + '</td>' +
        '<td><div style="font-weight:700;color:var(--text-main);">' + esc(b.title) + '</div>' +
        '<div class="s" style="margin-top:2px;">' + esc(c.text_bn || '') + (c.link ? ' • 🔗 ' + esc(c.link) : '') + '</div></td>' +
        '<td><span class="pill" style="background:#f8fafc;border:1px solid #e2e8f0;">#' + b.design_id + '</span></td>' +
        '<td><small style="font-weight:600;">' + (animBn[b.animation_type] || b.animation_type || '-') + '</small><div class="s">গতি: ' + (b.animation_speed || 30) + '</div></td>' +
        '<td>' +
          '<button class="mini-btn ' + (b.active ? 'ok' : '') + '" onclick="AdmBn.toggle(\'' + b.id + '\',' + (!b.active) + ')">' +
          (b.active ? '✅ চালু' : '❌ বন্ধ') + '</button>' +
        '</td>' +
        '<td>' +
          '<div style="display:flex;gap:6px;">' +
            '<button class="mini-btn" onclick="AdmBn.editForm(\'' + b.id + '\')">✏️ এডিট</button>' +
            '<button class="mini-btn danger" onclick="AdmBn.del(\'' + b.id + '\')">🗑️</button>' +
          '</div>' +
        '</td>' +
      '</tr>';
    }
  }

  content.innerHTML =
    '<div class="adm-settings" style="max-width:1100px;">' +
      '<div class="adm-settings-hero">' +
        '<div>' +
          '<div class="adm-settings-eyebrow">PROMOTIONS & NOTICES</div>' +
          '<h1>🖼️ ব্যানার ও অফার ম্যানেজমেন্ট</h1>' +
          '<p>ইউজার ড্যাশবোর্ডের টপ স্লাইডার ব্যানার, বিজ্ঞাপন এবং বিশেষ ঘোষণা পপআপ নিয়ন্ত্রণ করুন।</p>' +
        '</div>' +
        '<button class="adm-settings-hero-btn" onclick="AdmBn.createForm()">+ নতুন ব্যানার তৈরি</button>' +
      '</div>' +

      '<div class="form-card adm-settings-card" style="padding:0;overflow:hidden;">' +
        '<div style="overflow-x:auto;">' +
          '<table class="adm" style="margin:0;">' +
            '<thead>' +
              '<tr><th>ধরন</th><th>শিরোনাম ও টেক্সট</th><th>ডিজাইন</th><th>অ্যানিমেশন</th><th>স্ট্যাটাস</th><th>অ্যাকশন</th></tr>' +
            '</thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>' +
      '<div class="s" style="margin-top:6px;color:var(--text-muted);">✨ ড্যাশবোর্ডে ব্যানার ও বিজ্ঞাপন স্লাইডার আকারে স্বয়ংক্রিয়ভাবে চলবে। পপআপ সেট করলে ইউজাররা পেজে ঢোকার পর স্পেশাল নোটিশ কার্ড দেখতে পাবেন।</div>' +
    '</div>';
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
  toggleColors() {
    const chk = document.getElementById('bn_use_colors');
    const box = document.getElementById('bn_color_fields');
    if (box) box.style.display = (chk && chk.checked) ? 'grid' : 'none';
    this.updatePreview();
  },
  async createForm() {
    this._selDesign = 1;
    const cat = await this._cat();
    modal('🖼️ নতুন ব্যানার / বিজ্ঞাপন / পপআপ',
      '<div class="field"><label>ধরন (Placement Type)</label>' +
        '<select id="bn_type">' +
          '<option value="banner">🖼️ ব্যানার (ড্যাশবোর্ড টপ স্লাইডার)</option>' +
          '<option value="ad">📢 বিজ্ঞাপন (অফার ব্যানার)</option>' +
          '<option value="popup">💬 পপআপ (লগইনের পর স্পেশাল কার্ড)</option>' +
        '</select>' +
      '</div>' +
      fld('শিরোনাম (Admin Reference Title)', 'text', 'bn_title') +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="field"><label>🎬 অ্যানিমেশন ধরন</label><select id="bn_anim">' +
          '<option value="slide">➡️ স্লাইড (Slide)</option>' +
          '<option value="fade">🔄 ফেইড (Fade)</option>' +
          '<option value="ticker">📰 নিউজ টিকার (Ticker)</option>' +
          '<option value="bounce">⬆️ বাউন্স (Bounce)</option>' +
          '<option value="none">⏸️ স্থির (None)</option>' +
        '</select></div>' +
        '<div class="field"><label>⚡ ট্রানজিশন গতি (৫=ধীর, ১২০=দ্রুত)</label>' +
          '<input type="range" id="bn_speed" min="5" max="120" value="30" style="width:100%;margin-top:8px;" ' +
          'oninput="document.getElementById(\'bn_speed_v\').textContent=this.value">' +
          '<div class="s">বর্তমান স্পিড: <b id="bn_speed_v">30</b></div>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>ডিজাইন টেমপ্লেট বেছে নিন (' + cat.designs.length + 'টি রেডি ডিজাইন)</label>' +
        '<div class="bn-design-grid" id="bnDesignGrid">' +
        cat.designs.map((d) =>
          '<div class="bn-design-opt' + (d.id === 1 ? ' sel' : '') + '" data-id="' + d.id + '" onclick="AdmBn.pick(' + d.id + ')">' +
          '<div class="dname">#' + d.id + ' ' + esc(d.name) + '</div><div class="dcat">' + esc(d.category) + '</div></div>'
        ).join('') + '</div>' +
      '</div>' +
      '<div class="field"><label>লাইভ প্রিভিউ (Live Preview)</label><div class="bn-preview" id="bnPreview"></div></div>' +
      fld('মূল বার্তা (বাংলা)', 'text', 'bn_text_bn') +
      fld('সাব-টেক্সট (English)', 'text', 'bn_text_en') +
      fld('ক্লিক লিংক (Optional Link, e.g. /wallet.html)', 'text', 'bn_link') +
      '<div class="field" style="margin-top:10px;"><label style="cursor:pointer;display:inline-flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" id="bn_use_colors" onchange="AdmBn.toggleColors()"> 🎨 কাস্টম রং প্রয়োগ করুন</label></div>' +
      '<div id="bn_color_fields" style="display:none;grid-template-columns:1fr 1fr;gap:12px;margin-top:4px;">' +
        '<div class="field"><label>কাস্টম ব্যাকগ্রাউন্ড রং</label><input type="color" id="bn_bg_color" value="#1e40af" style="width:100%;height:38px;padding:2px;border-radius:6px;cursor:pointer;"></div>' +
        '<div class="field"><label>কাস্টম লেখার রং</label><input type="color" id="bn_text_color" value="#ffffff" style="width:100%;height:38px;padding:2px;border-radius:6px;cursor:pointer;"></div>' +
      '</div>' +
      '<button class="btn" style="margin-top:16px;" onclick="AdmBn.create()">✅ ব্যানার সংরক্ষণ করুন</button>');

    this.updatePreview();
    ['bn_text_bn', 'bn_text_en', 'bn_link', 'bn_bg_color', 'bn_text_color'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => this.updatePreview());
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
        use_custom_colors: !!document.getElementById('bn_use_colors')?.checked,
        bg_color: document.getElementById('bn_use_colors')?.checked ? ((bgc && bgc.value) || '') : '',
        text_color: document.getElementById('bn_use_colors')?.checked ? ((txc && txc.value) || '') : '',
      },
    });
    const pv = document.getElementById('bnPreview');
    if (pv) pv.innerHTML = html;
  },
  async create() {
    const title = v('bn_title');
    if (!title) { alert('ব্যানারের একটি শিরোনাম লিখুন'); return; }
    const r = await ABC.api('/admin/banners', { method: 'POST', body: {
      type: document.getElementById('bn_type').value,
      title: title,
      design_id: this._selDesign,
      animation_type: document.getElementById('bn_anim').value,
      animation_speed: Number(document.getElementById('bn_speed').value) || 30,
      content: {
        text_bn: v('bn_text_bn'),
        text_en: v('bn_text_en'),
        link: v('bn_link'),
        use_custom_colors: !!document.getElementById('bn_use_colors')?.checked,
        bg_color: document.getElementById('bn_use_colors')?.checked ? v('bn_bg_color') : '',
        text_color: document.getElementById('bn_use_colors')?.checked ? v('bn_text_color') : '',
      },
    }});
    if (!r.ok) { alert('❌ ব্যানার তৈরি ব্যর্থ হয়েছে'); return; }
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
      '<div class="field"><label>ধরন (Placement Type)</label>' +
        '<select id="bn_type">' +
          '<option value="banner"' + (b.type === 'banner' ? ' selected' : '') + '>🖼️ ব্যানার (ড্যাশবোর্ড টপ স্লাইডার)</option>' +
          '<option value="ad"' + (b.type === 'ad' ? ' selected' : '') + '>📢 বিজ্ঞাপন (অফার ব্যানার)</option>' +
          '<option value="popup"' + (b.type === 'popup' ? ' selected' : '') + '>💬 পপআপ (লগইনের পর স্পেশাল কার্ড)</option>' +
        '</select>' +
      '</div>' +
      fld('শিরোনাম (Admin Reference Title)', 'text', 'bn_title', b.title) +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
        '<div class="field"><label>🎬 অ্যানিমেশন ধরন</label><select id="bn_anim">' +
          '<option value="slide"' + (b.animation_type === 'slide' ? ' selected' : '') + '>➡️ স্লাইড (Slide)</option>' +
          '<option value="fade"' + (b.animation_type === 'fade' ? ' selected' : '') + '>🔄 ফেইড (Fade)</option>' +
          '<option value="ticker"' + (b.animation_type === 'ticker' ? ' selected' : '') + '>📰 নিউজ টিকার (Ticker)</option>' +
          '<option value="bounce"' + (b.animation_type === 'bounce' ? ' selected' : '') + '>⬆️ বাউন্স (Bounce)</option>' +
          '<option value="none"' + (b.animation_type === 'none' ? ' selected' : '') + '>⏸️ স্থির (None)</option>' +
        '</select></div>' +
        '<div class="field"><label>⚡ ট্রানজিশন গতি</label>' +
          '<input type="range" id="bn_speed" min="5" max="120" value="' + (b.animation_speed || 30) + '" style="width:100%;margin-top:8px;" ' +
          'oninput="document.getElementById(\'bn_speed_v\').textContent=this.value">' +
          '<div class="s">বর্তমান স্পিড: <b id="bn_speed_v">' + (b.animation_speed || 30) + '</b></div>' +
        '</div>' +
      '</div>' +
      '<div class="field"><label>ডিজাইন টেমপ্লেট বেছে নিন</label>' +
        '<div class="bn-design-grid" id="bnDesignGrid">' +
        cat.designs.map((x) =>
          '<div class="bn-design-opt' + (x.id === b.design_id ? ' sel' : '') + '" data-id="' + x.id + '" onclick="AdmBn.pick(' + x.id + ')">' +
          '<div class="dname">#' + x.id + ' ' + esc(x.name) + '</div><div class="dcat">' + esc(x.category) + '</div></div>'
        ).join('') + '</div>' +
      '</div>' +
      '<div class="field"><label>লাইভ প্রিভিউ</label><div class="bn-preview" id="bnPreview"></div></div>' +
      fld('মূল বার্তা (বাংলা)', 'text', 'bn_text_bn', c.text_bn || '') +
      fld('সাব-টেক্সট (English)', 'text', 'bn_text_en', c.text_en || '') +
      fld('ক্লিক লিংক (Optional)', 'text', 'bn_link', c.link || '') +
      '<div class="field" style="margin-top:10px;"><label style="cursor:pointer;display:inline-flex;align-items:center;gap:8px;font-weight:600;"><input type="checkbox" id="bn_use_colors" ' + (c.use_custom_colors ? 'checked' : '') + ' onchange="AdmBn.toggleColors()"> 🎨 কাস্টম রং প্রয়োগ করুন</label></div>' +
      '<div id="bn_color_fields" style="display:' + (c.use_custom_colors ? 'grid' : 'none') + ';grid-template-columns:1fr 1fr;gap:12px;margin-top:4px;">' +
        '<div class="field"><label>কাস্টম ব্যাকগ্রাউন্ড রং</label><input type="color" id="bn_bg_color" value="' + esc(c.bg_color || '#1e40af') + '" style="width:100%;height:38px;padding:2px;border-radius:6px;cursor:pointer;"></div>' +
        '<div class="field"><label>কাস্টম লেখার রং</label><input type="color" id="bn_text_color" value="' + esc(c.text_color || '#ffffff') + '" style="width:100%;height:38px;padding:2px;border-radius:6px;cursor:pointer;"></div>' +
      '</div>' +
      '<div class="field" style="margin-top:12px;"><label><input type="checkbox" id="bn_active" ' + (b.active ? 'checked' : '') + '> এই ব্যানারটি ইউজারদের সামনে সক্রিয় রাখুন</label></div>' +
      '<button class="btn" style="margin-top:16px;" onclick="AdmBn.save(\'' + id + '\')">💾 পরিবর্তন সংরক্ষণ করুন</button>');

    this.updatePreview();
    ['bn_text_bn', 'bn_text_en', 'bn_link', 'bn_bg_color', 'bn_text_color'].forEach((x) => {
      const el = document.getElementById(x);
      if (el) el.addEventListener('input', () => this.updatePreview());
    });
  },
  async save(id) {
    const title = v('bn_title');
    if (!title) { alert('ব্যানারের একটি শিরোনাম লিখুন'); return; }
    const r = await ABC.api('/admin/banners/' + id, { method: 'PUT', body: {
      type: document.getElementById('bn_type').value,
      title: title,
      design_id: this._selDesign,
      active: document.getElementById('bn_active').checked,
      animation_type: document.getElementById('bn_anim').value,
      animation_speed: Number(document.getElementById('bn_speed').value) || 30,
      content: {
        text_bn: v('bn_text_bn'),
        text_en: v('bn_text_en'),
        link: v('bn_link'),
        use_custom_colors: !!document.getElementById('bn_use_colors')?.checked,
        bg_color: document.getElementById('bn_use_colors')?.checked ? v('bn_bg_color') : '',
        text_color: document.getElementById('bn_use_colors')?.checked ? v('bn_text_color') : '',
      },
    }});
    if (!r.ok) { alert('❌ সংরক্ষণ ব্যর্থ হয়েছে'); return; }
    closeModal(); show('banners');
  },
  async toggle(id, active) {
    await ABC.api('/admin/banners/' + id, { method: 'PUT', body: { active } });
    show('banners');
  },
  async del(id) {
    if (!confirm('এই ব্যানারটি কি স্থায়ীভাবে মুছে ফেলতে চান?')) return;
    await ABC.api('/admin/banners/' + id, { method: 'DELETE' });
    show('banners');
  },
};
/* ---------------- NOTICES ---------------- */
TABS.notices = async () => {
  const r = await ABC.api('/admin/notices');
  const d = await r.json();
  if (!r.ok || !d.notices) { content.innerHTML = '<div style="color:var(--danger)">⚠️ নোটিশ লোড ব্যর্থ! রিফ্রেশ করুন</div>'; return; }
  
  const list = d.notices || [];
  let html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px;">' +
    '<div><h3 style="margin:0; font-size:18px; font-weight:800; color:#0f172a;">📢 নোটিশ ও ঘোষণা হাব</h3>' +
    '<p style="margin:4px 0 0; font-size:12px; color:#64748b;">গ্রাহকদের ড্যাশবোর্ডে সার্বজনীন অথবা নির্দিষ্ট ব্যবহারকারীকে বার্তা পাঠান</p></div>' +
    '<button class="btn ok" style="padding:9px 18px; font-size:13px; font-weight:700; background:#2563eb; color:#fff;" onclick="AdmNt.createForm()">+ নতুন নোটিশ প্রকাশ করুন</button>' +
    '</div>';

  if (!list.length) {
    html += '<div style="text-align:center; padding:48px 16px; background:#ffffff; border:1px dashed #cbd5e1; border-radius:14px; color:#64748b;">' +
      '<div style="font-size:32px; margin-bottom:8px;">📭</div>' +
      '<b style="font-size:15px; color:#0f172a;">কোনো সক্রিয় নোটিশ নেই</b><br>' +
      '<span style="font-size:13px;">নতুন নোটিশ তৈরি করতে উপরের "নতুন নোটিশ প্রকাশ করুন" বাটনে চাপ দিন।</span>' +
      '</div>';
  } else {
    html += '<div style="display:grid; gap:12px;">';
    for (const n of list) {
      const isGlobal = !n.user_id && !n.user_name;
      const targetBadge = isGlobal
        ? '<span style="padding:3px 9px; border-radius:999px; font-size:11px; font-weight:700; background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe;">📢 সকল ইউজার</span>'
        : '<span style="padding:3px 9px; border-radius:999px; font-size:11px; font-weight:700; background:#fef3c7; color:#b45309; border:1px solid #fde68a;">👤 ব্যক্তিগত: ' + esc(n.user_name || n.user_id) + '</span>';

      html += '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:16px 18px; box-shadow:0 1px 3px rgba(0,0,0,0.03); display:flex; justify-content:space-between; align-items:flex-start; gap:14px;">' +
        '<div style="flex:1;">' +
          '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">' +
            '<h4 style="margin:0; font-size:15px; font-weight:700; color:#0f172a;">' + esc(n.title) + '</h4>' +
            targetBadge +
          '</div>' +
          '<div style="font-size:13px; color:#334155; line-height:1.5; white-space:pre-wrap; margin-bottom:8px;">' + esc(n.message) + '</div>' +
          '<div style="font-size:11px; color:#94a3b8;">🕒 প্রকাশিত: ' + new Date(n.created_at).toLocaleString('bn-BD') + '</div>' +
        '</div>' +
        '<button class="mini-btn danger" style="padding:6px 12px; font-size:12px;" onclick="AdmNt.del(' + jqAttr(n.id) + ')">🗑️ ডিলিট</button>' +
      '</div>';
    }
    html += '</div>';
  }
  content.innerHTML = html;
};
window.AdmNt = {
  createForm() {
    modal('🔔 নতুন নোটিশ প্রকাশ করুন',
      fld('শিরোনাম (Title)', 'text', 'nt_title') +
      '<div class="field"><label>নোটিশ বার্তা (Message)</label><textarea id="nt_msg" rows="3" placeholder="গ্রাহকদের জন্য নোটিশ লিখুন…"></textarea></div>' +
      '<div class="field"><label>নির্দিষ্ট ইউজারের জন্য (খালি রাখলে সবাই দেখতে পাবে)</label><input type="text" id="nt_user" placeholder="User ID (ঐচ্ছিক)"></div>' +
      '<button class="btn" style="width:100%; font-weight:700;" onclick="AdmNt.create()">📢 নোটিশ পোস্ট করুন</button>');
  },
  async create() {
    const t = v('nt_title').trim();
    const m = v('nt_msg').trim();
    if (!t || !m) { alert('অনুগ্রহ করে শিরোনাম ও বার্তা লিখুন'); return; }
    const r = await ABC.api('/admin/notices', { method: 'POST', body: {
      title: t, message: m, user_id: v('nt_user').trim() || null,
    }});
    if (!r.ok) { alert('নোটিশ পোস্ট ব্যর্থ'); return; }
    closeModal(); show('notices');
  },
  async del(id) {
    if (!confirm('নোটিশটি ডিলিট করতে চান?')) return;
    await ABC.api('/admin/notices/' + id, { method: 'DELETE' });
    show('notices');
  },
};
/* ---------------- ACTIVITY LOG ---------------- */
TABS.activity = async () => {
  const r = await ABC.api('/admin/activity-log?limit=50');
  const d = await r.json();
  const logs = (d && d.log) || [];

  const ACTION_MAP = {
    'login': { label: '🔐 এডমিন লগইন', cls: 'st-badge info' },
    'recharge_approve': { label: '💰 রিচার্জ অনুমোদন', cls: 'st-badge active' },
    'recharge_reject': { label: '❌ রিচার্জ বাতিল', cls: 'st-badge danger' },
    'order_update': { label: '📦 অর্ডার স্ট্যাটাস', cls: 'st-badge info' },
    'order_deliver': { label: '🚚 ফাইল ডেলিভারি', cls: 'st-badge active' },
    'settings_update': { label: '⚙️ সেটিংস আপডেট', cls: 'st-badge pending' },
    'service_update': { label: '🛠️ সেবা আপডেট', cls: 'st-badge info' },
    'notice_create': { label: '📢 নোটিশ প্রকাশ', cls: 'st-badge active' },
    'notice_delete': { label: '🗑️ নোটিশ মোছা', cls: 'st-badge danger' },
    'user_block': { label: '🚫 ইউজার ব্লক', cls: 'st-badge danger' }
  };

  let html = '<div class="adm-page-head">' +
    '<div>' +
      '<h2 class="adm-page-title">📜 এডমিন অডিট ও অ্যাক্টিভিটি লগ</h2>' +
      '<p class="adm-page-sub">অ্যাডমিনদের দ্বারা পরিচালিত প্রতিটি সংবেদনশীল অপারেশনের অপরিবর্তনীয় অডিট ট্রেইল</p>' +
    '</div>' +
    '<div class="adm-head-actions">' +
      '<span class="st-badge info">সাম্প্রতিক রেকর্ড: ' + bn(logs.length) + '</span>' +
      '<button class="mini-btn" onclick="show(\'activity\')">🔄 রিফ্রেশ লগ</button>' +
    '</div>' +
  '</div>';

  if (!logs.length) {
    html += '<div class="adm-empty-state">' +
      '<div class="adm-empty-icon">📜</div>' +
      '<div class="adm-empty-title">কোনো অডিট লগ রেকর্ড নেই</div>' +
      '<div class="adm-empty-desc">এডমিন প্যানেলে পরিচালিত কোনো কার্যক্রম এখনো রেকর্ড হয়নি।</div>' +
    '</div>';
  } else {
    html += '<div class="adm-table-card">' +
      '<div style="overflow-x:auto;"><table class="adm-table">' +
      '<thead>' +
        '<tr><th>সময় ও তারিখ</th>' +
        '<th>দায়িত্বপ্রাপ্ত এডমিন</th>' +
        '<th>অপারেশন</th>' +
        '<th>কার্যক্রমের বিবরণ</th></tr>' +
      '</thead><tbody>';

    for (const a of logs) {
      const actInfo = ACTION_MAP[a.action] || { label: a.action, cls: 'st-badge info' };
      let detailsFormatted = '';
      try {
        if (typeof a.details === 'object' && a.details !== null) {
          detailsFormatted = Object.entries(a.details)
            .map(([k, v]) => '<span style="display:inline-block; margin-right:8px; background:#f8fafc; padding:2px 6px; border-radius:4px; border:1px solid #e2e8f0;"><b>' + esc(k) + ':</b> ' + esc(String(v)) + '</span>')
            .join(' ');
        } else {
          detailsFormatted = esc(String(a.details || '-'));
        }
      } catch (_) {
        detailsFormatted = esc(String(a.details || '-'));
      }

      html += '<tr>' +
        '<td style="white-space:nowrap; font-size:12px; color:#64748b;">🕒 ' + new Date(a.created_at).toLocaleString('bn-BD') + '</td>' +
        '<td style="font-weight:700; font-size:13px; color:#0f172a;">👤 ' + esc(a.admin_name || 'সুপার এডমিন') + '</td>' +
        '<td><span class="' + actInfo.cls + '">' + actInfo.label + '</span></td>' +
        '<td style="font-size:12px; color:#334155;">' + detailsFormatted + '</td>' +
      '</tr>';
    }

    html += '</tbody></table></div></div>';
  }
  content.innerHTML = html;
};

/* ---------------- SETTINGS ---------------- */
TABS.settings = async () => {
  const r = await ABC.api('/admin/settings');
  const s = await r.json();
  window.__admSettingsCache = s || {};
  let backupInfo = null;
  try {
    const br = await ABC.api('/admin/backup');
    if (br.ok) backupInfo = await br.json();
  } catch (_) {}

  const bool = (key, sub) => {
    const on = s[key] && s[key][sub || 'enabled'];
    return '<button class="mini-btn ' + (on ? 'ok' : '') + '" onclick="AdmSt.toggle(\'' + key + '\',\'' + (sub || 'enabled') + '\',' + (!on) + ')">' + (on ? '✅ চালু' : '❌ বন্ধ') + '</button>';
  };

  const maintMsg = (s.maintenance_mode && s.maintenance_mode.message) || '';
  const sessMin = (s.session_timeout && s.session_timeout.minutes) || 60;
  const maxLogin = (s.login_security && s.login_security.max_attempts) || 5;
  const lockoutMin = (s.login_security && s.login_security.lockout_minutes) || 15;

  let backupLastText = 'কোনো তথ্য নেই';
  if (backupInfo && backupInfo.last && backupInfo.last.at) {
    try {
      backupLastText = new Date(backupInfo.last.at).toLocaleString('bn-BD') + (backupInfo.last.bytes ? ' (' + (backupInfo.last.bytes / 1048576).toFixed(2) + ' MB)' : '');
    } catch (_) { backupLastText = String(backupInfo.last.at); }
  }

  const saveBtn = '<button class="adm-settings-hero-btn" type="button" onclick="AdmSt.save()">💾 সেটিংস সংরক্ষণ</button>';
  const activeTab = AdmSt._activeTab || 'general';

  content.innerHTML =
    '<div class="adm-settings">' +
    // Top Hero Bar with Quick Save Button
    '<div class="adm-settings-hero">' +
      '<div>' +
        '<div class="adm-settings-eyebrow">ADMIN CONTROL CENTER</div>' +
        '<h1>⚙️ সিস্টেম সেটিংস</h1>' +
        '<p>নিরাপত্তা, পেমেন্ট, রিওয়ার্ড, নোটিফিকেশন ও ব্যাকআপ এক জায়গা থেকে পরিচালনা করুন।</p>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;">' +
        saveBtn +
        '<span class="adm-settings-hero-mark">⚙</span>' +
      '</div>' +
    '</div>' +

    // Horizontal Segmented Pill Tabs
    '<div class="adm-settings-nav" id="admSettingsNav">' +
      '<button class="adm-settings-tab ' + (activeTab === 'general' ? 'active' : '') + '" data-tab="general" onclick="AdmSt.switchTab(\'general\')">🛡️ সিস্টেম ও নিরাপত্তা</button>' +
      '<button class="adm-settings-tab ' + (activeTab === 'payment' ? 'active' : '') + '" data-tab="payment" onclick="AdmSt.switchTab(\'payment\')">💳 পেমেন্ট ও রিচার্জ</button>' +
      '<button class="adm-settings-tab ' + (activeTab === 'rewards' ? 'active' : '') + '" data-tab="rewards" onclick="AdmSt.switchTab(\'rewards\')">🎁 বোনাস ও লিমিট</button>' +
      '<button class="adm-settings-tab ' + (activeTab === 'messaging' ? 'active' : '') + '" data-tab="messaging" onclick="AdmSt.switchTab(\'messaging\')">📢 মেসেজিং ও নোটিফিকেশন</button>' +
      '<button class="adm-settings-tab ' + (activeTab === 'voice' ? 'active' : '') + '" data-tab="voice" onclick="AdmSt.switchTab(\'voice\')">🎙️ ভয়েস শুভেচ্ছা</button>' +
      '<button class="adm-settings-tab ' + (activeTab === 'backup' ? 'active' : '') + '" data-tab="backup" onclick="AdmSt.switchTab(\'backup\')">💾 ডাটাবেস ব্যাকআপ</button>' +
    '</div>' +

    // TAB 1: SYSTEM & SECURITY
    '<div class="adm-settings-pane ' + (activeTab === 'general' ? 'active' : '') + '" id="pane_general">' +
      '<div class="form-card adm-settings-card">' +
        '<h2>🛡️ সিস্টেম ও নিরাপত্তা (System & Security)</h2>' +
        '<div class="list-row" style="cursor:default;"><div><div class="t">নতুন ইউজার রেজিস্ট্রেশন</div><div class="s">বন্ধ থাকলে শুধু বিদ্যমান ইউজাররা লগইন করতে পারবেন</div></div>' + bool('registration_enabled') + '</div>' +
        '<div class="list-row" style="cursor:default;"><div><div class="t">মেইনটেন্যান্স মোড</div><div class="s">চালু করলে সাধারণ ব্যবহারকারীদের সাইট বন্ধ দেখাবে</div></div>' + bool('maintenance_mode') + '</div>' +
        ta('মেইনটেন্যান্স নোটিশ / বার্তা', 'st_maint_msg', maintMsg, 'মেইনটেন্যান্স মোড চালু থাকলে গ্রাহকরা এই বার্তাটি দেখতে পাবেন') +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:14px;">' +
          '<div class="field"><label>সেশন টাইমআউট (মিনিট)</label><input type="number" id="st_session_timeout" value="' + sessMin + '"></div>' +
          '<div class="field"><label>ভুল পাসওয়ার্ড লিমিট (লকআউট)</label><input type="number" id="st_max_login" value="' + maxLogin + '"></div>' +
          '<div class="field"><label>লকআউট স্থায়িত্ব (মিনিট)</label><input type="number" id="st_lockout_min" value="' + lockoutMin + '"></div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // TAB 2: PAYMENT & RECHARGE
    '<div class="adm-settings-pane ' + (activeTab === 'payment' ? 'active' : '') + '" id="pane_payment">' +
      '<div class="form-card adm-settings-card">' +
        '<h2>💳 পেমেন্ট হাব ও রিচার্জ নম্বর</h2>' +
        '<p class="s" style="margin-bottom:16px;">গ্রাহক ওয়ালেট রিচার্জের সময় এই নম্বরগুলো দেখতে পাবে এবং টাকা পাঠাবে</p>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;">' +
          fld('বিকাশ পেমেন্ট নম্বর', 'text', 'st_rn_bkash_pay', (((s.recharge_numbers || {}).bkash_payment) || '')) +
          fld('বিকাশ পার্সোনাল নম্বর', 'text', 'st_rn_bkash_per', (((s.recharge_numbers || {}).bkash_personal) || '')) +
          fld('নগদ নম্বর', 'text', 'st_rn_nagad', (((s.recharge_numbers || {}).nagad) || '')) +
          fld('রকেট নম্বর', 'text', 'st_rn_rocket', (((s.recharge_numbers || {}).rocket) || '')) +
        '</div>' +
        '<div style="margin-top:18px;"><div class="s" style="background:var(--bg-muted,#f8fafc);padding:12px 14px;border-radius:8px;border:1px dashed var(--border-light);">💡 ইউজাররা ওয়ালেটে রিচার্জ ফর্ম পূরণের সময় এই নম্বরগুলো লাইভ দেখতে পায়।</div></div>' +
      '</div>' +
    '</div>' +

    // TAB 3: REWARDS & LIMITS
    '<div class="adm-settings-pane ' + (activeTab === 'rewards' ? 'active' : '') + '" id="pane_rewards">' +
      '<div class="form-card adm-settings-card">' +
        '<h2>🎁 রিওয়ার্ড, বোনাস ও পলিসি লিমিট</h2>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;">' +
          '<div class="field"><label>ক্যাশব্যাক হার % (০ = বন্ধ)</label><input type="number" id="st_cb" value="' + ((s.cashback && s.cashback.percent) || 0) + '"><div class="s" style="margin-top:4px;">রিচার্জে ১-ক্লিক কুপন পারসেন্টেজ</div></div>' +
          '<div class="field"><label>ক্যাশব্যাক কুপনের মেয়াদ (দিন)</label><input type="number" id="st_cb_exp" min="1" max="365" value="' + ((s.cashback && s.cashback.expiry_days) || 30) + '"><div class="s" style="margin-top:4px;">কুপন কত দিন ব্যবহার করা যাবে</div></div>' +
          '<div class="field"><label style="display:flex;gap:8px;align-items:center;"><input type="checkbox" id="st_cb_req_svc" style="width:auto;"' + ((s.cashback && s.cashback.require_service_order === false) ? '' : ' checked') + '> সার্ভিসে আগে অর্ডার লাগবে</label><div class="s" style="margin-top:4px;">চালু থাকলে: ক্যাশব্যাক কুপনে নির্দিষ্ট সার্ভিস থাকলে কাস্টমার আগে সেই সার্ভিসে অর্ডার না করলে কুপন ব্যবহার করতে পারবে না। বন্ধ করলে সবাই ব্যবহার করতে পারবে।</div></div>' +
          '<div class="field"><label>🛎️ ক্যাশব্যাক কোন সেবায় সীমাবদ্ধ</label><select id="st_cb_svc"><option value="">সব সেবা (সীমাবদ্ধতা নেই)</option></select><div class="s" style="margin-top:4px;">নির্দিষ্ট সেবা বাছলে ক্যাশব্যাক কুপন শুধু ওই সেবার গ্রাহকের জন্য প্রযোজ্য হবে — সব সেবায় ব্যবহার করা যাবে না। খালি রাখলে সব সেবার জন্য প্রযোজ্য।</div></div>' +
          '<div class="field"><label>স্বাগতম বোনাস (৳, ০ = বন্ধ)</label><input type="number" id="st_wb" value="' + ((s.welcome_bonus && s.welcome_bonus.amount) || 0) + '"><div class="s" style="margin-top:4px;">নতুন ইউজার সাইন-আপ গিফট</div></div>' +
          '<div class="field"><label>ফাইল আপলোড সীমা (MB)</label><input type="number" id="st_mb" value="' + ((s.file_upload && s.file_upload.max_mb) || 5) + '"><div class="s" style="margin-top:4px;">আবেদনে সর্বোচ্চ সাইজ লিমিট</div></div>' +
          '<div class="field"><label>BDRIS আবেদন PDF চার্জ (৳)</label><input type="number" id="st_bdris_pdf" value="' + (Number(s['bdris_apply.pdf_price']) || 0) + '"><div class="s" style="margin-top:4px;">জন্মনিবন্ধন আবেদন PDF ফি</div></div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // TAB 4: MESSAGING & NOTIFICATIONS
    '<div class="adm-settings-pane ' + (activeTab === 'messaging' ? 'active' : '') + '" id="pane_messaging">' +
      '<div class="form-card adm-settings-card">' +
        '<h2>📢 মেসেজিং, অটোমেশন ও অ্যালার্ট (Messaging & Automation)</h2>' +
        '<div style="background:var(--bg-muted,#f8fafc);padding:18px;border-radius:10px;border:1px solid var(--border-light);margin-bottom:16px;">' +
          '<h3 style="margin-top:0;color:var(--primary-600);font-size:15px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;">🔔 অ্যাডমিন লাইভ অ্যালার্ট ও WhatsApp নোটিফিকেশন <span style="font-size:11px;font-weight:600;background:#e0e7ff;color:#3730a3;padding:2px 8px;border-radius:999px;">অ্যাডমিন ডেস্কটপ</span></h3>' +
          '<div class="list-row" style="cursor:default;padding:8px 0;"><div><div class="t">🔊 অ্যাডমিন ভয়েস অ্যালার্ট</div><div class="s">নতুন রিচার্জ/অর্ডারে বাংলা ভয়েস সতর্কবার্তা</div></div>' +
          '<button class="mini-btn ' + (VoiceAlert.enabled ? 'ok' : '') + '" onclick="var on=VoiceAlert.toggle();this.className=\'mini-btn \'+(on?\'ok\':\'\');this.textContent=on?\'✅ চালু\':\'❌ বন্ধ\';">' +
          (VoiceAlert.enabled ? '✅ চালু' : '❌ বন্ধ') + '</button></div>' +
          '<div class="list-row" style="cursor:default;padding:8px 0;"><div><div class="t">🔔 Push নোটিফিকেশন</div><div class="s">স্ক্রিন বন্ধ থাকলেও ব্রাউজার পুশ নোটিফিকেশন</div></div>' +
          '<button class="mini-btn ' + (PushNotify.enabled ? 'ok' : '') + '" onclick="PushNotify.toggle().then(function(on){this.className=\'mini-btn \'+(on?\'ok\':\'\');this.textContent=on?\'✅ চালু\':\'❌ বন্ধ\';}.bind(this))">' +
          (PushNotify.enabled ? '✅ চালু' : '❌ বন্ধ') + '</button></div>' +
        '</div>' +

        '<div style="background:var(--bg-muted,#f8fafc);padding:18px;border-radius:10px;border:1px solid var(--border-light);">' +
          '<div class="list-row" style="cursor:default;padding:8px 0;">' +
            '<div><div class="t">WhatsApp ক্লাউড অটো নোটিফিকেশন</div><div class="s">অর্ডার বা রিচার্জ স্ট্যাটাসে গ্রাহককে স্বয়ংক্রিয় WhatsApp মেসেজ পাঠান</div></div>' + bool('whatsapp') +
          '</div>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0 14px;font-size:12px;">' +
            '<label><input type="checkbox" id="wa_n_order_completed" ' + ((((s.whatsapp||{}).notify||{}).order_completed !== false) ? 'checked' : '') + '> ✅ অর্ডার সফল</label>' +
            '<label><input type="checkbox" id="wa_n_order_failed" ' + ((((s.whatsapp||{}).notify||{}).order_failed !== false) ? 'checked' : '') + '> ❌ অর্ডার ব্যর্থ</label>' +
            '<label><input type="checkbox" id="wa_n_order_cancelled" ' + ((((s.whatsapp||{}).notify||{}).order_cancelled !== false) ? 'checked' : '') + '> 🚫 অর্ডার বাতিল</label>' +
            '<label><input type="checkbox" id="wa_n_recharge_approved" ' + ((((s.whatsapp||{}).notify||{}).recharge_approved !== false) ? 'checked' : '') + '> 💰 রিচার্জ সফল</label>' +
            '<label><input type="checkbox" id="wa_n_recharge_rejected" ' + ((((s.whatsapp||{}).notify||{}).recharge_rejected !== false) ? 'checked' : '') + '> ⚠️ রিচার্জ বাতিল</label>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;">' +
            fld('WhatsApp বিজনেস নম্বর', 'text', 'st_wa_num', ((s.whatsapp || {}).business_number) || '') +
            fld('Phone Number ID', 'text', 'st_wa_phone_id', ((s.whatsapp || {}).phone_number_id) || '') +
          '</div>' +
          '<div class="field" style="margin-top:10px;"><label>Access Token (Password Protected)</label>' +
          '<input type="password" id="st_wa_token" value="" placeholder="নতুন token বসান (খালি রাখলে অপরিবর্তিত থাকবে)" autocomplete="new-password">' +
          '<div class="s" style="margin-top:4px;">' + (((s.whatsapp || {}).access_token_env) ? '✅ Token সেট আছে (ENV)' : ((s.whatsapp || {}).access_token_set ? '✅ Token সেট আছে' : '❌ Token সেট নেই')) + '</div></div>' +
          '<div class="field" style="margin-top:10px;"><button class="mini-btn" onclick="AdmWa.test()">🔗 Test WhatsApp Connection</button></div>' +
          ta('📩 অর্ডার সফল মেসেজ টেমপ্লেট', 'st_wa_order_msg', ((s.whatsapp || {}).order_completed_msg) || '', 'প্লেসহোল্ডার: {name} {order_number} {service_name}') +
          ta('📩 রিচার্জ সফল মেসেজ টেমপ্লেট', 'st_wa_recharge_msg', ((s.whatsapp || {}).recharge_approved_msg) || '', 'প্লেসহোল্ডার: {name} {amount} {balance}') +
        '</div>' +
      '</div>' +
    '</div>' +

    // TAB 5: VOICE GREETING
    '<div class="adm-settings-pane ' + (activeTab === 'voice' ? 'active' : '') + '" id="pane_voice">' +
      '<div class="form-card adm-settings-card">' +
        '<h2>🎙️ কাস্টমার লগইন ভয়েস শুভেচ্ছা (Login Greeting)</h2>' +
        '<div style="background:var(--bg-muted,#f8fafc);padding:18px;border-radius:10px;border:1px solid var(--border-light);">' +
          '<div class="list-row" style="cursor:default;padding:8px 0;"><div><div class="t">ভয়েস শুভেচ্ছা সার্ভিস</div><div class="s">গ্রাহক লগইনের সময় ধর্মভিত্তিক কণ্ঠে শুভেচ্ছা বার্তা প্লে হবে</div></div>' + bool('voice_greeting') + '</div>' +
          '<div class="list-row" style="cursor:default;padding:8px 0;"><div><div class="t">কণ্ঠ রোটেশন (Rotation)</div><div class="s">পুরুষ → মহিলা → শিশু কণ্ঠে পর্যায়ক্রমে প্লে হবে</div></div>' + bool('voice_greeting', 'rotation') + '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:14px;">' +
            fld('ইসলাম গ্রিটিং', 'text', 'st_vg_islam', (((s.voice_greeting||{}).greetings||{}).islam) || 'আসসালামু আলাইকুম') +
            fld('হিন্দু গ্রিটিং', 'text', 'st_vg_hindu', (((s.voice_greeting||{}).greetings||{}).hindu) || 'নমস্কার') +
            fld('বৌদ্ধ গ্রিটিং', 'text', 'st_vg_buddhist', (((s.voice_greeting||{}).greetings||{}).buddhist) || 'নমো বুদ্ধায়') +
            fld('খ্রিস্টান গ্রিটিং', 'text', 'st_vg_christian', (((s.voice_greeting||{}).greetings||{}).christian) || 'প্রভুর শান্তি') +
          '</div>' +
          fld('অন্যান্য গ্রিটিং (খালি রাখলে সময়ভিত্তিক হবে)', 'text', 'st_vg_other', (((s.voice_greeting||{}).greetings||{}).other) || '') +
          '<div style="background:#ffffff;border:1px solid var(--border-light);border-radius:10px;padding:14px;margin-top:14px;box-shadow:var(--shadow-xs);">' +
            '<div style="font-weight:700;font-size:13px;margin-bottom:4px;color:var(--text-main);">🎧 অডিও টেস্ট ও প্রিভিউ প্লেয়ার</div>' +
            '<div class="s" style="margin-bottom:10px;">যেকোনো ধর্মের পুরুষ, মহিলা বা শিশু কণ্ঠের শুভেচ্ছা অডিও প্লে করে পরীক্ষা করুন:</div>' +
            '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">' +
              '<select id="adm_vg_rel" style="padding:6px 10px;border-radius:6px;font-size:12px;">' +
                '<option value="islam">ইসলাম (আসসালামু আলাইকুম)</option>' +
                '<option value="hindu">হিন্দু (নমস্কার)</option>' +
                '<option value="buddhist">বৌদ্ধ (নমো বুদ্ধায়)</option>' +
                '<option value="christian">খ্রিস্টান (প্রভুর শান্তি)</option>' +
                '<option value="other">অন্যান্য (সময়ভিত্তিক)</option>' +
              '</select>' +
              '<select id="adm_vg_voice" style="padding:6px 10px;border-radius:6px;font-size:12px;">' +
                '<option value="male">পুরুষ কণ্ঠ (Male)</option>' +
                '<option value="female">মহিলা কণ্ঠ (Female)</option>' +
                '<option value="child">শিশু কণ্ঠ (Child)</option>' +
              '</select>' +
              '<button class="mini-btn ok" type="button" onclick="AdmSt.testVoiceGreet()">▶ প্লে</button>' +
              '<button class="mini-btn" type="button" onclick="AdmSt.stopVoiceGreet()">⏹ স্টপ</button>' +
            '</div>' +
            '<div id="adm_vg_status" style="font-size:11px;color:var(--text-muted);margin-top:8px;"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // TAB 6: DATABASE BACKUP
    '<div class="adm-settings-pane ' + (activeTab === 'backup' ? 'active' : '') + '" id="pane_backup">' +
      '<div class="form-card adm-settings-card adm-settings-backup">' +
        '<h2>💾 ডাটাবেস ব্যাকআপ ও ব্যবস্থাপনা</h2>' +
        '<div style="display:flex;flex-direction:column;gap:12px;">' +
          '<div style="background:var(--bg-muted,#f8fafc);padding:18px;border-radius:10px;border:1px solid var(--border-light);">' +
            '<div style="font-weight:700;font-size:15px;margin-bottom:6px;color:var(--text-main);display:flex;align-items:center;gap:8px;">🗄️ ফুল ডাটাবেস স্ন্যাপশট</div>' +
            '<div class="s" style="margin-bottom:14px;line-height:1.6;">সর্বশেষ ব্যাকআপ: <b style="color:var(--text-main);">' + esc(backupLastText) + '</b><br>নিয়মিত ব্যাকআপ সার্ভার ক্র্যাশ বা অনিচ্ছাকৃত তথ্য হারানোর হাত থেকে ডাটাবেস সম্পূর্ণ সুরক্ষিত রাখে।</div>' +
            '<button class="mini-btn ok" style="padding:10px 18px;font-size:13px;" onclick="AdmSt.triggerBackup()">⚡ এখনই নতুন ব্যাকআপ তৈরি করুন</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    // BOTTOM SAVE BAR
    '<div class="adm-settings-save-bar" style="margin-top:16px;">' +
      '<div>' +
        '<div style="font-weight:700;font-size:15px;color:var(--text-main);">সেটিংস সংরক্ষণ</div>' +
        '<div class="s">যেকোনো ট্যাবে পরিবর্তন করার পর এই বাটনে ক্লিক করে লাইভ কার্যকর করুন।</div>' +
      '</div>' +
      saveBtn +
    '</div>' +

    '</div>';
  // Cashback service-scope picker: fill services + restore the saved scope.
  try {
    const sr = await ABC.api('/admin/services');
    const sd = await sr.json();
    const selSvc = document.getElementById('st_cb_svc');
    if (selSvc) {
      (sd.services || []).forEach((sv) => {
        const o = document.createElement('option');
        o.value = sv.id; o.textContent = (sv.name_bn || sv.name);
        selSvc.appendChild(o);
      });
      const curSvc = (s.cashback && s.cashback.service_id) || '';
      if (curSvc) selSvc.value = curSvc;
    }
  } catch (_) {}

};

window.AdmSt = {
  _activeTab: 'general',
  switchTab(tabId) {
    AdmSt._activeTab = tabId;
    const nav = document.getElementById('admSettingsNav');
    if (nav) {
      nav.querySelectorAll('.adm-settings-tab').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
      });
    }
    document.querySelectorAll('.adm-settings-pane').forEach(p => {
      p.classList.toggle('active', p.id === ('pane_' + tabId));
    });
  },
  _vgAudio: null,
  testVoiceGreet() {
    try {
      this.stopVoiceGreet();
      const relEl = document.getElementById('adm_vg_rel');
      const voiceEl = document.getElementById('adm_vg_voice');
      const rel = (relEl && relEl.value) || 'islam';
      const voice = (voiceEl && voiceEl.value) || 'male';
      const path = '/audio/greet-' + encodeURIComponent(rel) + '-' + encodeURIComponent(voice) + '.mp3';
      const st = document.getElementById('adm_vg_status');
      if (st) st.textContent = '🔊 লোড হচ্ছে...';
      const a = new Audio(path);
      this._vgAudio = a;
      a.onended = () => { if (st) st.textContent = '✅ প্লে সম্পন্ন'; this._vgAudio = null; };
      a.onerror = () => { if (st) st.textContent = '❌ অডিও ফাইল লোড ব্যর্থ'; this._vgAudio = null; };
      a.play().then(() => {
        if (st) st.textContent = '▶ বাজছে (' + rel + ' - ' + voice + ')';
      }).catch(err => {
        if (st) st.textContent = '⚠️ ব্রাউজার বাধা: ' + (err.message || 'অটোপ্লে সীমাবদ্ধ');
      });
    } catch (e) {
      alert('প্লেব্যাক ত্রুটি: ' + e.message);
    }
  },
  stopVoiceGreet() {
    if (this._vgAudio) {
      try { this._vgAudio.pause(); } catch (_) {}
      this._vgAudio = null;
      const st = document.getElementById('adm_vg_status');
      if (st) st.textContent = '⏹ থামানো হয়েছে';
    }
  },
  async toggle(key, sub, val) {
    const cur = await (await ABC.api('/admin/settings')).json();
    const obj = Object.assign({}, cur[key] || {});
    obj[sub] = val;
    const body = {}; body[key] = obj;
    await ABC.api('/admin/settings', { method: 'PUT', body });
    show('settings');
  },
  async triggerBackup() {
    if (!confirm('ডাটাবেস ব্যাকআপ তৈরি করতে চান?')) return;
    try {
      const r = await ABC.api('/admin/backup', { method: 'POST', body: {} });
      const d = await r.json();
      if (r.ok && d.started) {
        alert('✅ ডাটাবেস ব্যাকআপ প্রসেস ব্যাকগ্রাউন্ডে শুরু হয়েছে!');
        setTimeout(() => show('settings'), 1500);
      } else {
        alert('❌ ব্যাকআপ শুরু ব্যর্থ: ' + (d.error || 'FAILED'));
      }
    } catch (e) {
      alert('❌ ত্রুটি: ' + e.message);
    }
  },
  async save() {
    try {
      const cur = await (await ABC.api('/admin/settings')).json();
      const vg = Object.assign({ enabled: true, rotation: true }, cur.voice_greeting || {});
      vg.greetings = {
        islam: v('st_vg_islam'),
        hindu: v('st_vg_hindu'),
        buddhist: v('st_vg_buddhist'),
        christian: v('st_vg_christian'),
        other: v('st_vg_other'),
      };
      const waCur = Object.assign({ enabled: false, business_number: '' }, cur.whatsapp || {});
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

      const maintCur = Object.assign({ enabled: false, message: '' }, cur.maintenance_mode || {});
      const maintMsg = String(vr('st_maint_msg') || '').trim();

      const putBody = {
        maintenance_mode: {
          enabled: maintCur.enabled === true,
          message: maintMsg || 'সাইট সাময়িক রক্ষণাবেক্ষণের জন্য বন্ধ আছে। কিছুক্ষণের মধ্যে আবার চালু হবে।'
        },
        session_timeout: {
          minutes: Math.max(5, Math.min(1440, Number(v('st_session_timeout')) || 60))
        },
        login_security: {
          max_attempts: Math.max(3, Math.min(20, Number(v('st_max_login')) || 5)),
          lockout_minutes: Math.max(1, Math.min(120, Number(v('st_lockout_min')) || 15))
        },
        welcome_bonus: { enabled: Number(v('st_wb')) > 0, amount: Number(v('st_wb')) || 0 },
        cashback: Object.assign({}, (window.__admSettingsCache && window.__admSettingsCache.cashback) || {}, {
          enabled: Number(v('st_cb')) > 0,
          percent: Number(v('st_cb')) || 0,
          expiry_days: Math.max(1, Math.min(365, Number(v('st_cb_exp')) || 30)),
          require_service_order: !!(document.getElementById('st_cb_req_svc') || {}).checked,
          service_id: (document.getElementById('st_cb_svc') || {}).value || null,
        }),
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
        putBody.admin_password = admin_password;
      }
      const resp = await ABC.api('/admin/settings', { method: 'PUT', body: putBody });
      const rd = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = rd.error === 'WRONG_PASSWORD' ? '❌ ভুল password — token পরিবর্তন হয়নি' : '❌ সংরক্ষণ ব্যর্থ: ' + (rd.error || ('HTTP ' + resp.status));
        alert(msg);
        return;
      }
      alert('✅ সমস্ত সেটিংস সফলভাবে সংরক্ষিত হয়েছে');
      show('settings');
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


/* ---------------- REPORTS (Financial & Operations Hub) ---------------- */
TABS.reports = async () => {
  let sum = { revenue: 0, recharge: 0, byStatus: {}, users: 0 };
  try {
    const r = await ABC.api('/admin/reports/summary');
    if (r.ok) sum = await r.json();
  } catch (e) { /* show zeros with fallback */ }

  const revenue = sum.revenue || 0;
  const walletTotal = sum.recharge || 0;
  const byStatus = sum.byStatus || {};
  const totalOrders = Object.values(byStatus).reduce((a, b) => a + Number(b), 0);

  const ST_BN = {
    new: 'নতুন',
    pending: 'অপেক্ষমান',
    processing: 'প্রসেসিং',
    completed: 'সম্পন্ন',
    delivered: 'ডেলিভার্ড',
    cancelled: 'বাতিল',
    rejected: 'বাতিল',
    hold: 'হোল্ড'
  };

  let html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; flex-wrap:wrap; gap:10px;">' +
    '<div><h3 style="margin:0; font-size:18px; font-weight:800; color:#0f172a;">📊 আর্থিক ও ব্যবসায়িক রিপোর্ট হাব</h3>' +
    '<p style="margin:4px 0 0; font-size:12px; color:#64748b;">প্ল্যাটফর্মের সামগ্রিক রাজস্ব, ওয়ালেট রিচার্জ ও অর্ডার ভিত্তিক অ্যানালিটিক্স</p></div>' +
    '</div>';

  // 1. Metric Stat Cards
  html += '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px; margin-bottom:22px;">' +
    '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:18px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">' +
      '<div style="font-size:12px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:0.04em;">💰 মোট রাজস্ব (Revenue)</div>' +
      '<div style="font-size:26px; font-weight:800; color:#1d4ed8; margin-top:6px;">৳' + bn(revenue) + '</div>' +
      '<div style="font-size:11px; color:#16a34a; margin-top:4px;">সফল ও ডেলিভার্ড অর্ডার থেকে অর্জিত</div>' +
    '</div>' +
    '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:18px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">' +
      '<div style="font-size:12px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:0.04em;">💳 মোট ওয়ালেট রিচার্জ</div>' +
      '<div style="font-size:26px; font-weight:800; color:#16a34a; margin-top:6px;">৳' + bn(walletTotal) + '</div>' +
      '<div style="font-size:11px; color:#64748b; margin-top:4px;">গ্রাহকদের মোট অনুমোদিত ডিপোজিট</div>' +
    '</div>' +
    '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:18px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">' +
      '<div style="font-size:12px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:0.04em;">👥 নিবন্ধিত ইউজার</div>' +
      '<div style="font-size:26px; font-weight:800; color:#0f172a; margin-top:6px;">' + bn(sum.users || 0) + ' জন</div>' +
      '<div style="font-size:11px; color:#64748b; margin-top:4px;">সক্রিয় অ্যাকাউন্ট সংখ্যা</div>' +
    '</div>' +
    '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:18px; box-shadow:0 1px 3px rgba(0,0,0,0.03);">' +
      '<div style="font-size:12px; font-weight:700; color:#64748b; text-transform:uppercase; letter-spacing:0.04em;">📦 মোট অর্ডার প্রবাহ</div>' +
      '<div style="font-size:26px; font-weight:800; color:#7c3aed; margin-top:6px;">' + bn(totalOrders) + ' টি</div>' +
      '<div style="font-size:11px; color:#64748b; margin-top:4px;">সর্বমোট জমাকৃত আবেদনের সংখ্যা</div>' +
    '</div>' +
  '</div>';

  // 2. Custom PDF Report Generator
  html += '<div class="form-card" style="margin-bottom:20px; background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:20px;">' +
    '<h3 style="margin:0 0 6px; font-size:16px; color:#1e40af; display:flex; align-items:center; gap:8px;">📄 কাস্টম PDF স্টেটমেন্ট ডাউনলোড</h3>' +
    '<p style="margin:0 0 16px; font-size:13px; color:#64748b;">তারিখ নির্বাচন করে নির্দিষ্ট সময়কালের অর্ডার বা ওয়ালেট লেনদেনের অফিসিয়াল PDF ডাউনলোড করুন</p>' +
    '<div style="display:flex; flex-wrap:wrap; gap:12px; align-items:flex-end;">' +
      '<div class="field" style="margin:0; flex:1; min-width:160px;"><label>শুরুর তারিখ</label><input type="date" id="rp_from"></div>' +
      '<div class="field" style="margin:0; flex:1; min-width:160px;"><label>শেষের তারিখ</label><input type="date" id="rp_to"></div>' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
        '<button class="mini-btn" type="button" onclick="AdmReports.setPreset(\'today\')">আজ</button>' +
        '<button class="mini-btn" type="button" onclick="AdmReports.setPreset(\'7d\')">শেষ ৭ দিন</button>' +
        '<button class="mini-btn" type="button" onclick="AdmReports.setPreset(\'month\')">চলতি মাস</button>' +
        '<button class="mini-btn" type="button" onclick="AdmReports.setPreset(\'all\')">সব সময়</button>' +
      '</div>' +
    '</div>' +
    '<div style="display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;">' +
      '<button class="btn" style="display:inline-flex; align-items:center; gap:8px; font-weight:700;" onclick="AdmReports.dl(\'orders\')">📥 অর্ডার রিপোর্ট (PDF)</button>' +
      '<button class="btn-secondary" style="display:inline-flex; align-items:center; gap:8px; font-weight:700;" onclick="AdmReports.dl(\'transactions\')">📥 লেনদেন ও রিচার্জ রিপোর্ট (PDF)</button>' +
    '</div>' +
  '</div>';

  // 3. Status Breakdown
  html += '<div class="form-card" style="background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:20px;">' +
    '<h3 style="margin:0 0 14px; font-size:16px; color:#0f172a;">📦 অর্ডার স্ট্যাটাস ব্রেকডাউন</h3>' +
    '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:10px;">';

  const statuses = ['completed', 'delivered', 'processing', 'pending', 'cancelled', 'rejected'];
  statuses.forEach(s => {
    const count = byStatus[s] || 0;
    const pct = totalOrders > 0 ? Math.round((count / totalOrders) * 100) : 0;
    html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px;">' +
      '<div><span class="badge st-' + s + '">' + (ST_BN[s] || s) + '</span><div style="font-size:11px; color:#64748b; margin-top:4px;">' + pct + '% অনুপাত</div></div>' +
      '<b style="font-size:16px; color:#0f172a;">' + bn(count) + 'টি</b></div>';
  });

  html += '</div></div>';
  content.innerHTML = html;
};

/* ---------------- MONITOR (System Health & Engine Watchdog) ---------------- */
TABS.monitor = async () => {
  const r = await ABC.api('/admin/monitor');
  const d = await r.json();
  if (!r.ok) { content.innerHTML = '<div style="color:var(--danger)">⚠️ সার্ভার মনিটর তথ্য লোড ব্যর্থ!</div>'; return; }

  let html = '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px; flex-wrap:wrap; gap:10px;">' +
    '<div><h3 style="margin:0; font-size:18px; font-weight:800; color:#0f172a;">🖥️ রিয়েলটাইম সিস্টেম হেলথ ও সার্ভার মনিটর</h3>' +
    '<p style="margin:4px 0 0; font-size:12px; color:#64748b;">ডাটাবেজ সংযোগ, ইঞ্জিন অ্যাক্টিভিটি ও বিগত ২৪ ঘণ্টার লাইভ পারফরম্যান্স</p></div>' +
    '<button class="mini-btn ok" onclick="show(\'monitor\')">⚡ লাইভ রিফ্রেশ</button>' +
  '</div>';

  // 1. Health Status Grid
  html += '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin-bottom:22px;">' +
    '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px;">' +
      '<div style="font-size:11px; font-weight:700; color:#64748b;">🗄️ PostgreSQL ডাটাবেজ</div>' +
      '<div style="font-size:22px; font-weight:800; color:' + (d.db === 'up' ? '#16a34a' : '#dc2626') + '; margin-top:6px;">' +
        (d.db === 'up' ? '🟢 সচল ও সংযুক্ত' : '🔴 সংযোগ বিচ্ছিন্ন') +
      '</div>' +
    '</div>' +
    '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px;">' +
      '<div style="font-size:11px; font-weight:700; color:#64748b;">📦 অর্ডার প্রবাহ (২৪ ঘণ্টা)</div>' +
      '<div style="font-size:22px; font-weight:800; color:#0f172a; margin-top:6px;">' + bn(d.last24h.orders) + ' টি</div>' +
    '</div>' +
    '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px;">' +
      '<div style="font-size:11px; font-weight:700; color:#64748b;">👥 নতুন ইউজার (২৪ ঘণ্টা)</div>' +
      '<div style="font-size:22px; font-weight:800; color:#2563eb; margin-top:6px;">' + bn(d.last24h.users) + ' জন</div>' +
    '</div>' +
    '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:16px;">' +
      '<div style="font-size:11px; font-weight:700; color:#64748b;">💳 লেনদেন (২৪ ঘণ্টা)</div>' +
      '<div style="font-size:22px; font-weight:800; color:#16a34a; margin-top:6px;">' + bn(d.last24h.transactions) + ' টি</div>' +
    '</div>' +
  '</div>';

  // 2. Recent Server Activity Stream
  html += '<div style="background:#ffffff; border:1px solid #e2e8f0; border-radius:14px; padding:20px;">' +
    '<h4 style="margin:0 0 14px; font-size:16px; color:#0f172a;">📜 সাম্প্রতিক সার্ভার ইভেন্ট ও অ্যাক্টিভিটি</h4>';
  
  if (!(d.recent_activity || []).length) {
    html += '<div style="color:#64748b; font-size:13px; text-align:center; padding:24px;">কোনো সাম্প্রতিক সার্ভার ইভেন্ট নেই</div>';
  } else {
    html += '<div style="display:grid; gap:8px;">';
    d.recent_activity.forEach(a => {
      html += '<div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; font-size:13px;">' +
        '<span style="font-weight:600; color:#1e293b;">' + esc(a.action) + '</span>' +
        '<small style="color:#64748b;">🕒 ' + new Date(a.created_at).toLocaleString('bn-BD') + '</small></div>';
    });
    html += '</div>';
  }
  html += '</div>';
  content.innerHTML = html;
};

/* ---------------- FILE STORAGE (Cloud Storage Hub) ---------------- */
TABS.storage = async () => {
  const r = await ABC.api('/admin/storage');
  const d = await r.json();
  const allFiles = d.files || [];
  const totalBytes = allFiles.reduce((s, f) => s + (f.size || 0), 0);
  const totalMb = (totalBytes / 1024 / 1024).toFixed(2);
  
  TABS._storageList = allFiles;
  const q = (TABS._storageQuery || '').trim().toLowerCase();
  const fType = TABS._storageType || 'all';

  const filtered = allFiles.filter(f => {
    const fn = (f.filename || '').toLowerCase();
    const phone = (f.user_phone || '').toLowerCase();
    const matchesQ = !q || fn.includes(q) || phone.includes(q);
    if (!matchesQ) return false;
    if (fType === 'pdf') return fn.endsWith('.pdf');
    if (fType === 'img') return fn.endsWith('.png') || fn.endsWith('.jpg') || fn.endsWith('.jpeg') || fn.endsWith('.webp');
    return true;
  });

  let html = '<div style="display:flex; flex-direction:column; gap:16px; margin-bottom:20px;">' +
    '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px;">' +
      '<div><h3 style="margin:0; font-size:18px; font-weight:800; color:#0f172a;">📂 ক্লাউড ফাইল ও ডেলিভারি স্টোরেজ</h3>' +
      '<p style="margin:4px 0 0; font-size:12px; color:#64748b;">গ্রাহকদের জমাকৃত আবেদন ডকুমেন্ট ও ডেলিভারি ফাইল ব্যবস্থাপনা</p></div>' +
      (allFiles.length ? '<button class="mini-btn danger" style="padding:7px 14px; font-size:12px;" onclick="AdmStorage.delAll()">🗑️ সব ফাইল সাফ করুন</button>' : '') +
    '</div>' +

    // Storage Metric Overview
    '<div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px;">' +
      '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">' +
        '<div style="font-size:11px; font-weight:700; color:#64748b;">💾 মোট ব্যবহৃত স্টোরেজ</div>' +
        '<div style="font-size:22px; font-weight:800; color:#2563eb; margin-top:4px;">' + totalMb + ' MB</div>' +
      '</div>' +
      '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">' +
        '<div style="font-size:11px; font-weight:700; color:#64748b;">📄 সর্বমোট সংরক্ষিত ফাইল</div>' +
        '<div style="font-size:22px; font-weight:800; color:#0f172a; margin-top:4px;">' + bn(allFiles.length) + ' টি</div>' +
      '</div>' +
      '<div style="background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:14px 16px;">' +
        '<div style="font-size:11px; font-weight:700; color:#64748b;">🔍 ফিল্টারকৃত ফলাফল</div>' +
        '<div style="font-size:22px; font-weight:800; color:#16a34a; margin-top:4px;">' + bn(filtered.length) + ' টি</div>' +
      '</div>' +
    '</div>' +

    // Toolbar & Search
    '<div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; background:#fff; padding:12px 14px; border:1px solid #e2e8f0; border-radius:12px;">' +
      '<div style="display:flex; gap:6px; flex-wrap:wrap;">' +
        '<button class="mini-btn' + (fType === 'all' ? ' ok' : '') + '" onclick="TABS._storageType=\'all\';show(\'storage\')">সকল ফাইল</button>' +
        '<button class="mini-btn' + (fType === 'pdf' ? ' ok' : '') + '" onclick="TABS._storageType=\'pdf\';show(\'storage\')">📕 শুধু PDF</button>' +
        '<button class="mini-btn' + (fType === 'img' ? ' ok' : '') + '" onclick="TABS._storageType=\'img\';show(\'storage\')">🖼️ ছবি (PNG/JPG)</button>' +
      '</div>' +
      '<div style="flex:1; min-width:220px; max-width:360px;">' +
        '<input type="text" placeholder="🔍 ফাইলের নাম বা ইউজার ফোন দিয়ে খুঁজুন…" value="' + esc(TABS._storageQuery || '') + '" oninput="AdmStorage.search(this.value)" style="width:100%; padding:7px 12px; font-size:12px; border-radius:8px; border:1px solid #cbd5e1;">' +
      '</div>' +
    '</div>' +
  '</div>';

  if (!filtered.length) {
    html += '<div style="text-align:center; padding:48px 16px; background:#ffffff; border:1px dashed #cbd5e1; border-radius:14px; color:#64748b;">' +
      '<div style="font-size:32px; margin-bottom:8px;">' + (q ? '🔍' : '📂') + '</div>' +
      '<b style="font-size:15px; color:#0f172a;">' + (q ? 'কোনো ফাইল মেলেনি' : 'স্টোরেজে কোনো ফাইল নেই') + '</b><br>' +
      '<span style="font-size:13px;">' + (q ? 'অনুসন্ধান ফিল্টার পরিবর্তন করে দেখুন।' : 'গ্রাহক ফাইল আপলোড করলে বা ডেলিভারি প্রদান করলে তা এখানে জমা থাকবে।') + '</span>' +
      '</div>';
  } else {
    html += '<div style="display:grid; gap:10px;">';
    filtered.forEach(f => {
      const isPdf = (f.filename || '').toLowerCase().endsWith('.pdf');
      const isImg = /\.(png|jpg|jpeg|webp)$/i.test(f.filename || '');
      const icon = isPdf ? '📕' : (isImg ? '🖼️' : '📄');
      const sizeStr = f.size_kb ? f.size_kb + ' KB' : (Math.round((f.size || 0) / 1024) + ' KB');
      const mtimeStr = f.mtime ? new Date(f.mtime).toLocaleString('bn-BD') : '';

      html += '<div style="display:flex; align-items:center; gap:14px; padding:12px 16px; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; box-shadow:0 1px 2px rgba(0,0,0,0.02); flex-wrap:wrap;">' +
        '<span style="font-size:26px; line-height:1;">' + icon + '</span>' +
        '<div style="flex:1; min-width:220px;">' +
          '<b style="font-size:13px; color:#0f172a; word-break:break-all;">' + esc(f.filename) + '</b><br>' +
          '<small style="color:#64748b; font-size:11px;">👤 ইউজার: ' + esc(f.user_phone || f.user_name || 'সিস্টেম') + ' • সাইজ: ' + sizeStr + (mtimeStr ? ' • ' + mtimeStr : '') + '</small>' +
        '</div>' +
        '<div style="display:flex; align-items:center; gap:8px; margin-left:auto;">' +
          '<button class="mini-btn ok" style="padding:6px 14px; font-size:12px;" onclick="AdmStorage.download(\'' + esc(f.filename) + '\')">⬇️ ডাউনলোড</button>' +
          '<button class="mini-btn danger" style="padding:6px 10px; font-size:12px;" onclick="AdmStorage.del(\'' + esc(f.filename) + '\')">🗑️</button>' +
        '</div>' +
      '</div>';
    });
    html += '</div>';
  }
  content.innerHTML = html;
};

window.AdmStorage = {
  search(q) {
    TABS._storageQuery = q;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      show('storage');
    }, 250);
  },
  async download(fn) {
    try {
      const r = await fetch('/api/admin/storage/' + encodeURIComponent(fn) + '/download', {
        headers: { 'Authorization': 'Bearer ' + getAuthToken() },
      });
      if (!r.ok) { alert('ডাউনলোড ব্যর্থ'); return; }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fn;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    } catch (e) { alert('ডাউনলোড ব্যর্থ হয়েছে'); }
  },
  async del(fn) {
    if (!confirm('ফাইলটি নিশ্চিতভাবে মুছে ফেলতে চান?\n' + fn)) return;
    const r = await ABC.api('/admin/storage/' + encodeURIComponent(fn), { method: 'DELETE' });
    if (r.ok) show('storage'); else alert('মুছে ফেলা ব্যর্থ');
  },
  async delAll() {
    if (!confirm('⚠️ সতর্কতা: স্টোরেজের সব ডেলিভারি ফাইল ডিলিট করবেন?')) return;
    if (!confirm('🔴 চূড়ান্ত নিশ্চিতকরণ: মুছে ফেলা ফাইল আর ফিরে পাওয়া যাবে না!')) return;
    const r = await ABC.api('/admin/storage', { method: 'DELETE' });
    if (r.ok) { alert('✅ স্টোরেজের সকল ফাইল সাফ করা হয়েছে'); show('storage'); }
    else alert('সাফ করা ব্যর্থ');
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
