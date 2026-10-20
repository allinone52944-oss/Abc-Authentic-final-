// ============================================================
// All In One (Abc Authentic) - Banner renderer (Phase 3)
// Renders a banner design with content overrides.
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

  function isSafeUrl(url) {
    if (!url) return false;
    const u = String(url).trim();
    return /^https?:\/\//i.test(u) || /^\/(?!\/)/.test(u);
  }

  async function render(banner) {
    const cat = await getCatalog();
    const id = Math.max(1, Number(banner.design_id) || 1);
    const d = cat.designs.find((x) => x.id === id) || cat.designs[0];
    const c = banner.content || {};
    const textBn = esc(c.text_bn || d.default_bn);
    const textEn = esc(c.text_en || d.default_en);

    const useCustomColors = !!c.use_custom_colors;
    const rawBg = (useCustomColors && c.bg_color) ? String(c.bg_color).trim() : '';
    const rawText = (useCustomColors && c.text_color) ? String(c.text_color).trim() : '';
    const safeBg = /^[#a-zA-Z0-9, .%()-]+$/.test(rawBg) ? rawBg : '';
    const safeText = /^[#a-zA-Z0-9, .%()-]+$/.test(rawText) ? rawText : '';

    let html;
    try {
      const fileName = String(d.file || '').replace(/^samples\//, '');
      const r = await fetch('/banners/samples/' + fileName);
      if (!r.ok) throw new Error('Fetch status ' + r.status);
      html = await r.text();
    } catch (e) {
      return '<div style="padding:16px;text-align:center;color:#d4af37;background:#0f172a;border-radius:12px;">' + textBn + '</div>';
    }

    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/i);
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const css = styleMatch ? styleMatch[1] : '';
    let body = bodyMatch ? bodyMatch[1] : html;
    body = body.split('{{text_bn}}').join(textBn).split('{{text_en}}').join(textEn);

    const uid = 'bn-u' + Math.random().toString(36).slice(2, 8);
    body = body.replace(/class="bn"/g, 'class="bn ' + uid + '"');

    let customCss = '.' + uid + '{max-width:100% !important;width:100% !important;border:none !important;border-radius:0 !important;box-sizing:border-box !important;}';
    if (safeBg) customCss += ' .' + uid + '{background:' + safeBg + ' !important;}';
    if (safeText) customCss += ' .' + uid + ' h2,.' + uid + ' p{color:' + safeText + ' !important;}';

    const inner = '<style>' + css + customCss + '</style>' + body;
    const link = c.link ? String(c.link).trim() : '';
    if (link && isSafeUrl(link)) {
      return '<a href="' + esc(link) + '" target="_blank" rel="noopener" style="text-decoration:none;display:block;">' + inner + '</a>';
    }
    return inner;
  }

  async function renderAll(banners) {
    if (!banners || !banners.length) return '';
    const htmls = await Promise.all(banners.map(render));
    return htmls.join('');
  }

  function animKeyframes(anim) {
    switch (anim) {
      case 'slide':
        return {
          in: [{ transform: 'translateX(100%)', opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }],
          out: [{ transform: 'translateX(0)', opacity: 1 }, { transform: 'translateX(-100%)', opacity: 0 }],
        };
      case 'fade':
        return {
          in: [{ opacity: 0 }, { opacity: 1 }],
          out: [{ opacity: 1 }, { opacity: 0 }],
        };
      case 'ticker':
        return {
          in: [{ transform: 'translateY(100%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
          out: [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-100%)', opacity: 0 }],
        };
      case 'bounce':
        return {
          in: [
            { transform: 'scale(0.8)', opacity: 0 },
            { transform: 'scale(1.05)', opacity: 1, offset: 0.7 },
            { transform: 'scale(1)', opacity: 1 },
          ],
          out: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.8)', opacity: 0 }],
        };
      case 'none':
      default:
        return {
          in: [{ opacity: 1 }, { opacity: 1 }],
          out: [{ opacity: 1 }, { opacity: 1 }],
        };
    }
  }

  async function carousel(el, banners, ms) {
    if (!el || !banners || !banners.length) return;
    if (el._bnTimer) { clearInterval(el._bnTimer); el._bnTimer = null; }

    const rendered = await Promise.all(
      banners.map(async (b) => ({
        html: await render(b),
        anim: b.anim || 'slide',
        speed: b.speed || 30,
      }))
    );

    el.innerHTML =
      '<div class="bn-carousel-track" style="position:relative;overflow:hidden;width:100%;">' +
        '<div class="bn-carousel-slide" style="width:100%;transition:none;"></div>' +
      '</div>' +
      (rendered.length > 1
        ? '<div class="bn-dots" style="display:flex;justify-content:center;gap:6px;padding:8px 0;">' +
            rendered.map((_, i) =>
              '<span class="bn-dot" data-idx="' + i + '" style="display:inline-block;width:8px;height:8px;border-radius:999px;background:rgba(255,255,255,0.3);cursor:pointer;transition:background .2s;"></span>'
            ).join('') +
          '</div>'
        : '');

    const slide = el.querySelector('.bn-carousel-slide');
    const dots = el.querySelectorAll('.bn-dot');
    let curIdx = 0;
    let isPaused = false;

    function updateDots(idx) {
      dots.forEach((d, i) => {
        d.style.background = i === idx ? '#d4af37' : 'rgba(255,255,255,0.3)';
        d.style.width = i === idx ? '24px' : '8px';
      });
    }

    function setSlideHtml(idx) {
      if (!rendered[idx]) return;
      slide.innerHTML = rendered[idx].html;
      updateDots(idx);
    }

    setSlideHtml(0);

    if (rendered.length > 1) {
      dots.forEach((d) => {
        d.addEventListener('click', () => {
          const idx = Number(d.dataset.idx);
          if (!isNaN(idx) && idx !== curIdx) goToSlide(idx);
        });
      });

      function goToSlide(nextIdx) {
        if (nextIdx === curIdx) return;
        const to = rendered[nextIdx];
        if (!to) return;
        if (to.anim === 'none' || !slide.animate) {
          curIdx = nextIdx;
          setSlideHtml(curIdx);
          return;
        }
        const speedVal = Math.min(120, Math.max(5, Number(to.speed) || 30));
        const dur = Math.round(750 - ((speedVal - 5) / 115) * 570);
        const kf = animKeyframes(to.anim);
        try {
          const a = slide.animate(kf.out, { duration: dur, easing: 'ease-in', fill: 'forwards' });
          a.onfinish = () => {
            curIdx = nextIdx;
            slide.innerHTML = to.html;
            updateDots(curIdx);
            try {
              slide.animate(kf.in, { duration: dur, easing: 'ease-out' });
            } catch (_) {}
          };
        } catch (_) {
          curIdx = nextIdx;
          setSlideHtml(curIdx);
        }
      }

      el.addEventListener('mouseenter', () => { isPaused = true; });
      el.addEventListener('mouseleave', () => { isPaused = false; });

      el._bnTimer = setInterval(() => {
        if (isPaused || el.offsetParent === null) return;
        const nextIdx = (curIdx + 1) % rendered.length;
        goToSlide(nextIdx);
      }, ms || 6000);
    }
  }

  async function showPopup(banner) {
    if (!banner || !banner.id) return;
    const sessionKey = 'abc_seen_popup_' + banner.id;
    const dayKey = 'abc_dismissed_popup_' + banner.id;
    try {
      if (sessionStorage.getItem(sessionKey)) return;
      const dismissedAt = Number(localStorage.getItem(dayKey));
      if (dismissedAt && (Date.now() - dismissedAt < 24 * 60 * 60 * 1000)) {
        return;
      }
    } catch (_) {}

    const htmlContent = await render(banner);
    const overlay = document.createElement('div');
    overlay.className = 'bn-popup-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .25s ease;';

    const box = document.createElement('div');
    box.className = 'bn-popup-box';
    box.style.cssText = 'position:relative;max-width:540px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.6);transform:scale(0.95);transition:transform .25s ease;';

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '✕';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close popup');
    closeBtn.style.cssText = 'position:absolute;top:12px;right:12px;z-index:20;background:rgba(0,0,0,0.55);color:#fff;border:none;width:32px;height:32px;border-radius:999px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center;line-height:1;box-shadow:0 2px 6px rgba(0,0,0,0.3);';

    const dismissBar = document.createElement('div');
    dismissBar.style.cssText = 'background:#0b1120;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;border-top:1px solid rgba(255,255,255,0.08);color:rgba(255,255,255,0.7);font-size:12px;';
    dismissBar.innerHTML = '<span>📢 বিশেষ অফার / ঘোষণা</span><label style="cursor:pointer;display:inline-flex;align-items:center;gap:6px;"><input type="checkbox" id="bn_dismiss_today"> আজ আর দেখাবেন না</label>';

    const closePopup = (markDismissed) => {
      try {
        if (markDismissed) localStorage.setItem(dayKey, String(Date.now()));
        sessionStorage.setItem(sessionKey, '1');
      } catch (_) {}
      overlay.style.opacity = '0';
      box.style.transform = 'scale(0.95)';
      setTimeout(() => overlay.remove(), 250);
    };

    closeBtn.onclick = () => {
      const chk = document.getElementById('bn_dismiss_today');
      closePopup(chk && chk.checked);
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) {
        const chk = document.getElementById('bn_dismiss_today');
        closePopup(chk && chk.checked);
      }
    };

    const contentHolder = document.createElement('div');
    contentHolder.innerHTML = htmlContent;

    box.appendChild(closeBtn);
    box.appendChild(contentHolder);
    box.appendChild(dismissBar);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      box.style.transform = 'scale(1)';
    });
  }

  window.BannerRender = {
    render,
    renderAll,
    carousel,
    showPopup,
    getCatalog,
  };
})();
