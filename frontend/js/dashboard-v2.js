/* Dashboard v2 presentation: quick-action row + recent instant-service history.
   Read-only: uses the existing /history endpoint and owner-only download links.
   Never touches balance, orders, prices or engine logic. */
(function () {
  'use strict';
  function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const BN = '০১২৩৪৫৬৭৮৯';
  const bnNum = n => String(n).replace(/\d/g, d => BN[d]);
  function when(iso) {
    const time = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(time)) return '';
    const m = Math.max(0, Math.floor((Date.now() - time) / 60000));
    if (m < 60) return bnNum(m) + ' মিনিট আগে';
    const h = Math.floor(m / 60); if (h < 24) return bnNum(h) + ' ঘণ্টা আগে';
    return bnNum(Math.floor(h / 24)) + ' দিন আগে';
  }
  const QUICK =
    '<div class="dv2-quick">' +
      '<a class="dv2-q dv2-q-gold" href="/services.html"><span class="dv2-q-ico">🚀</span><span><b>সেবা নিন</b><small>সব সেবা এক জায়গায় →</small></span></a>' +
      '<a class="dv2-q" href="/orders.html"><span class="dv2-q-ico">📦</span><span><b>আমার অর্ডার</b><small>অর্ডারের অবস্থা দেখুন →</small></span></a>' +
      '<details class="service-disclosure dv2-service-menu">' +
        '<summary>সকল সেবা</summary>' +
        '<nav class="dv2-service-links" aria-label="সেবার ধরন">' +
          '<a href="/services.html?type=auto">স্বয়ংক্রিয় সেবা</a>' +
          '<a href="/services.html?type=manual">অর্ডার সার্ভিস</a>' +
        '</nav>' +
      '</details>' +
    '</div>';
  const HIST = suffix =>
    '<div class="dv2-hist card">' +
      '<div class="dv2-hist-hdr"><h3>⚡ সাম্প্রতিক সেবা <small>(ইতিহাস)</small></h3><a href="/history.html">সব দেখুন →</a></div>' +
      '<div class="dv2-hist-list" id="dv2Hist' + suffix + '"><div class="skel" style="height:48px;border-radius:10px;"></div></div>' +
    '</div>';

  const items = [];
  const pendingDownloads = new Set();
  let historyLoading = false;

  async function download(i, button) {
    const doc = items[i]?.documents?.[0];
    if (!doc?.url || pendingDownloads.has(doc.url)) return;
    pendingDownloads.add(doc.url);
    if (button) button.disabled = true;
    try {
      const response = await ABC.api(doc.url);
      if (!response.ok) {
        ABC.showPageMsg(ABC.httpErrBn(response.status, 'ডাউনলোড'), 'err');
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(await response.blob());
      link.download = doc.originalname || doc.filename || 'ডাউনলোড';
      document.body.appendChild(link);
      const url = link.href;
      setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 4000);
      link.click();
    } catch (_) {
      ABC.showPageMsg(ABC.httpErrBn(0, 'ডাউনলোড'), 'err');
    } finally {
      pendingDownloads.delete(doc.url);
      if (button) button.disabled = false;
    }
  }
  window.DashV2 = { download, loadHistory };

  function render(list, target) {
    if (!target) return;
    if (!list.length) {
      target.innerHTML = '<div class="dv2-empty">এখনো কোনো সেবা নেননি — উপরের <b>সেবা নিন</b> চাপুন</div>';
      return;
    }
    target.innerHTML = list.map(({ it, i }) => {
      const failed = /— ব্যর্থ$/.test(it.title || '');
      const has = Boolean(it.documents?.[0]?.url);
      const ago = when(it.created_at);
      return '<div class="dv2-row">' +
        '<span class="dv2-dot ' + (failed ? 'bad' : 'ok') + '" aria-hidden="true">' + (failed ? '✕' : '✓') + '</span>' +
        '<div class="dv2-row-main"><b>' + esc(it.title || 'সেবা') + '</b>' + (ago ? '<small>' + esc(ago) + '</small>' : '') + '</div>' +
        (has ? '<button type="button" class="dv2-dl" onclick="DashV2.download(' + i + ',this)">⬇ ডাউনলোড</button>'
             : '<span class="dv2-tag">' + (failed ? 'ফাইল তৈরি হয়নি' : '—') + '</span>') +
      '</div>';
    }).join('');
  }

  async function loadHistory(button) {
    if (historyLoading) return;
    historyLoading = true;
    if (button) button.disabled = true;
    try {
      const r = await ABC.api('/history');
      if (!r.ok) throw new Error('bad');
      const d = await r.json();
      items.length = 0;
      if (!Array.isArray(d?.items)) throw new Error('bad');
      d.items.forEach(x => items.push(x));
      // /history is a unified archive. This panel is only instant engine work;
      // keep original indices so downloads still address the correct stored file.
      const top = items.map((it, i) => ({ it, i }))
        .filter(({ it }) => it.kind === 'engine' || it.kind === 'bdris').slice(0, 3);
      render(top, document.getElementById('dv2HistD'));
      render(top, document.getElementById('dv2HistM'));
    } catch (e) {
      ['dv2HistD', 'dv2HistM'].forEach(id => {
        const t = document.getElementById(id);
        if (t) t.innerHTML = '<div class="dv2-empty">সাম্প্রতিক সেবা লোড হয়নি। <button type="button" class="dv2-retry" onclick="DashV2.loadHistory(this)">আবার চেষ্টা করুন</button></div>';
      });
    } finally {
      historyLoading = false;
      if (button) button.disabled = false;
    }
  }

  function mount() {
    document.body.classList.add('dash-v2');
    const sub = document.querySelector('.dash-top-title p'); if (sub) sub.textContent = 'আজ কী করতে চান?';
    const hero = document.querySelector('.hero-blue');
    if (hero && !document.querySelector('.dv2-quick')) hero.insertAdjacentElement('afterend', el(QUICK));
    // Approved order: top cards -> history -> my orders -> special services -> rest -> notices
    const ws = document.querySelector('.workspace-overview');
    const ro = document.querySelector('.recent-orders-card');
    if (ws && ro) {
      const hist = el(HIST('D'));
      ws.insertBefore(hist, ws.firstChild);
      hist.insertAdjacentElement('afterend', ro);
      const pop = document.querySelector('.popular-panel');
      if (pop) ro.insertAdjacentElement('afterend', pop);
      const stats = document.querySelector('.account-overview > .stats');
      const engine = document.querySelector('.engine-hub-section');
      const notices = document.querySelector('.notices-panel');
      const help = document.querySelector('.help-card-desk');
      [notices, engine, stats, help].forEach(n => { if (n && n.parentElement) ws.appendChild(n); });
    }
    const mBal = document.querySelector('.m-bal');
    if (mBal) mBal.insertAdjacentElement('afterend', el(QUICK.replace('dv2-quick', 'dv2-quick dv2-quick-m')));
    const mOrders = document.getElementById('recentOrdersMob');
    if (mOrders) { mOrders.insertAdjacentElement('beforebegin', el(HIST('M'))); mOrders.insertAdjacentElement('beforebegin', el('<h3 class="dv2-m-title">📦 আমার অর্ডার <small>(হাতে করা কাজ)</small></h3>')); }
    const mc = document.querySelector('.mobile-only .m-content');
    const mHelp = mc && mc.querySelector('.help-card-desk');
    const mEng = document.getElementById('engineGridMob');
    const mEngSec = mEng && mEng.parentElement;
    const mStats = mc && mc.querySelector('.m-stats-grid');
    if (mc && mHelp) { [mEngSec, mStats].forEach(n => { if (n && n !== mc) mc.insertBefore(n, mHelp); }); }
    if (window.ABC && ABC.api) loadHistory();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
