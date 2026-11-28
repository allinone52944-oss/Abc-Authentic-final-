/* Sidebar presentation + keyboard access. Keeps original onclick handlers; logout reuses the existing endpoint. */
(function () {
  'use strict';
  var MAIN = ['ড্যাশবোর্ড','সকল সেবা','অর্ডার','ইতিহাস','ওয়ালেট','প্রোফাইল','এডমিন কন্ট্রোল'];
  function label(n) { return (n.textContent || '').trim(); }

  function renderCategories(list, services) {
    const groups = new Map();
    const query = new URLSearchParams(location.search);
    const selected = query.get('service') || (location.pathname === '/service-detail.html' ? query.get('id') : null);
    const activeCategory = query.get('category') || services.find(service => service.id === selected)?.category_id;
    for (const service of services) {
      const key = service.category_id || 'uncategorized';
      if (!groups.has(key)) groups.set(key, {
        name: service.category_name_bn || service.category_name || 'অন্যান্য সেবা',
        serial: service.category_serial ?? Infinity,
        services: [],
      });
      groups.get(key).services.push(service);
    }
    list.replaceChildren();
    list.classList.add('service-sidebar-groups');
    for (const [category, group] of [...groups].sort((a, b) => a[1].serial - b[1].serial)) {
      const item = document.createElement('li');
      const details = document.createElement('details');
      details.className = 'service-disclosure service-sidebar-category';
      details.name = 'service-sidebar-category';
      const summary = document.createElement('summary');
      summary.textContent = group.name;
      const children = document.createElement('ul');
      for (const service of group.services.sort((a, b) => (a.serial ?? Infinity) - (b.serial ?? Infinity))) {
        const child = document.createElement('li');
        const link = document.createElement('a');
        link.href = window.ServiceNavigation.destination(service);
        link.textContent = service.name_bn || service.name;
        if (service.id === selected) link.setAttribute('aria-current', 'page');
        child.append(link);
        children.append(child);
      }
      details.append(summary, children);
      details.open = category === activeCategory || (!activeCategory && group.services.some(service => service.id === selected));
      item.append(details);
      list.append(item);
    }
    if (!groups.size) {
      const empty = document.createElement('li');
      empty.textContent = 'কোনো ক্যাটাগরি নেই।';
      list.append(empty);
    }
  }

  window.ServiceSidebar = { renderCategories };

  function mountCategories(bar) {
    if (!window.ABC || !window.ServiceNavigation || bar.querySelector('#serviceMenu')) return;
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
    const list = document.createElement('ul');
    list.className = 'service-sidebar-groups';
    list.setAttribute('aria-label', 'সেবার ক্যাটাগরি');
    menu.append(list);
    const query = new URLSearchParams(location.search);
    if (matchMedia('(min-width: 1024px)').matches &&
        (query.has('category') || query.has('service') || (location.pathname === '/service-detail.html' && query.has('id')))) {
      menu.open = true;
    }
    let loaded = false;
    let loading = false;

    async function load() {
      if (loaded || loading || !menu.open) return;
      loading = true;
      const status = document.createElement('li');
      status.textContent = 'ক্যাটাগরি লোড হচ্ছে…';
      list.replaceChildren(status);
      try {
        const response = await ABC.api('/services');
        if (!response.ok) throw new Error();
        const { services } = await response.json();
        if (!Array.isArray(services)) throw new Error();
        renderCategories(list, services);
        loaded = true;
      } catch (_) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'btn btn-secondary';
        retry.textContent = 'আবার চেষ্টা করুন';
        retry.addEventListener('click', load);
        status.replaceChildren(retry);
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
