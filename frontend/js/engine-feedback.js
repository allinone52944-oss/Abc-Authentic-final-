/* Presentation adapter: observe existing results, never change engine handlers or payment state. */
(function () {
  'use strict';
  function start() {
    var selector = '.err, .ok, .livenote, .failbox, #sysBanner';
    var seen = new WeakMap();
    var queued = false;
    var qrButton = document.querySelector('.page-qr-photo-verify #goBtn');
    var pending;
    if (qrButton) {
      pending = document.createElement('div');
      pending.className = 'engine-pending';
      pending.hidden = true;
      pending.setAttribute('role', 'status');
      pending.setAttribute('aria-live', 'polite');
      pending.textContent = 'যাচাই চলছে… ফল পাওয়া পর্যন্ত অপেক্ষা করুন।';
      var form = document.getElementById('vform');
      if (form) form.before(pending);
      var success = document.getElementById('okBox');
      if (success) {
        var next = document.createElement('a');
        next.href = '/qr-photo-verify.html';
        next.className = 'engine-new-check';
        next.textContent = 'নতুন যাচাই';
        // Separate sibling: original showOk() replaces its own contents.
        success.after(next);
      }
    }
    function scan() {
      queued = false;
      document.querySelectorAll(selector).forEach(function (box) {
        var text = box.textContent.trim();
        var visible = text && box.getClientRects().length && getComputedStyle(box).display !== 'none' && getComputedStyle(box).visibility !== 'hidden';
        if (!visible) { seen.delete(box); return; }
        var signature = box.className + '|' + text;
        if (seen.get(box) === signature) return;
        seen.set(box, signature);
        var success = box.classList.contains('ok');
        var failure = box.classList.contains('err') || box.classList.contains('failbox');
        box.dataset.engineFeedback = success ? 'success' : failure ? 'error' : 'notice';
        box.dataset.feedbackTitle = success ? 'সফল হয়েছে' : failure ? 'সমস্যা হয়েছে' : 'সেবার আপডেট';
        box.setAttribute('role', failure ? 'alert' : 'status');
        box.setAttribute('aria-live', failure ? 'assertive' : 'polite');
        box.setAttribute('aria-atomic', 'true');
        box.tabIndex = -1;
        box.focus({ preventScroll: true });
        var rect = box.getBoundingClientRect();
        if (rect.top < 24 || rect.bottom > window.innerHeight - 88) {
          box.scrollIntoView({ block: 'center', behavior: 'auto' });
        }
      });
      if (pending) {
        var busy = qrButton.disabled && Boolean(qrButton.querySelector('.spin'));
        if (pending.hidden === busy) pending.hidden = !busy;
      }
    }
    new MutationObserver(function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(scan);
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'disabled', 'hidden'] });
    scan();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();