"""Browser regression: run with python3; defaults to the production login origin.
Only registration-status and presentation assets are intercepted; no signup is sent.
"""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[3]

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        for width, height in [(1280, 1800), (390, 844)]:
            for enabled in [False, True]:
                context = await browser.new_context(viewport={"width": width, "height": height})
                page = await context.new_page()
                await page.route("**/login.html", lambda r: r.fulfill(
                    content_type="text/html", body=(ROOT / "frontend/login.html").read_text()))
                await page.route("**/css/auth-readability.css*", lambda r: r.fulfill(
                    content_type="text/css", body=(ROOT / "frontend/css/auth-readability.css").read_text()))
                await page.route("**/api/auth/registration-status", lambda r: r.fulfill(
                    content_type="application/json", body='{"enabled":' + str(enabled).lower() + '}'))
                await page.goto(os.environ.get("LOGIN_TEST_ORIGIN", "https://abc-authentic.store") + "/login.html", wait_until="networkidle")
                register = page.locator(".tab").nth(1)
                if enabled:
                    assert await register.is_visible(), "Enabled registration must remain accessible"
                    await register.click()
                    assert await page.locator("#tab-reg").is_visible()
                    await page.locator(".tab").nth(0).click()
                else:
                    assert not await register.is_visible(), "Admin-disabled registration must stay hidden"
                    assert not await page.locator("#tab-reg").is_visible()
                assert await page.locator("#tab-login").is_visible()
                output = Path("/tmp/browser/registration-visibility")
                output.mkdir(parents=True, exist_ok=True)
                await page.screenshot(path=str(output / f"{width}-{enabled}.png"))
                print(f"PASS width={width} registration_enabled={enabled}")
                await context.close()
        await browser.close()

asyncio.run(main())