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
    // Custom colors (admin can override design colors)
    const bgColor = c.bg_color ? String(c.bg_color).trim() : '';
    const textColor = c.text_color ? String(c.text_color).trim() : '';

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
    let customCss = '';
    if (bgColor) customCss += '.bn{background:' + esc(bgColor) + ' !important;}';
    if (textColor) customCss += '.bn h2,.bn p{color:' + esc(textColor) + ' !important;}';
    const inner = '<style>' + css + customCss + '</style>' + body;
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

  // Rotating carousel: renders into el, rotates every `ms`.
  // Honors each banner's animation_type (slide/fade/ticker/bounce/none)
  // and animation_speed (5-120 -> transition duration 50-1200ms).
  function animKeyframes(anim) {
    switch (anim) {
      case 'slide':
      case 'ticker':
        return {
          out: [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: 'translateX(-48px)' }],
          inn: [{ opacity: 0, transform: 'translateX(48px)' }, { opacity: 1, transform: 'translateX(0)' }],
          ease: 'ease-out'
        };
      case 'bounce':
        return {
          out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.82)' }],
          inn: [{ opacity: 0, transform: 'scale(.82)' }, { opacity: 1, transform: 'scale(1)' }],
          ease: 'cubic-bezier(.2,1.6,.4,1)'
        };
      case 'fade':
      default:
        return {
          out: [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(10px)' }],
          inn: [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'translateY(0)' }],
          ease: 'ease-out'
        };
    }
  }
  async function carousel(el, banners, ms) {
    if (!el || !banners || !banners.length) return;
    const slides = [];
    for (const b of banners) {
      try {
        slides.push({
          html: await render(b),
          anim: b.animation_type || 'fade',
          speed: Math.min(120, Math.max(5, Number(b.animation_speed) || 30))
        });
      } catch (e) { /* skip */ }
    }
    if (!slides.length) return;
    let i = 0;
    el.innerHTML = '<div class="bn-slide">' + slides[0].html + '</div>';
    if (slides.length < 2) return;
    const canAnimate = typeof Element !== 'undefined' && Element.prototype.animate;
    setInterval(() => {
      i = (i + 1) % slides.length;
      const slide = el.querySelector('.bn-slide');
      if (!slide) return;
      const to = slides[i];
      if (to.anim === 'none' || !canAnimate) { slide.innerHTML = to.html; return; }
      const dur = to.speed * 10; // 50ms .. 1200ms
      const kf = animKeyframes(to.anim);
      try {
        const a = slide.animate(kf.out, { duration: dur, easing: 'ease-in', fill: 'forwards' });
        a.onfinish = () => {
          if (!slide.isConnected) return;
          slide.innerHTML = to.html;
          slide.animate(kf.inn, { duration: dur, easing: kf.ease, fill: 'forwards' });
        };
      } catch (e) { slide.innerHTML = to.html; }
    }, ms || 6000);
  }

  window.BannerRender = { render, renderAll, carousel, getCatalog };
})();
