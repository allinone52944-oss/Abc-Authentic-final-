/* Sidebar presentation + keyboard access. Keeps original onclick handlers; logout reuses the existing endpoint. */
(function () {
  'use strict';
  var MAIN = ['ড্যাশবোর্ড','সকল সেবা','অর্ডার','ইতিহাস','ওয়ালেট','প্রোফাইল','এডমিন কন্ট্রোল'];
  function label(n) { return (n.textContent || '').trim(); }

  function mountCategories(bar) {
    if (!window.ABC || bar.querySelector('#serviceMenu')) return;
    const entry = [...bar.querySelectorAll('.side-link')].find(node => label(node) === 'সকল সেবা');
    if (!entry) return;
    let menu = entry.closest('details.service-disclosure');
    if (menu) {
      for (const child of [...menu.children]) if (child !== entry) child.remove();
    } else {
      menu = document.createElement('details');
      menu.className = 'service-disclosure';
      const summary = document.createElement('summary');
      summary.className = entry.className;
      summary.append(...entry.childNodes);
      entry.replaceWith(menu);
      menu.append(summary);
    }
    const list = document.createElement('div');
    list.setAttribute('aria-label', 'সেবার ক্যাটাগরি');
    menu.append(list);
    let loaded = false;
    let loading = false;

    async function load() {
      if (loaded || loading || !menu.open) return;
      loading = true;
      list.textContent = 'ক্যাটাগরি লোড হচ্ছে…';
      try {
        const response = await ABC.api('/services');
        if (!response.ok) throw new Error();
        const { services } = await response.json();
        if (!Array.isArray(services)) throw new Error();
        const groups = new Map();
        for (const service of services) {
          const key = service.category_id || 'uncategorized';
          if (groups.has(key)) continue;
          groups.set(key, {
            name: service.category_name_bn || service.category_name || 'অন্যান্য সেবা',
            serial: service.category_serial ?? Infinity,
          });
        }
        list.replaceChildren();
        for (const [category, group] of [...groups].sort((a, b) => a[1].serial - b[1].serial)) {
          const link = document.createElement('a');
          link.className = 'side-link side-sub';
          link.href = '/services.html?' + new URLSearchParams({ category });
          link.textContent = group.name;
          list.append(link);
        }
        if (!groups.size) list.textContent = 'কোনো ক্যাটাগরি নেই।';
        loaded = true;
      } catch (_) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-secondary';
        retry.textContent = 'আবার চেষ্টা করুন';
        retry.addEventListener('click', load);
        list.replaceChildren(retry);
      } finally {
        loading = false;
      }
    }
    menu.addEventListener('toggle', load);
    load();
  }

  function mount() {
    var bar = document.querySelector('.sidebar');
    if (!bar) return;
    document.querySelectorAll('.sidebar .side-link, .m-tabbar .m-tab').forEach(node => {
      if (label(node) === 'অর্ডার') node.remove();
    });
    if (location.pathname === '/order-create.html' || location.pathname === '/order-status.html') {
      const tab = [...document.querySelectorAll('.m-tabbar .m-tab')].find(node => label(node) === 'সেবা');
      tab?.classList.add('on');
      tab?.setAttribute('aria-current', 'page');
    }
    mountCategories(bar);
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
