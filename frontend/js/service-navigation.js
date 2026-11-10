/* Keyboard access only; retain original click handlers and execution forms. */
(function () {
  'use strict';
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
  function mount() { enhance(); new MutationObserver(enhance).observe(document.body, { childList: true, subtree: true }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();