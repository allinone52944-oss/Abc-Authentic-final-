const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../frontend/banners/render.js'), 'utf8');
function harness() {
  const animations = [];
  const slide = { innerHTML: '', animate: jest.fn(() => {
    const animation = { cancel: jest.fn(), onfinish: null };
    animations.push(animation); return animation;
  }) };
  const dots = [0, 1, 2].map(idx => ({ dataset: { idx: String(idx) }, style: {}, addEventListener: (event, fn) => { dots[idx].click = fn; } }));
  const el = { innerHTML: '', offsetParent: {}, querySelector: () => slide, querySelectorAll: () => dots, addEventListener: jest.fn(), removeEventListener: jest.fn() };
  const ctx = vm.createContext({ window: {}, console, setInterval: jest.fn(() => 42), clearInterval: jest.fn(),
    fetch: async url => ({ ok: true, json: async () => ({ designs: [{ id: 1, file: 'sample.html', default_bn: 'Default', default_en: '' }] }), text: async () => '<style>.bn{}</style><body><div class="bn">{{text_bn}}</div></body>' }) });
  vm.runInContext(source, ctx);
  return { renderer: ctx.window.BannerRender, el, slide, dots, animations, ctx };
}
const rows = mode => [0, 1, 2].map(i => ({ design_id: 1, content: { text_bn: 'Banner ' + i }, animation_type: mode, animation_speed: 120 }));
test.each(['fade', 'slide', 'ticker', 'bounce'])('%s releases outgoing and incoming animation effects', async mode => {
  const h = harness(); await h.renderer.carousel(h.el, rows(mode), 6000);
  h.dots[1].click(); h.animations[0].onfinish();
  expect(h.animations[0].cancel).toHaveBeenCalledTimes(1);
  expect(h.slide.innerHTML).toContain('Banner 1');
  h.animations[1].onfinish(); expect(h.animations[1].cancel).toHaveBeenCalledTimes(1);
});
test('rapid clicks serialize transitions and retain the latest selection', async () => {
  const h = harness(); await h.renderer.carousel(h.el, rows('fade'), 6000);
  h.dots[1].click(); h.dots[2].click();
  expect(h.slide.animate).toHaveBeenCalledTimes(1);
  h.animations[0].onfinish(); h.animations[1].onfinish();
  h.animations[2].onfinish(); h.animations[3].onfinish();
  expect(h.slide.innerHTML).toContain('Banner 2');
});
test('empty reload clears the existing carousel timer and display', async () => {
  const h = harness(); await h.renderer.carousel(h.el, rows('fade'), 6000);
  await h.renderer.carousel(h.el, [], 6000);
  expect(h.ctx.clearInterval).toHaveBeenCalledWith(42);
  expect(h.el.innerHTML).toBe('');
});