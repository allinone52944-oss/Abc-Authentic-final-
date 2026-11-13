/* Presentation adapter: original authentication, pagination and downloads remain authoritative. */
(function (root) {
  'use strict';
  function normalize(value) {
    return String(value == null ? '' : value).toLowerCase().replace(/[০-৯]/g, function (n) { return '০১২৩৪৫৬৭৮৯'.indexOf(n); }).trim();
  }
  function matches(text, term) { return normalize(text).includes(normalize(term)); }
  var helpers = { normalize: normalize, matches: matches };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (!root.document) return;
  var doc = root.document;
  function start() {
    if (!doc.body.matches('.page-orders,.page-history')) return;
    var list = doc.getElementById('list');
    var search;
    var empty;
    if (list) {
      var filters = doc.getElementById('filters');
      var field = doc.createElement('div');
      field.className = 'oh-search';
      field.innerHTML = '<label for="ohSearch">অর্ডার খুঁজুন</label><div class="oh-search-line"><input id="ohSearch" type="search" placeholder="লোড হওয়া অর্ডারের সেবা বা নম্বর" autocomplete="off"><button type="button" class="btn-secondary oh-clear" aria-label="খোঁজা মুছুন" title="খোঁজা মুছুন">×</button></div>';
      filters.before(field);
      search = field.querySelector('input');
      empty = doc.createElement('p');
      empty.className = 'oh-empty';
      empty.setAttribute('role', 'status');
      empty.hidden = true;
      empty.textContent = 'লোড হওয়া অর্ডারে মিল নেই। আরও অর্ডার থাকলে নিচ থেকে আনুন।';
      list.closest('.table-container').after(empty);
      search.addEventListener('input', applySearch);
      field.querySelector('button').addEventListener('click', function () { search.value = ''; applySearch(); search.focus(); });
      var details = doc.createElement('details');
      details.className = 'oh-status-more';
      var summary = doc.createElement('summary');
      summary.textContent = 'আরও অবস্থা';
      details.appendChild(summary);
      var extras = doc.createElement('div');
      extras.className = 'oh-extra-statuses';
      details.appendChild(extras);
      filters.querySelectorAll('.fbtn').forEach(function (button) {
        if (['', 'pending', 'processing', 'completed', 'delivered'].indexOf(button.dataset.st) < 0) extras.appendChild(button);
      });
      filters.appendChild(details);
      filters.addEventListener('click', function () { requestAnimationFrame(syncStatus); });
      function syncStatus() {
        if (extras.querySelector('.on')) details.open = true;
      }
      new MutationObserver(syncStatus).observe(filters, { attributes: true, subtree: true, attributeFilter: ['class'] });
      syncStatus();
    }
    function applySearch() {
      if (!list || !search) return;
      var count = 0;
      var rows = Array.from(list.querySelectorAll('tr')).filter(function (row) { return !row.querySelector('[colspan]'); });
      rows.forEach(function (row) {
        var visible = matches(row.textContent, search.value);
        row.hidden = !visible;
        if (visible) count++;
      });
      empty.hidden = !(search.value.trim() && rows.length && count === 0);
    }
    function polish(node) {
      var walker = doc.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      var text;
      while ((text = walker.nextNode())) {
        if (/\b(?:AM|PM)\b/.test(text.nodeValue)) text.nodeValue = text.nodeValue.replace(/\bAM\b/g, 'পূর্বাহ্ণ').replace(/\bPM\b/g, 'অপরাহ্ণ');
      }
      node.querySelectorAll('.hist-doc.delivery').forEach(function (button) {
        if (button.dataset.ohPolished) return;
        button.dataset.ohPolished = 'true';
        var name = button.textContent.replace(/^[🎁\s]+|[⬇️\s]+$/gu, '').trim();
        button.title = name;
        button.setAttribute('aria-label', name + ' ডাউনলোড');
        var ext = name.match(/\.([a-z0-9]{1,5})$/i);
        button.textContent = '↓ ' + name;
        if (ext) {
          var type = doc.createElement('span');
          type.className = 'oh-file-type';
          type.textContent = ext[1].toUpperCase();
          button.appendChild(type);
        }
      });
      applySearch();
    }
    var target = list || doc.getElementById('histList');
    if (target) {
      var observer = new MutationObserver(function () {
        observer.disconnect();
        polish(target);
        observer.observe(target, { childList: true, subtree: true });
      });
      polish(target);
      observer.observe(target, { childList: true, subtree: true });
    }
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);