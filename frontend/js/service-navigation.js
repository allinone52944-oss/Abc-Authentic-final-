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
    'land-khatian': '/land-khatian.html',
    'land-search': '/land-khatian.html',
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
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (category) params.set('category', category);
    return '/services.html' + (params.size ? '?' + params : '');
  }

  function destination(service) {
    const context = new URLSearchParams({
      service: service.id, flow: 'directory', category: service.category_id || 'uncategorized',
    });
    if (isManual(service)) {
      return '/order-create.html?' + context;
    }
    if (service.open !== true) return detailHref(service);
    if (!Object.hasOwn(enginePages, service.engine_id)) return detailHref(service);
    const page = enginePages[service.engine_id];
    return page + (page.includes('?') ? '&' : '?') + context;
  }

  window.ServiceNavigation = { destination, isManual, catalogHref, mountHistory };

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

  async function customerApi(path) {
    if (window.ABC?.api) return window.ABC.api(path, { timeout: 12000 });
    // BDRIS application has its own shared token and refresh coordinator.
    const fetchAuthorized = () => fetch('/api' + path, {
      headers: { Authorization: 'Bearer ' + window.getToken() },
      signal: AbortSignal.timeout(12000),
    });
    const response = await fetchAuthorized();
    if (response.status !== 401) return response;
    const state = await window.refreshAccessToken();
    if (state === 'transient') throw new Error('Session check unavailable');
    return state === 'ok' ? fetchAuthorized() : response;
  }

  function mountHistory(workspace, id) {
    if (!workspace || !id || workspace.querySelector('.directory-work-history')) return;
    const panel = document.createElement('section');
    panel.className = 'directory-work-history';
    panel.innerHTML = '<header><h2>আগের কাজ</h2><button type="button" class="btn btn-secondary">আবার দেখুন</button></header>' +
      '<p role="status"></p><div class="directory-history-list"></div>';
    workspace.append(panel);
    const refresh = panel.querySelector('button');
    const message = panel.querySelector('p');
    const list = panel.querySelector('.directory-history-list');
    let fingerprint;
    let timer;
    let visibleCount = 6;
    let rows = [];
    const more = document.createElement('button');
    more.className = 'btn btn-secondary';
    more.type = 'button';
    more.textContent = 'আরও দেখুন';
    more.hidden = true;
    panel.append(more);

    function render() {
      list.replaceChildren();
      for (const item of rows.slice(0, visibleCount)) {
        const row = document.createElement('article');
        const heading = document.createElement('strong');
        heading.textContent = item.title;
        const date = document.createElement('small');
        const time = new Date(item.created_at);
        date.textContent = Number.isFinite(time.getTime()) ? time.toLocaleDateString('bn-BD') : '';
        row.append(heading, date);
        const failure = item.tin_failure || item.premium_failure;
        if (failure) {
          const detail = document.createElement('p');
          detail.textContent = failure.refunded ? 'রিপোর্ট পাওয়া যায়নি। চার্জ ফেরত দেওয়া হয়েছে।'
            : 'রিপোর্ট পাওয়া যায়নি। চার্জ কাটা হয়েছে ৳' + Number(failure.chargedAmount).toLocaleString('bn-BD') + '।';
          row.append(detail);
        }
        for (const doc of item.documents || []) {
          const path = typeof doc.url === 'string' ? doc.url.replace(/^\/api\//, '/') : '';
          if (!/^\/(?:orders|manual|engine-jobs|bdris-apply)\//.test(path)) continue;
          const download = document.createElement('button');
          download.className = 'btn btn-secondary';
          download.type = 'button';
          download.textContent = doc.originalname || doc.filename || 'ফাইল ডাউনলোড';
          download.addEventListener('click', async () => {
            download.disabled = true;
            message.textContent = '';
            try {
              const response = await customerApi(path);
              if (!response.ok || /(?:text\/html|application\/json)/i.test(response.headers.get('content-type') || '')) throw new Error();
              const href = URL.createObjectURL(await response.blob());
              const link = document.createElement('a');
              link.href = href;
              link.download = doc.originalname || doc.filename || 'delivery';
              document.body.append(link);
              link.click();
              link.remove();
              setTimeout(() => URL.revokeObjectURL(href), 4000);
            } catch (_) {
              message.textContent = 'ফাইলটি নামানো যায়নি। আবার চেষ্টা করুন।';
            } finally {
              download.disabled = false;
            }
          });
          row.append(download);
        }
        list.append(row);
      }
      more.hidden = visibleCount >= rows.length;
    }

    async function load() {
      if (refresh.disabled) return;
      refresh.disabled = true;
      if (!fingerprint) message.textContent = 'আগের কাজ লোড হচ্ছে…';
      try {
        const response = await customerApi('/history?' + new URLSearchParams({ service_id: id }));
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (!Array.isArray(data.items)) throw new Error();
        const content = JSON.stringify(data.items);
        if (fingerprint !== content) {
          fingerprint = content;
          rows = data.items;
          render();
        }
        message.textContent = rows.length ? '' : 'এই সেবায় এখনো কোনো আগের কাজ নেই।';
      } catch (_) {
        message.textContent = 'আগের কাজ আনা যায়নি। আবার চেষ্টা করুন।';
      } finally {
        refresh.disabled = false;
      }
    }
    const results = '#result, #okBox, #errBox, .ok, .failbox, [data-engine-feedback]';
    new MutationObserver(changes => {
      if (!changes.some(change => {
        const target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
        return target && !panel.contains(target) && (target.matches(results) || target.closest(results));
      })) return;
      clearTimeout(timer);
      timer = setTimeout(load, 1400);
    }).observe(workspace, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    refresh.addEventListener('click', load);
    more.addEventListener('click', () => { visibleCount += 6; render(); });
    load();
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
    if (!Object.values(enginePages).some(page => page.split('?')[0] === location.pathname)) return;
    const workspace = document.querySelector('.service-workspace .main, .page-bdris-apply .wrap > main');
    if (!workspace) return;
    const entrySlot = workspace.querySelector('[data-service-entry-slot]');
    const panel = document.createElement('section');
    panel.className = 'directory-service-entry';
    const links = document.createElement('nav');
    links.setAttribute('aria-label', 'সেবার লিংক');
    const back = engineLink('← সেবার তালিকা', catalogHref(null, query.get('category')));
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
        const response = await customerApi('/services/' + encodeURIComponent(id));
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
        if (service?.id === id) back.href = catalogHref(null, query.get('category') || service.category_id || 'uncategorized');
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
        mountHistory(workspace, service.id);
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
