// ============================================================
// All In One (Abc Authentic) - Banner renderer (Phase 3)
// Renders a banner design (1..24) with content overrides.
// Usage: BannerRender.render(banner) -> Promise<string> (HTML)
//        BannerRender.renderAll(banners) -> Promise<string>
//        BannerRender.carousel(el, banners, ms) -> Promise<void>
//        BannerRender.showPopup(banner) -> Promise<void>
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
    let customCss = '.bn{max-width:100% !important;width:100% !important;border:none !important;border-radius:0 !important;box-sizing:border-box !important;}';
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
          out: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.88)' }],
          inn: [{ opacity: 0, transform: 'scale(.88)' }, { opacity: 1, transform: 'scale(1)' }],
          ease: 'cubic-bezier(.2,1.6,.4,1)'
        };
      case 'fade':
      default:
        return {
          out: [{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(8px)' }],
          inn: [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }],
          ease: 'ease-out'
        };
    }
  }

  // Rotating carousel with pause-on-hover and navigation dots
  async function carousel(el, banners, ms) {
    if (!el || !banners || !banners.length) return;
    if (el._bnTimer) { clearInterval(el._bnTimer); el._bnTimer = null; }

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

    let curIdx = 0;
    let isPaused = false;

    let dotsHtml = '';
    if (slides.length > 1) {
      dotsHtml = '<div class="bn-dots" style="position:absolute;bottom:8px;left:0;right:0;display:flex;justify-content:center;gap:6px;z-index:10;pointer-events:auto;">' +
        slides.map((_, idx) =>
          '<button class="bn-dot' + (idx === 0 ? ' active' : '') + '" data-idx="' + idx + '" type="button" aria-label="Slide ' + (idx + 1) + '" ' +
          'style="width:' + (idx === 0 ? '22px' : '8px') + ';height:8px;border-radius:999px;border:none;background:' + (idx === 0 ? '#ffffff' : 'rgba(255,255,255,0.4)') + ';cursor:pointer;padding:0;transition:all 0.25s ease;box-shadow:0 1px 3px rgba(0,0,0,0.3);"></button>'
        ).join('') +
      '</div>';
    }

    el.style.position = 'relative';
    el.innerHTML = '<div class="bn-slide">' + slides[0].html + '</div>' + dotsHtml;

    function updateDots(activeIdx) {
      const dots = el.querySelectorAll('.bn-dot');
      dots.forEach((dot, idx) => {
        const isActive = idx === activeIdx;
        dot.classList.toggle('active', isActive);
        dot.style.width = isActive ? '22px' : '8px';
        dot.style.background = isActive ? '#ffffff' : 'rgba(255,255,255,0.4)';
      });
    }

    function goToSlide(targetIdx) {
      if (targetIdx === curIdx) return;
      curIdx = targetIdx;
      const slide = el.querySelector('.bn-slide');
      if (!slide) return;
      const to = slides[curIdx];
      updateDots(curIdx);
      const canAnimate = typeof Element !== 'undefined' && Element.prototype.animate;
      if (to.anim === 'none' || !canAnimate) {
        slide.innerHTML = to.html;
        return;
      }
      const dur = to.speed * 10;
      const kf = animKeyframes(to.anim);
      try {
        const a = slide.animate(kf.out, { duration: dur, easing: 'ease-in', fill: 'forwards' });
        a.onfinish = () => {
          if (!slide.isConnected) return;
          slide.innerHTML = to.html;
          slide.animate(kf.inn, { duration: dur, easing: kf.ease, fill: 'forwards' });
        };
      } catch (e) {
        slide.innerHTML = to.html;
      }
    }

    if (slides.length > 1) {
      el.addEventListener('click', (e) => {
        const btn = e.target.closest('.bn-dot');
        if (btn) {
          const idx = Number(btn.dataset.idx);
          if (!isNaN(idx)) goToSlide(idx);
        }
      });

      el.addEventListener('mouseenter', () => { isPaused = true; });
      el.addEventListener('mouseleave', () => { isPaused = false; });

      el._bnTimer = setInterval(() => {
        if (isPaused) return;
        const nextIdx = (curIdx + 1) % slides.length;
        goToSlide(nextIdx);
      }, ms || 6000);
    }
  }

  // Display special promotional popup once per session
  async function showPopup(banner) {
    if (!banner || !banner.id) return;
    const storageKey = 'abc_seen_popup_' + banner.id;
    try {
      if (sessionStorage.getItem(storageKey)) return;
    } catch (_) {}

    const htmlContent = await render(banner);
    const overlay = document.createElement('div');
    overlay.className = 'bn-popup-backdrop';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.65);backdrop-filter:blur(4px);z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity 0.3s ease;';

    const box = document.createElement('div');
    box.className = 'bn-popup-box';
    box.style.cssText = 'background:#ffffff;border-radius:18px;max-width:540px;width:100%;box-shadow:0 25px 50px -12px rgba(0,0,0,0.35);overflow:hidden;position:relative;transform:scale(0.95);transition:transform 0.3s cubic-bezier(0.16,1,0.3,1);';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.type = 'button';
    closeBtn.style.cssText = 'position:absolute;top:12px;right:12px;z-index:20;background:rgba(0,0,0,0.55);color:#fff;border:none;width:32px;height:32px;border-radius:999px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,0.3);';

    const dismissBar = document.createElement('div');
    dismissBar.style.cssText = 'padding:10px 16px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#64748b;';
    dismissBar.innerHTML = '<span>📢 বিশেষ ঘোষণা</span>' +
      '<button type="button" style="background:none;border:none;color:#2563eb;cursor:pointer;font-weight:600;font-size:12px;padding:4px 8px;">আজ আর দেখাবেন না</button>';

    const closePopup = (markDismissed) => {
      try {
        if (markDismissed) localStorage.setItem(storageKey, String(Date.now()));
        sessionStorage.setItem(storageKey, '1');
      } catch (_) {}
      overlay.style.opacity = '0';
      box.style.transform = 'scale(0.95)';
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 300);
    };

    closeBtn.onclick = () => closePopup(false);
    dismissBar.querySelector('button').onclick = () => closePopup(true);
    overlay.onclick = (e) => { if (e.target === overlay) closePopup(false); };

    box.innerHTML = htmlContent;
    box.appendChild(closeBtn);
    box.appendChild(dismissBar);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      box.style.transform = 'scale(1)';
    });
  }

  window.BannerRender = { render, renderAll, carousel, showPopup, getCatalog };
})();
