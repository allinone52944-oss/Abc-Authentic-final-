/* Customer catalog navigation and entry checks. Engine forms own execution. */
(function () {
  'use strict';
  const enginePages = Object.freeze({
    'auto-tin': '/auto-tin.html',
    'bdris-apply': '/bdris-apply.html',
    'birth-final': '/birth-final.html',
    'death-final': '/death-final.html',
    'epassport': '/epassport.html',
    'land-mouza-map': '/land-mouza-map.html',
    'land-mouza-value': '/land.html?mode=mouza',
    'land-scan': '/land.html?mode=scan',
    'land-verify': '/land.html?mode=verify',
    'nid-replica': '/nid-replica.html',
    'nid-auto-server-copy': '/nid-auto-server-copy.html',
    'nid-server-copy': '/nid-server-copy.html',
    'nid-server-report': '/nid-server-report.html',
    'nid-smart-card': '/nid-smart-card.html',
    'passport': '/passport.html',
    'qr-photo-verify': '/qr-photo-verify.html',
  });

  function detailHref(service) {
    return '/service-detail.html?id=' + encodeURIComponent(service.id);
  }

  function isManual(service) {
    return service?.type === 'manual' && !String(service.engine_id || '').trim();
  }

  function catalogHref(type, category) {
    const params = new URLSearchParams({ type });
    if (category) params.set('category', category);
    return '/services.html?' + params;
  }

  function destination(service) {
    if (isManual(service)) {
      return '/order-create.html?service=' + encodeURIComponent(service.id) + '&flow=directory';
    }
    if (service.open !== true) return detailHref(service);
    if (service.engine_id === 'land-khatian') {
      return '/land-khatian.html?service=' + encodeURIComponent(service.id);
    }
    if (!Object.hasOwn(enginePages, service.engine_id)) return detailHref(service);
    const page = enginePages[service.engine_id];
    return page + (page.includes('?') ? '&' : '?') + 'service=' + encodeURIComponent(service.id) + '&flow=directory';
  }

  window.ServiceNavigation = { destination, isManual, catalogHref };

  function enhance() {
    document.querySelectorAll('.svc-card[onclick],.cat-card[onclick],.svc2[onclick],.back-nav[onclick]').forEach(function (node) {
      if (node.dataset.keyboardReady) return;
      node.dataset.keyboardReady = 'true'; node.tabIndex = 0;
      node.setAttribute('role', 'link');
      node.addEventListener('keydown', function (event) {
        if (event.target !== node || event.key !== 'Enter') return;
        event.preventDefault(); node.click();
      });
    });
  }

  async function loadService(id) {
    const path = '/services/' + encodeURIComponent(id);
    if (window.ABC?.api) return window.ABC.api(path, { timeout: 12000 });
    // BDRIS application has its own shared token and refresh coordinator.
    const fetchService = () => fetch('/api' + path, {
      headers: { Authorization: 'Bearer ' + window.getToken() },
      signal: AbortSignal.timeout(12000),
    });
    const response = await fetchService();
    if (response.status !== 401) return response;
    const state = await window.refreshAccessToken();
    if (state === 'transient') throw new Error('Session check unavailable');
    return state === 'ok' ? fetchService() : response;
  }

  function engineLink(label, href) {
    const link = document.createElement('a');
    link.textContent = label;
    link.href = href;
    return link;
  }

  function serviceNotes(service) {
    const notes = document.createElement('details');
    const title = document.createElement('summary');
    title.textContent = 'প্রয়োজনীয় তথ্য ও নিয়ম';
    notes.append(title);
    if (service.rules_text) {
      const rules = document.createElement('p');
      rules.textContent = service.rules_text;
      notes.append(rules);
    }
    if (Array.isArray(service.documents_required) && service.documents_required.length) {
      const list = document.createElement('ul');
      for (const doc of service.documents_required) {
        const name = typeof doc === 'string' ? doc : doc?.name;
        if (!name) continue;
        const item = document.createElement('li');
        item.textContent = name + (doc?.required === false ? ' (ঐচ্ছিক)' : '');
        list.append(item);
      }
      if (list.children.length) notes.append(list);
    }
    return notes.children.length > 1 ? notes : null;
  }

  function mountEngine() {
    const query = new URLSearchParams(location.search);
    const id = query.get('service');
    if (!id || query.get('flow') !== 'directory') return;
    const workspace = document.querySelector('.service-workspace .main, .page-bdris-apply .wrap > main');
    if (!workspace) return;
    const entrySlot = workspace.querySelector('[data-service-entry-slot]');
    const panel = document.createElement('section');
    panel.className = 'directory-service-entry';
    const links = document.createElement('nav');
    links.setAttribute('aria-label', 'সেবার লিংক');
    const back = engineLink('← সেবার তালিকা', catalogHref('auto', query.get('category')));
    links.append(back);
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-secondary';
    retry.textContent = 'আবার চেষ্টা করুন';
    retry.hidden = true;
    panel.append(links, status, retry);
    workspace.prepend(panel);
    workspace.classList.add('directory-service-paused');

    async function check() {
      retry.hidden = true;
      status.textContent = 'সেবা লোড হচ্ছে…';
      try {
        const response = await loadService(id);
        if (response.status === 401) {
          location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
          return;
        }
        if (response.status === 403 || response.status === 404) {
          status.textContent = 'এই সেবাটি এখন আপনার জন্য খোলা নেই।';
          return;
        }
        if (!response.ok) throw new Error('Service check unavailable');
        const { service } = await response.json();
        if (service?.id === id) back.href = catalogHref('auto', query.get('category') || service.category_id || 'uncategorized');
        const engine = service && Object.hasOwn(enginePages, service.engine_id) && enginePages[service.engine_id];
        const route = engine && new URL(engine, location.origin);
        if (!route || service.id !== id || service.open !== true || route.pathname !== location.pathname ||
            route.searchParams.get('mode') !== query.get('mode')) {
          status.textContent = 'এই সেবাটি এখন খোলা যাচ্ছে না। তালিকা থেকে আবার বেছে নিন।';
          return;
        }
        links.append(engineLink(entrySlot ? 'নিয়ম ও ছাড়' : 'সেবার বিস্তারিত ও ছাড়', detailHref(service)));
        const notes = entrySlot ? null : serviceNotes(service);
        if (notes) panel.append(notes);
        status.remove();
        retry.remove();
        if (entrySlot) entrySlot.replaceChildren(panel);
        workspace.classList.remove('directory-service-paused');
        // Open the existing form view. The native create action stays user-initiated.
        if (service.engine_id === 'passport' || service.engine_id === 'epassport') {
          document.getElementById('start-passport-button')?.click();
        }
        if (service.engine_id === 'bdris-apply') {
          document.getElementById('mAuto')?.click();
        }
      } catch (_) {
        status.textContent = 'সেবা লোড হয়নি। সংযোগ দেখে আবার চেষ্টা করুন।';
        retry.hidden = false;
      }
    }

    retry.addEventListener('click', check);
    check();
  }

  function mount() {
    if (document.body.matches('.page-services, .flagship-dashboard')) {
      enhance();
      new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true });
    }
    mountEngine();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
