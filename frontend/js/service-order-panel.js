(function () {
  'use strict';

  const ACTIVE_STATUSES = new Set(['new', 'pending', 'waiting', 'received', 'processing', 'registered']);
  const STATUS_LABELS = {
    new: 'অর্ডার জমা হয়েছে',
    pending: 'যাচাইয়ের অপেক্ষায়',
    waiting: 'অপেক্ষায়',
    received: 'অর্ডার গৃহীত',
    processing: 'কাজ চলছে',
    registered: 'কাজ চলছে',
    completed: 'সম্পন্ন',
    delivered: 'ডেলিভারি হয়েছে',
    failed: 'ব্যর্থ',
    cancelled: 'বাতিল',
    refunded: 'টাকা ফেরত দেওয়া হয়েছে',
  };
  const bn = new Intl.NumberFormat('bn-BD');
  let mountedService;

  function supports(service) {
    return service?.type === 'manual' && !String(service.engine_id || '').trim();
  }

  function checkoutReturn(orderId, failedUploads) {
    if (!mountedService) return null;
    const query = new URLSearchParams({ service: mountedService.id, flow: 'directory', order: orderId });
    if (mountedService.category_id) query.set('category', mountedService.category_id);
    if (failedUploads) query.set('doc_warning', '1');
    return '/order-create.html?' + query + '#serviceOrders';
  }

  function renderOrder(order, focusedId, expanded) {
    const row = document.createElement('details');
    row.className = 'service-order-row';
    row.dataset.orderId = order.id;
    row.open = expanded;
    const header = document.createElement('summary');
    header.className = 'service-order-row-head';
    const info = document.createElement('div');
    const title = document.createElement('strong');
    const status = STATUS_LABELS[order.status] || 'অর্ডারের অবস্থা';
    title.textContent = status;
    const meta = document.createElement('small');
    meta.textContent = 'অর্ডার #' + String(order.id).slice(0, 8) +
      ' · ' + new Date(order.created_at).toLocaleDateString('bn-BD') +
      ' · ৳' + bn.format(Number(order.price) || 0);
    info.append(title, meta);

    const details = document.createElement('a');
    details.className = 'btn btn-secondary';
    details.href = '/order-status.html?' + new URLSearchParams({ id: order.id, flow: 'directory' });
    details.textContent = 'সহায়তা ও অর্ডার পরিচালনা';
    header.append(info);
    row.appendChild(header);
    const timeline = document.createElement('div');
    timeline.className = 'service-order-timeline';
    const statusLine = document.createElement('p');
    statusLine.setAttribute('role', 'status');
    const steps = document.createElement('ol');
    timeline.append(statusLine, steps);
    row.append(timeline);
    let loading = false;
    let loaded = false;
    async function loadTimeline() {
      if (!row.open || loaded || loading) return;
      loading = true;
      statusLine.textContent = 'আপডেট লোড হচ্ছে…';
      try {
        const response = await ABC.api('/orders/' + encodeURIComponent(order.id) + '/history');
        if (!response.ok) throw new Error();
        const { history } = await response.json();
        if (!Array.isArray(history)) throw new Error();
        for (const step of history) {
          const item = document.createElement('li');
          item.textContent = (STATUS_LABELS[step.to_status] || 'অবস্থা বদলেছে') + ' · ' +
            new Date(step.created_at).toLocaleString('bn-BD');
          steps.append(item);
        }
        statusLine.textContent = history.length ? '' : 'এখনো কোনো নতুন আপডেট নেই।';
        loaded = true;
      } catch (_) {
        statusLine.textContent = 'আপডেট পাওয়া যায়নি। বন্ধ করে আবার খুলুন।';
      } finally {
        loading = false;
      }
    }
    row.addEventListener('toggle', loadTimeline);

    const submitted = order.data;
    if (submitted && typeof submitted === 'object') {
      const fields = safeArray(mountedService.fields_required).filter(field => field?.name);
      const data = document.createElement('dl');
      data.className = 'service-order-data';
      for (const field of [{ name: '_manual_form', label: 'জমা দেওয়া তথ্য' }, ...fields]) {
        if (!Object.hasOwn(submitted, field.name) || typeof submitted[field.name] !== 'string' || !submitted[field.name]) continue;
        const label = document.createElement('dt');
        label.textContent = field.label || field.name;
        const value = document.createElement('dd');
        value.textContent = submitted[field.name];
        data.append(label, value);
      }
      if (data.children.length) row.append(data);
    }

    if (order.id === focusedId && new URLSearchParams(location.search).get('doc_warning') === '1') {
      const warning = document.createElement('p');
      warning.className = 'service-order-warning';
      warning.textContent = 'কিছু ফাইল আপলোড হয়নি। অর্ডার পরিচালনা খুলে আবার সংযুক্ত করুন।';
      row.appendChild(warning);
    }

    const canViewFiles = order.status === 'completed' || order.status === 'delivered' ||
      (order.status === 'refunded' && order.delivered_before_refund === true);
    const docs = safeArray(order.documents);
    const deliveryDocs = canViewFiles ? docs.filter(doc => doc?.uploaded_by === 'admin' && doc.filename &&
      !/-receipt\.pdf$/i.test(doc.originalname || doc.filename)) : [];
    if (deliveryDocs.length) {
      const files = document.createElement('div');
      files.className = 'service-order-files';
      const label = document.createElement('strong');
      label.textContent = 'ডেলিভারি ফাইল';
      files.appendChild(label);
      for (const doc of deliveryDocs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn btn-secondary';
        button.textContent = 'ডাউনলোড করুন · ' + (doc.originalname || doc.filename);
        button.addEventListener('click', () => downloadFile(order.id, doc, button));
        files.appendChild(button);
      }
      row.appendChild(files);
    }
    row.append(details);
    if (expanded) loadTimeline();
    return row;
  }

  async function downloadFile(orderId, doc, button) {
    button.disabled = true;
    try {
      const route = '/orders/' + encodeURIComponent(orderId) + '/documents/' + encodeURIComponent(doc.filename);
      const response = await ABC.api(route, { skip503Retry: true });
      if (!response.ok) throw new Error('Delivery file unavailable');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.originalname || doc.filename;
      document.body.appendChild(link);
      link.click();
      setTimeout(() => { URL.revokeObjectURL(url); link.remove(); }, 4000);
      button.textContent = 'ডাউনলোড করুন · ' + (doc.originalname || doc.filename);
    } catch (_) {
      button.textContent = 'আবার ডাউনলোড করুন';
    } finally {
      button.disabled = false;
    }
  }

  function mount(service) {
    const params = new URLSearchParams(location.search);
    if (!supports(service) || params.get('flow') !== 'directory' || mountedService) return;
    const panel = document.getElementById('serviceOrders');
    if (!panel) return;
    mountedService = service;
    const phases = ['active', 'past'].map(name => ({
      name, page: 1, total: 0, fingerprint: '',
      list: panel.querySelector('[data-orders-list="' + name + '"]'),
      previous: panel.querySelector('[data-orders-previous="' + name + '"]'),
      next: panel.querySelector('[data-orders-next="' + name + '"]'),
    }));
    const message = document.getElementById('serviceOrderMessage');
    const refreshButton = document.getElementById('refreshServiceOrders');
    const focus = params.get('order');
    let loading = false;
    let hasPending = false;
    let needsFocus = !!focus;
    let timer;
    panel.hidden = false;

    function scheduleRefresh() {
      clearTimeout(timer);
      if (!document.hidden && hasPending) timer = setTimeout(load, 30000);
    }

    async function readPage(phase, page) {
      const query = new URLSearchParams({ service_id: service.id, phase: phase.name, page, limit: 8 });
      const response = await ABC.api('/orders?' + query);
      if (!response.ok) throw new Error('Orders unavailable');
      const payload = await response.json();
      if (!Array.isArray(payload.orders) || !Number.isFinite(payload.total)) throw new Error('Orders unavailable');
      return { orders: payload.orders.filter(order => order?.id && order.service_id === service.id), total: payload.total };
    }

    function renderPage(phase, page, payload, open) {
      const orders = payload.orders;
      const content = JSON.stringify([page, orders.map(order => [
        order.id, order.status, order.updated_at, order.delivered_before_refund, order.documents,
      ])]);
      if (content !== phase.fingerprint) {
        phase.list.replaceChildren(...orders.map(order => renderOrder(order, focus,
          open.has(order.id) || (needsFocus && order.id === focus))));
        if (!orders.length) phase.list.textContent = phase.name === 'active' ? 'এই সেবায় চলতি অর্ডার নেই।' : 'এই সেবায় আগের অর্ডার নেই।';
        phase.fingerprint = content;
      }
      phase.page = page;
      phase.total = payload.total;
      phase.previous.hidden = page <= 1;
      phase.next.hidden = page * 8 >= payload.total;
    }

    async function load(change, targetPage) {
      if (loading) return;
      loading = true;
      refreshButton.disabled = true;
      for (const phase of phases) phase.previous.disabled = phase.next.disabled = true;
      try {
        const selected = change ? [change] : phases;
        const pages = await Promise.all(selected.map(async phase => {
          const page = phase === change ? targetPage : phase.page;
          const payload = await readPage(phase, page);
          if (page > 1 && (page - 1) * 8 >= payload.total) return { phase, page: 1, payload: await readPage(phase, 1) };
          return { phase, page, payload };
        }));
        const orders = pages.flatMap(entry => entry.payload.orders);
        if (!change && /^[0-9a-f-]{36}$/i.test(focus || '') && !orders.some(order => order.id === focus)) {
          try {
            const res = await ABC.api('/orders/' + encodeURIComponent(focus));
            const { order } = res.ok ? await res.json() : {};
            if (order?.id === focus && order.service_id === service.id) {
              const name = ACTIVE_STATUSES.has(order.status) ? 'active' : 'past';
              pages.find(entry => entry.phase.name === name)?.payload.orders.unshift(order);
            }
          } catch (_) { /* The current service list is still available. */ }
        }
        const open = new Set([...panel.querySelectorAll('details[open][data-order-id]')].map(row => row.dataset.orderId));
        for (const entry of pages) renderPage(entry.phase, entry.page, entry.payload, open);
        if (needsFocus && pages.some(entry => entry.payload.orders.some(order => order.id === focus))) {
          needsFocus = false;
          requestAnimationFrame(() => {
            panel.scrollIntoView({ block: 'start' });
            panel.focus({ preventScroll: true });
          });
        }
        hasPending = phases[0].total > 0;
        message.textContent = '';
      } catch (_) {
        message.textContent = 'অর্ডারের তথ্য আপডেট হয়নি। আবার দেখুন।';
      } finally {
        loading = false;
        refreshButton.disabled = false;
        for (const phase of phases) phase.previous.disabled = phase.next.disabled = false;
        scheduleRefresh();
      }
    }

    refreshButton.addEventListener('click', () => load());
    for (const phase of phases) {
      phase.previous.addEventListener('click', () => load(phase, phase.page - 1));
      phase.next.addEventListener('click', () => load(phase, phase.page + 1));
    }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(timer);
      else load();
    });
    load();
  }

  window.ServiceOrderPanel = { supports, mount, checkoutReturn };
})();
