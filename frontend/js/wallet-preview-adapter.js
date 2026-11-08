/* Approved preview interactions delegate to the legacy validated payment pipeline. */
(function () {
  'use strict';
  var busy = false;
  var submit = document.querySelector('#gwStep1 .wp-submit');
  var names = { bkash_payment: 'বিকাশ পেমেন্ট', bkash_personal: 'বিকাশ পার্সোনাল', nagad: 'নগদ', rocket: 'রকেট' };
  document.querySelectorAll('#gwMethods [data-m]').forEach(function (node) { node.textContent = names[node.dataset.m] || node.textContent; });
  document.querySelectorAll('#methods [data-m] > div').forEach(function (node) { node.textContent = names[node.parentElement.dataset.m] || node.textContent; });
  function sync() {
    var pending = typeof gw !== 'undefined' && gw && gw.submitted && !gw.done;
    if (submit) { submit.disabled = busy || !!pending; submit.textContent = busy ? 'পাঠানো হচ্ছে…' : pending ? 'রিকোয়েস্ট জমা আছে' : 'রিকোয়েস্ট পাঠান'; }
    var balance = document.getElementById('bal');
    var headerBalance = document.getElementById('wpHeaderBalance');
    if (balance && headerBalance) headerBalance.textContent = balance.textContent;
  }
  if (submit) submit.addEventListener('click', async function (event) {
    event.preventDefault(); event.stopImmediatePropagation();
    if (busy || (typeof gw !== 'undefined' && gw && gw.submitted && !gw.done)) return;
    busy = true; sync();
    try {
      gwStartSession(); // Original sender/amount validation and same-origin resume storage.
      var error = document.getElementById('gwErr');
      if (!error || error.textContent.trim() || !gw) return;
      await gwAutoMatch(); // Original number+amount POST, SMS match, atomic credit and polling.
    } finally { busy = false; sync(); }
  }, true);
  ['gwState', 'bal'].forEach(function (id) {
    var node = document.getElementById(id);
    if (node) new MutationObserver(sync).observe(node, { childList: true, subtree: true, characterData: true });
  });
  document.querySelectorAll('#methods .method').forEach(function (node) {
    node.setAttribute('role', 'button'); node.tabIndex = 0;
    node.addEventListener('keydown', function (event) { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); node.click(); } });
  });
  var balance = document.getElementById('bal');
  if (balance && balance.firstChild) sync();
  // Header identity is read with the same protected endpoint used by legacy init; no auth replacement.
  if (typeof ABC !== 'undefined') ABC.api('/auth/me').then(function (response) {
    if (!response.ok) return null;
    return response.json();
  }).then(function (data) {
    var name = document.getElementById('wpAccountName');
    if (name && data && data.user) name.textContent = data.user.name || 'আপনার অ্যাকাউন্ট';
  }).catch(function () {});
})();
