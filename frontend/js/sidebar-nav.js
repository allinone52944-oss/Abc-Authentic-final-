/* Sidebar presentation + keyboard access. Keeps original onclick handlers; logout reuses the existing endpoint. */
(function () {
  'use strict';
  var MAIN = ['ড্যাশবোর্ড','সকল সেবা','অর্ডার','ইতিহাস','ওয়ালেট','প্রোফাইল','এডমিন কন্ট্রোল'];
  function label(n) { return (n.textContent || '').trim(); }
  function mount() {
    var bar = document.querySelector('.sidebar');
    if (!bar) return;
    bar.querySelectorAll('.side-link').forEach(function (n) {
      var name = label(n);
      if (n.classList.contains('on')) n.setAttribute('aria-current', 'page');
      if (MAIN.indexOf(name) === -1) n.classList.add('side-sub');
      if (!n.getAttribute('onclick')) return;
      n.tabIndex = 0; n.setAttribute('role', 'link');
      n.addEventListener('keydown', function (e) {
        if (e.target === n && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); n.click(); }
      });
    });
    if (!document.getElementById('logoutBtn') && !bar.querySelector('.side-logout') && window.ABC) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'side-logout'; b.textContent = '⏻ লগআউট';
      b.onclick = async function () {
        try { await ABC.api('/auth/logout', { method: 'POST', body: { refresh_token: localStorage.getItem('abc_refresh_token') } }); } catch (e) {}
        ABC.clearTokens(); location.href = '/login.html';
      };
      bar.appendChild(b);
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
