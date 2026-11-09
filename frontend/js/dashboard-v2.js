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
    const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 60) return bnNum(m) + ' মিনিট আগে';
    const h = Math.round(m / 60); if (h < 24) return bnNum(h) + ' ঘণ্টা আগে';
    return bnNum(Math.round(h / 24)) + ' দিন আগে';
  }
  const QUICK =
    '<div class="dv2-quick">' +
      '<a class="dv2-q dv2-q-gold" href="/services.html"><span class="dv2-q-ico">🚀</span><span><b>সেবা নিন</b><small>সব সেবা এক জায়গায় →</small></span></a>' +
      '<a class="dv2-q" href="/orders.html"><span class="dv2-q-ico">📦</span><span><b>অর্ডার ও ইতিহাস</b><small>হাতে করা কাজের অবস্থা →</small></span></a>' +
    '</div>';
  const HIST = suffix =>
    '<div class="dv2-hist card">' +
      '<div class="dv2-hist-hdr"><h3>⚡ সাম্প্রতিক সেবা <small>(ইতিহাস)</small></h3><a href="/history.html">সব দেখুন →</a></div>' +
      '<div class="dv2-hist-list" id="dv2Hist' + suffix + '"><div class="skel" style="height:48px;border-radius:10px;"></div></div>' +
    '</div>';

  const items = [];
  async function download(i) {
    const d = items[i] && items[i].documents && items[i].documents[0];
    if (!d) return;
    const w = window.open('', '_blank');
    try {
      const r = await ABC.api(d.url);
      if (!r.ok) throw new Error('bad');
      const url = URL.createObjectURL(await r.blob());
      if (w) w.location.href = url; else location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { if (w) w.close(); alert('ফাইল পাওয়া যায়নি — ইতিহাস পাতা থেকে চেষ্টা করুন'); }
  }
  window.DashV2 = { download };

  function render(list, target) {
    if (!target) return;
    if (!list.length) {
      target.innerHTML = '<div class="dv2-empty">এখনো কোনো সেবা নেননি — উপরের <b>সেবা নিন</b> চাপুন</div>';
      return;
    }
    target.innerHTML = list.map(({ it, i }) => {
      const failed = /— ব্যর্থ$/.test(it.title || '');
      const has = it.documents && it.documents.length;
      return '<div class="dv2-row">' +
        '<span class="dv2-dot ' + (failed ? 'bad' : 'ok') + '">' + (failed ? '✕' : '✓') + '</span>' +
        '<div class="dv2-row-main"><b>' + esc(it.title || 'সেবা') + '</b><small>' + esc(when(it.created_at)) + '</small></div>' +
        (has ? '<button class="dv2-dl" onclick="DashV2.download(' + i + ')">⬇ ডাউনলোড</button>'
             : '<span class="dv2-tag">' + (failed ? 'চার্জ কাটা হয়নি' : '—') + '</span>') +
      '</div>';
    }).join('');
  }

  async function loadHistory() {
    try {
      const r = await ABC.api('/history');
      if (!r.ok) throw new Error('bad');
      const d = await r.json();
      items.length = 0;
      (d.items || []).forEach(x => items.push(x));
      const top = items.map((it, i) => ({ it, i })).slice(0, 3);
      render(top, document.getElementById('dv2HistD'));
      render(top, document.getElementById('dv2HistM'));
    } catch (e) {
      ['dv2HistD', 'dv2HistM'].forEach(id => {
        const t = document.getElementById(id);
        if (t) t.innerHTML = '<div class="dv2-empty">লোড হয়নি — <a href="/history.html">ইতিহাস পাতায় দেখুন</a></div>';
      });
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
