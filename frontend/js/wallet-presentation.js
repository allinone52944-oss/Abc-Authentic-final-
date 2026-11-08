/* Presentation-only observers: no API calls, financial writes, or legacy function replacement. */
(function () {
  'use strict';
  var dialog = document.createElement('dialog');
  dialog.className = 'wp-result';
  dialog.setAttribute('aria-labelledby', 'wpResultTitle');
  dialog.setAttribute('aria-describedby', 'wpResultBody');
  dialog.innerHTML = '<button type="button" class="wp-close" aria-label="বন্ধ করুন">×</button><div class="wp-result-head"><div class="wp-result-icon" aria-hidden="true"></div><h2 id="wpResultTitle"></h2></div><div class="wp-result-body" id="wpResultBody"></div><div class="wp-result-footer"><button type="button">ঠিক আছে →</button><p>All In One · Abc Authentic</p></div>';
  document.body.appendChild(dialog);
  var focusBefore = null;
  function close() { dialog.close(); }
  dialog.querySelectorAll('button').forEach(function (btn) { btn.addEventListener('click', close); });
  dialog.addEventListener('close', function () { if (focusBefore && focusBefore.isConnected) focusBefore.focus({ preventScroll: true }); });
  dialog.addEventListener('click', function (event) {
    var box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) close();
  });
  function open(outcome, text) {
    var cb = document.getElementById('cbOverlay');
    if (cb && cb.classList.contains('show')) return;
    dialog.dataset.outcome = outcome;
    dialog.querySelector('.wp-result-icon').textContent = outcome === 'success' ? '✓' : outcome === 'failed' ? '×' : '◷';
    dialog.querySelector('h2').textContent = outcome === 'success' ? 'পেমেন্ট সফল হয়েছে!' : outcome === 'failed' ? 'পেমেন্ট সম্পন্ন হয়নি' : 'রিকোয়েস্ট জমা হয়েছে';
    dialog.querySelector('.wp-result-body').textContent = text;
    if (!dialog.open) { focusBefore = document.activeElement; dialog.showModal(); }
  }
  // These nodes are the existing engine's feedback contract. Never infer new credits from history.
  ['gwState', 'ok', 'err', 'gwErr', 'gwErr2', 'cerr'].forEach(function (id) {
    var node = document.getElementById(id);
    if (!node) return;
    var last = node.textContent.trim(); // Existing content on load is not a new event.
    new MutationObserver(function () {
      var text = node.textContent.trim();
      if (text === last) return;
      last = text;
      if (!text) return;
      var outcome = null;
      if (id === 'gwState') {
        if (node.querySelector('.gw-state.success')) outcome = 'success';
        else if (node.querySelector('.gw-state.failed')) outcome = 'failed';
        else if (node.querySelector('.gw-state.pending')) outcome = 'pending';
      } else if (id === 'ok') {
        if (text.indexOf('✅ সফল!') === 0) outcome = 'success';
        else if (text.indexOf('⏳') === 0) outcome = 'pending';
      } else outcome = 'failed';
      if (outcome) open(outcome, text);
    }).observe(node, { childList: true, subtree: true, characterData: true });
  });
  var cashback = document.getElementById('cbOverlay');
  if (cashback) {
    var panel = cashback.querySelector('.wp-cashback-panel');
    var cbFocus = null;
    cashback.setAttribute('role', 'dialog');
    cashback.setAttribute('aria-modal', 'true');
    cashback.setAttribute('aria-labelledby', 'cbTitle');
    if (panel) panel.tabIndex = -1;
    var cbClose = panel && panel.lastElementChild;
    if (cbClose) { cbClose.setAttribute('role', 'button'); cbClose.tabIndex = 0; cbClose.setAttribute('aria-label', 'ক্যাশব্যাক পপআপ বন্ধ করুন'); }
    new MutationObserver(function () {
      if (cashback.classList.contains('show')) {
        if (dialog.open) close();
        cbFocus = document.activeElement;
        if (panel) panel.focus();
      } else if (cbFocus && cbFocus.isConnected) cbFocus.focus({ preventScroll: true });
    }).observe(cashback, { attributes: true, attributeFilter: ['class'] });
    cashback.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') cashback.classList.remove('show');
      if (cbClose && event.target === cbClose && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); cbClose.click(); }
      if (event.key === 'Tab') {
        var controls = Array.from(cashback.querySelectorAll('button,[tabindex="0"]')).filter(function (el) { return el.getClientRects().length > 0; });
        if (!controls.length) { event.preventDefault(); return; }
        var first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
      }
    });
  }
})();
