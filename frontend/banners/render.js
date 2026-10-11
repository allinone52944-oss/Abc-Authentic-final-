// ============================================================
// All In One (Abc Authentic) - Banner renderer (Phase 3)
// Renders a banner design (1..24) with content overrides.
// Usage: BannerRender.render(banner) -> Promise<string> (HTML)
//        BannerRender.renderAll(banners) -> Promise<string>
// banner = { design_id, content: { text_bn, text_en, link } }
// ============================================================
(function () {
  let catalog = null;

  async function getCatalog() {
    if (catalog) return catalog;
    const r = await fetch('/banners/catalog.json');
    catalog = await r.json();
    return catalog;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  async function render(banner) {
    const cat = await getCatalog();
    const id = Math.min(24, Math.max(1, Number(banner.design_id) || 1));
    const d = cat.designs.find((x) => x.id === id) || cat.designs[0];
    const c = banner.content || {};
    const textBn = esc(c.text_bn || d.default_bn);
    const textEn = esc(c.text_en || d.default_en);

    let html;
    try {
      const r = await fetch('/banners/samples/' + d.file);
      html = await r.text();
    } catch (e) {
      return '<div style="padding:16px;text-align:center;color:#d4af37;">' + textBn + '</div>';
    }
    // Extract <style> and body content, drop outer html/head/body tags
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const css = styleMatch ? styleMatch[1] : '';
    let body = bodyMatch ? bodyMatch[1] : html;
    body = body.split('{{text_bn}}').join(textBn).split('{{text_en}}').join(textEn);
    const link = c.link ? String(c.link).trim() : '';
    const inner = '<style>' + css + '</style>' + body;
    if (link) {
      return '<a href="' + esc(link) + '" target="_blank" rel="noopener" style="text-decoration:none;display:block;">' + inner + '</a>';
    }
    return inner;
  }

  async function renderAll(banners) {
    const parts = [];
    for (const b of banners || []) {
      try { parts.push(await render(b)); } catch (e) { /* skip */ }
    }
    return parts.join('\n');
  }

  // Rotating carousel: renders into el, rotates every `ms`
  async function carousel(el, banners, ms) {
    if (!el || !banners || !banners.length) return;
    const htmls = [];
    for (const b of banners) {
      try { htmls.push(await render(b)); } catch (e) { /* skip */ }
    }
    if (!htmls.length) return;
    let i = 0;
    el.innerHTML = '<div class="bn-slide">' + htmls[0] + '</div>';
    if (htmls.length < 2) return;
    setInterval(() => {
      i = (i + 1) % htmls.length;
      const slide = el.querySelector('.bn-slide');
      if (!slide) return;
      slide.style.opacity = '0';
      slide.style.transform = 'translateY(8px)';
      setTimeout(() => {
        slide.innerHTML = htmls[i];
        slide.style.opacity = '1';
        slide.style.transform = 'translateY(0)';
      }, 300);
    }, ms || 6000);
  }

  window.BannerRender = { render, renderAll, carousel, getCatalog };
})();
