/* Keyboard adapter only: retain existing upload/change and engine handlers. */
(function () {
  'use strict';
  function prepare(root) {
    root.querySelectorAll('label.drop, label.btn-img').forEach(function (label) {
      var input = label.querySelector('input[type="file"]');
      if (!input || label.dataset.keyboardUpload) return;
      label.dataset.keyboardUpload = 'true';
      label.tabIndex = 0;
      label.setAttribute('role', 'button');
      label.addEventListener('keydown', function (event) {
        if (event.target !== label || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        if (!event.repeat && !input.disabled) input.click();
      });
    });
  }
  function start() {
    prepare(document);
    new MutationObserver(function () { prepare(document); }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();