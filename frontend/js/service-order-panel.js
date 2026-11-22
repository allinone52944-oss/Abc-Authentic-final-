(function () {
  'use strict';

  const PILOT_SERVICE = 'da426b90-e01b-42a6-9393-90805221d0a1';
  const ACTIVE_STATUSES = new Set(['new', 'pending', 'received', 'processing', 'registered']);
  const STATUS_LABELS = {
    new: 'অর্ডার জমা হয়েছে',
    pending: 'যাচাইয়ের অপেক্ষায়',
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
    return service?.id === PILOT_SERVICE && service.type === 'manual' && !service.engine_id;
  }

  function checkoutReturn(orderId, failedUploads) {
    if (!mountedService) return null;
    const query = new URLSearchParams({ service: mountedService.id, flow: 'directory', order: orderId });
    if (failedUploads) query.set('doc_warning', '1');
    return '/order-create.html?' + query + '#serviceOrders';
  }

  function renderOrder(order, focusedId) {
    const row = document.createElement('article');
    row.className = 'service-order-row';
    const header = document.createElement('div');
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
    details.href = '/order-status.html?id=' + encodeURIComponent(order.id);
    details.textContent = 'বিস্তারিত';
    header.append(info, details);
    row.appendChild(header);

    if (order.id === focusedId && new URLSearchParams(location.search).get('doc_warning') === '1') {
      const warning = document.createElement('p');
      warning.className = 'service-order-warning';
      warning.textContent = 'কিছু ফাইল আপলোড হয়নি। বিস্তারিত খুলে আবার সংযুক্ত করুন।';
      row.appendChild(warning);
    }

    const canViewFiles = order.status === 'completed' || order.status === 'delivered' ||
      (order.status === 'refunded' && order.delivered_before_refund === true);
    const docs = safeArray(order.documents);
    const deliveryDocs = canViewFiles ? docs.filter(doc => doc?.uploaded_by === 'admin' && doc.filename) : [];
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
    const list = document.getElementById('serviceOrderList');
    const message = document.getElementById('serviceOrderMessage');
    const refreshButton = document.getElementById('refreshServiceOrders');
    const focus = params.get('order');
    let loading = false;
    let lastContent = '';
    let hasPending = false;
    let needsFocus = !!focus;
    let timer;
    panel.hidden = false;

    function scheduleRefresh() {
      clearTimeout(timer);
      if (!document.hidden && hasPending) timer = setTimeout(load, 30000);
    }

    async function load() {
      if (loading) return;
      loading = true;
      refreshButton.disabled = true;
      try {
        const serviceId = encodeURIComponent(service.id);
        const response = await ABC.api('/orders?service_id=' + serviceId + '&limit=5');
        if (!response.ok) throw new Error('Orders unavailable');
        const payload = await response.json();
        if (!Array.isArray(payload.orders)) throw new Error('Orders unavailable');
        const orders = payload.orders.filter(order => order?.id && order.service_id === service.id);
        if (/^[0-9a-f-]{36}$/i.test(focus || '') && !orders.some(order => order.id === focus)) {
          try {
            const res = await ABC.api('/orders/' + encodeURIComponent(focus));
            const { order } = res.ok ? await res.json() : {};
            if (order?.id === focus && order.service_id === service.id) orders.unshift(order);
          } catch (_) { /* The current service list is still available. */ }
        }
        const content = JSON.stringify(orders.map(order => [
          order.id, order.status, order.updated_at, order.delivered_before_refund, order.documents,
        ]));
        if (content !== lastContent) {
          list.replaceChildren(...orders.map(order => renderOrder(order, focus)));
          lastContent = content;
        }
        if (needsFocus && orders.some(order => order.id === focus)) {
          needsFocus = false;
          requestAnimationFrame(() => panel.scrollIntoView({ block: 'start' }));
        }
        hasPending = orders.some(order => ACTIVE_STATUSES.has(order.status));
        message.textContent = orders.length ? '' : 'এই সেবায় এখনো কোনো অর্ডার নেই।';
      } catch (_) {
        message.textContent = 'অর্ডারের তথ্য আপডেট হয়নি। আবার দেখুন।';
      } finally {
        loading = false;
        refreshButton.disabled = false;
        scheduleRefresh();
      }
    }

    refreshButton.addEventListener('click', load);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearTimeout(timer);
      else load();
    });
    load();
  }

  window.ServiceOrderPanel = { supports, mount, checkoutReturn };
})();
