(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const form = byId('lookupForm');
  const input = byId('tin');
  const authorized = byId('authorized');
  const submit = byId('lookup');
  const download = byId('download');
  const result = byId('result');
  const currency = new Intl.NumberFormat('bn-BD', { maximumFractionDigits: 2 });
  const money = amount => '৳' + currency.format(amount);
  const errors = {
    PRICE_CHANGED: 'চার্জ বদলেছে। নতুন চার্জ দেখে আবার যাচাই করুন।',
    SERVICE_UNAVAILABLE: 'সেবাটি এখন ব্যবহার করা যাচ্ছে না।',
    INSUFFICIENT_BALANCE: 'পর্যাপ্ত ব্যালেন্স নেই। রিচার্জ করে আবার চেষ্টা করুন।',
    RECORD_NOT_FOUND: 'এই নম্বরে কোনো TIN তথ্য পাওয়া যায়নি। কোনো চার্জ কাটেনি।',
    PROVIDER_UNAVAILABLE: 'তথ্যের উৎস থেকে এখন উত্তর পাওয়া যাচ্ছে না। কিছুক্ষণ পর চেষ্টা করুন।',
    LOOKUP_BUSY: 'আগের অনুরোধ চলছে। একটু অপেক্ষা করে একই নম্বর দিয়ে চেষ্টা করুন।',
    NETWORK_ERROR: 'সংযোগে সমস্যা হয়েছে। একই নম্বর রেখে আবার যাচাই করুন।',
    RATE_LIMITED: 'অল্প সময়ে অনেকবার চেষ্টা হয়েছে। একটু অপেক্ষা করুন।',
  };
  let price = null;
  let loading = true;
  let submitting = false;
  let attempt = null;
  let downloadPath = '';

  function message(id, text) {
    const element = byId(id);
    element.textContent = text;
    element.hidden = !text;
  }

  function sync() {
    const busy = loading || submitting;
    const quote = attempt?.price ?? price;
    form.setAttribute('aria-busy', String(busy));
    byId('inputs').disabled = submit.disabled = busy || quote === null;
    byId('reload').disabled = busy;
    byId('price').textContent = quote === null ? (loading ? 'লোড হচ্ছে…' : '—') : money(quote);
    submit.textContent = submitting ? 'যাচাই হচ্ছে…' : attempt ? 'আবার যাচাই করুন' : 'যাচাই করুন';
  }

  async function load() {
    loading = true;
    byId('recovery').hidden = true;
    sync();
    try {
      const response = await ABC.api('/auto-tin/options');
      if (response.status === 401) {
        location.replace('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
        return;
      }
      if (!response.ok) throw new Error();
      const options = await response.json();
      price = Number.isFinite(options.price) && options.price > 0 ? options.price : null;
      if (price === null) message('availability', errors.SERVICE_UNAVAILABLE);
    } catch {
      price = null;
      message('availability', 'সেবা চার্জ আনা যায়নি।');
    } finally {
      loading = false;
      byId('recovery').hidden = price !== null;
      sync();
    }
  }

  input.addEventListener('input', () => {
    input.setCustomValidity('');
    attempt = null;
    message('error', '');
    sync();
  });
  byId('reload').addEventListener('click', load);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submit.disabled || !authorized.checked) return;
    const tin = input.value.trim().replace(/[০-৯]/g, digit => String(digit.charCodeAt(0) - 0x09e6));
    if (!/^(?:\d{10}|\d{12})$/.test(tin)) {
      input.setCustomValidity('১০ সংখ্যার NID বা ১২ সংখ্যার TIN দিন।');
      input.reportValidity();
      return;
    }
    attempt ||= { price, idempotencyKey: crypto.randomUUID() };
    const body = { tin, authorized: true, ...attempt };
    submitting = true;
    downloadPath = '';
    result.hidden = true;
    byId('verifiedTin').textContent = '';
    byId('verifiedTinRow').hidden = true;
    message('error', '');
    message('downloadError', '');
    sync();
    try {
      const response = await ABC.api('/auto-tin/lookup', {
        method: 'POST', timeout: 40000, retryNetwork: false, body,
      });
      const reply = await response.json().catch(() => null);
      if (!response.ok) {
        if (reply?.error === 'CHARGED_NO_REPORT') {
          const charge = reply.chargedAmount > 0
            ? money(reply.chargedAmount) + ' চার্জ কাটা হয়েছে।' : 'চার্জ ফেরত দেওয়া হয়েছে।';
          form.reset();
          attempt = null;
          message('error', 'রিপোর্ট তৈরি করা যায়নি। ' + charge + ' হিস্ট্রিতে বিস্তারিত দেখুন।');
          await load();
          return;
        }
        message('error', Object.hasOwn(errors, reply?.error) ? errors[reply.error] : ABC.httpErrBn(response.status, 'যাচাই'));
        if (['PRICE_CHANGED', 'SERVICE_UNAVAILABLE'].includes(reply?.error)) {
          attempt = null;
          await load();
        }
        return;
      }
      const link = typeof reply?.downloadUrl === 'string'
        && /^\/api(\/orders\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\/documents\/tin-[a-z0-9-]+\.pdf)$/i.exec(reply.downloadUrl);
      if (!link || link[2] !== reply.orderId) {
        message('error', 'রিপোর্টের ডাউনলোড লিংক পাওয়া যায়নি। একই নম্বর রেখে আবার চেষ্টা করুন।');
        return;
      }
      downloadPath = link[1];
      if (typeof reply.tin === 'string' && /^\d{12}$/.test(reply.tin)) {
        byId('verifiedTin').textContent = reply.tin;
        byId('verifiedTinRow').hidden = false;
      }
      form.reset();
      attempt = null;
      result.hidden = false;
      result.focus();
    } catch {
      message('error', errors.NETWORK_ERROR);
    } finally {
      submitting = false;
      sync();
    }
  });

  download.addEventListener('click', async () => {
    if (!downloadPath || download.disabled) return;
    const path = downloadPath;
    download.disabled = true;
    message('downloadError', '');
    try {
      const response = await ABC.api(path, { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const file = await response.blob();
      if (file.type !== 'application/pdf' || await file.slice(0, 5).text() !== '%PDF-') throw new Error();
      if (path !== downloadPath) return;
      const href = URL.createObjectURL(file);
      const link = Object.assign(document.createElement('a'), { href, download: path.split('/').pop() });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(href), 4000);
    } catch {
      if (path === downloadPath) message('downloadError', 'PDF ডাউনলোড হয়নি। আবার চেষ্টা করুন।');
    } finally {
      download.disabled = false;
    }
  });

  load();
})();
