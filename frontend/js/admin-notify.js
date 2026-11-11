// Audit #69 — admin sound/notification chunk, split out of admin.js
// (was ~556 lines inside it). Loads BEFORE admin.js; admin.js drives
// its init (VoiceAlert.init / PushNotify.ensure / autoPrompt) and
// calls admToast() for admin actions.
//
// The chunk only *calls* admin.js helpers (esc/bn/ABC/show) at run
// time, never at load time, so loading it first is safe: every call
// happens after both scripts are loaded.
// Poll every 12 seconds and refresh on return to the tab.
// Null baselines distinguish first load from a legitimate zero count.
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
  _last: { recharge: null, order: null, sms: null, autoMatch: null },
  _checking: false,
  _soundQueue: [],
  _player: null,
  _playing: false,
  _blocked: false,
  _initialized: false,
  _deps: null,

  escape(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]));
  },
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
    // Bound the queue during busy periods; never overlap spoken alerts.
    if (this._soundQueue.length < 8) this._soundQueue.push(file);
    this._drainSound();
  },

  _drainSound() {
    if (!this.enabled || this._playing || !this._soundQueue.length) return;
    try {
      if (!this._player) this._player = new Audio();
      const a = this._player;
      const file = this._soundQueue.shift();
      this._playing = true;
      a.src = '/audio/' + file;
      a.volume = 1.0;
      const finish = () => {
        this._playing = false;
        this._drainSound();
      };
      a.onended = finish;
      a.onerror = () => {
        this.speak(file === 'new-order.mp3' ? 'নতুন অর্ডার এসেছে' : file === 'new-recharge.mp3' ? 'নতুন রিচার্জ এসেছে' : 'নতুন পেমেন্ট এসএমএস এসেছে');
        this.showToast({ title: 'ভয়েস ফাইল চালানো যায়নি', message: 'শব্দ পরীক্ষা করুন', icon: '⚠️', duration: 6000 });
        finish();
      };
      const started = a.play();
      if (started && typeof started.then === 'function') started.then(() => {
        this._blocked = false;
        this._unlocked = true;
        this.updateTopbarBtn();
      }).catch(error => {
        this._playing = false;
        if (error && error.name === 'NotAllowedError') {
          this._soundQueue.unshift(file);
          this._blocked = true;
          this.updateTopbarBtn();
        } else a.onerror();
      });
    } catch (error) {
      this._playing = false;
      this._blocked = true;
      this.updateTopbarBtn();
    }
  },

  stopSound() {
    this._soundQueue = [];
    this._playing = false;
    if (this._player) {
      this._player.onended = null;
      this._player.onerror = null;
      this._player.pause();
    }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
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
      const esc = value => this.escape(value);
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

  init(deps) {
    if (deps) this._deps = deps;
    if (this._initialized) return;
    this._initialized = true;
    try {
      if (typeof window !== 'undefined' && window.speechSynthesis) {
        const load = () => { this._voices = speechSynthesis.getVoices(); };
        load();
        if (speechSynthesis.onvoiceschanged !== undefined) speechSynthesis.onvoiceschanged = load;
      }
      const unlockHandler = () => {
        this.unlock();
        this._blocked = false;
        this._drainSound();
        this.updateTopbarBtn();
      };
      if (typeof document !== 'undefined') {
        document.addEventListener('pointerdown', unlockHandler);
        document.addEventListener('keydown', unlockHandler);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') this.check();
        });
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
        btn.innerHTML = this._blocked || !this._unlocked ? '🔊 শব্দ সক্রিয় করুন' : '🔊 সাউন্ড: চালু';
        btn.title = this._blocked || !this._unlocked ? 'পাশের টেস্ট বোতামে চাপুন' : 'শব্দ বন্ধ করুন';
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
      this.showToast({
        type: 'order',
        icon: '🔊',
        title: 'সাউন্ড চালু',
        message: 'অর্ডার ও রিচার্জের প্রিমিয়াম সাউন্ড নোটিফিকেশন চালু করা হয়েছে।',
        badge: 'অন',
        duration: 4000
      });
    } else {
      this.stopSound();
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
    this.enabled = true;
    localStorage.setItem('abc_voice', 'on');
    this.unlock();
    this.updateTopbarBtn();
    this.playChime('order');
    this.showToast({
      type: 'order', icon: '🔊', title: 'শব্দ পরীক্ষা',
      message: 'ভয়েস শোনা যাচ্ছে কি?', badge: 'পরীক্ষা', duration: 10000
    });
  },

  async check() {
    const user = this._deps && this._deps.getUser ? this._deps.getUser() : null;
    if (!user || user.role !== 'admin' || this._checking) return;
    const esc = value => this.escape(value);
    const bn = value => Number(value || 0).toLocaleString('bn-BD');
    this._checking = true;
    try {
      const r = await ABC.api('/admin/stats');
      if (!r.ok) return;
      const s = await r.json();
      const pr = Number(s.pending_recharge || 0);
      const no = Number(s.orders_new || 0);

      if (this._last.order !== null && no > this._last.order) {
        this.playChime('order');
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
                // P2+P3: no 250ms race — clear the type filter
                // (orders now default to manual, so a new AUTO order
                // must not be hidden), then await the list load and
                // open by id (single-order fetch fallback).
                onAction: () => this._deps.openOrder(latest.id)
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
            // P3: open the unfiltered new list, not the manual default.
            onAction: () => this._deps.openNewOrders()
          });
        }
      }

      if (this._last.recharge !== null && pr > this._last.recharge) {
        this.playChime('recharge');
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
                onAction: () => this._deps.show('recharge')
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
            onAction: () => this._deps.show('recharge')
          });
        }
      }

      this._last.recharge = pr;
      this._last.order = no;

      // Gateway-session premium (2026-11-04): an auto-approved recharge
      // never enters the pending list, so the pending toast above never
      // fires for it. Watch the auto-match count instead and toast on
      // rise with amount + customer + TrxID. First poll only baselines
      // (the _last.autoMatch guard), like the other counters. Session
      // starts produce no signal here by design — no noise.
      try {
        const am = Number(s.auto_matched_recharge || 0);
        if (this._last.autoMatch !== null && am > this._last.autoMatch) {
          this.playChime('recharge');
            const lm = s.latest_auto_match || {};
          this.showToast({
            type: 'recharge',
            icon: '✅',
            title: 'Auto-match রিচার্জ সফল!',
            message: lm.amount
              ? 'গ্রাহক: <b>' + esc(lm.user_name || lm.user_phone || 'গ্রাহক') + '</b><br>পরিমাণ: <b>৳' + bn(lm.amount || 0) + '</b> (TrxID: ' + esc(lm.trxid || '—') + ')'
              : am + 'টি রিচার্জ auto-match এ অনুমোদিত হয়েছে।',
            badge: 'Auto-match',
            actionText: 'SMS গেটওয়ে ➤',
            onAction: () => this._deps.show('sms')
          });
        }
        this._last.autoMatch = am;
      } catch (e) {}

      try {
        const sr = await ABC.api('/admin/stats/sms');
        if (sr.ok) {
          const sd = await sr.json();
          const us = Number(sd.unmatched_sms || 0);
          if (this._last.sms !== null && us > this._last.sms) {
            this.playChime('message');
                this.showToast({
              type: 'chat',
              icon: '📩',
              title: 'আনম্যাচড পেমেন্ট SMS!',
              message: 'নতুন এসএমএস এসেছে কিন্তু কোনো রিচার্জের সাথে মেলেনি।',
              badge: 'SMS',
              actionText: 'SMS গেটওয়ে ➤',
              onAction: () => this._deps.show('sms')
            });
          }
          this._last.sms = us;
        }
      } catch (e) {}
    } catch (e) {} finally { this._checking = false; }
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
