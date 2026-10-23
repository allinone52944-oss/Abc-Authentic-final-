/**
 * Regression guard — banner animation wiring.
 *
 * The banners API returns raw DB rows whose animation fields are named
 * animation_type / animation_speed (set from the admin panel's animation
 * dropdown + speed slider, stored by backend/routes/admin.js). The
 * dashboard passes those rows straight into BannerRender.carousel().
 *
 * carousel() originally read b.anim / b.speed — fields that never exist
 * on API rows — so every banner silently fell back to slide @ speed 30
 * and the admin's animation type + speed settings had NO effect on the
 * site (found 2026-10-23 at Pankaj's request to check the banner logic).
 * This scan pins the renderer to the real API field names.
 */

const fs = require('fs');
const path = require('path');

const RENDER_JS = path.join(__dirname, '..', '..', '..', 'frontend', 'banners', 'render.js');

describe('banner carousel reads the API animation fields', () => {
  const src = fs.readFileSync(RENDER_JS, 'utf8');

  test('render.js exists and defines the carousel', () => {
    expect(src).toMatch(/async function carousel\(/);
  });

  test('carousel maps animation_type (admin/API field) to the slide animation', () => {
    expect(src).toMatch(/b\.animation_type/);
  });

  test('carousel maps animation_speed (admin/API field) to the transition speed', () => {
    expect(src).toMatch(/b\.animation_speed/);
  });

  test('speed is still clamped to the admin slider range 5..120 before use', () => {
    expect(src).toMatch(/Math\.min\(120,\s*Math\.max\(5,\s*Number\(to\.speed\)/);
  });
});
