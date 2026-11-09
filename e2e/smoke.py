import json, sys
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:4700'
DEVICES = {
    'phone-360': ('phone', 360, 780),
    'phone-390': ('phone', 390, 844),
    'phone-430': ('phone', 430, 932),
    'tab-768p': ('tab', 768, 1024),
    'tab-1024l': ('tab', 1024, 768),
    'tab-1366l': ('tab', 1366, 1024),
}
PHONE_PAGES = ['Kryefaqja', 'PC-të', 'Shitje', 'Borxhet', 'Arka', 'Shpenzimet', 'Stoku', 'Raportet', 'Cilësimet']
TAB_PAGES = PHONE_PAGES

SUSPECT = ['undefined', 'NaN', '[object', 'null', 'Invalid Date']

SMALL_JS = """() => [...document.querySelectorAll('button, a, [role=button], input, select')]
  .filter(b => { const r = b.getBoundingClientRect(); const cs = getComputedStyle(b); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && (r.height < 44 || r.width < 44); })
  .map(b => ((b.innerText || b.getAttribute('aria-label') || b.placeholder || '').trim().slice(0, 28) + ' ' + Math.round(b.getBoundingClientRect().width) + 'x' + Math.round(b.getBoundingClientRect().height)))"""


def login(page, app):
    page.goto(f'{BASE}/{"phone" if app == "phone" else "tab"}/', wait_until='networkidle')
    page.fill('input[autocomplete=username]', 'telefon')
    page.fill('input[type=email]', 'telefon@test.local')
    page.fill('input[type=password]', 'Owner12345')
    page.click('button[type=submit]')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(800)


def go(page, app, label):
    if app == 'phone':
        if label in ('Kryefaqja', 'PC-të', 'Shitje', 'Borxhet'):
            page.locator('nav.tabbar button', has_text=label).first.click()
        else:
            page.click('.menu-btn')
            page.wait_for_timeout(300)
            page.locator('.menu-item', has_text=label).first.click()
    else:
        page.locator('.tb-nav__item', has_text=label).first.click()
    page.wait_for_timeout(800)


def run(only=None):
    report = {}
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for name, (app, w, h) in DEVICES.items():
            if only and name not in only:
                continue
            ctx = browser.new_context(viewport={'width': w, 'height': h}, has_touch=True, device_scale_factor=1)
            page = ctx.new_page()
            page.set_default_timeout(6000)
            errors = []
            page.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)[:200]))
            page.on('console', lambda m: errors.append('CONSOLE ' + m.text[:200]) if m.type == 'error' else None)
            login(page, app)
            res = {'login_ok': page.locator('.tb-nav').count() > 0 or page.locator('nav.tabbar').count() > 0 or page.locator('.topbar').count() > 0}
            pages = TAB_PAGES if app == 'tab' else PHONE_PAGES
            for label in pages:
                try:
                    go(page, app, label)
                except Exception as e:
                    res[label] = 'NAV FAIL ' + str(e)[:120]
                    continue
                body = page.inner_text('body')
                sus = [s for s in SUSPECT if s in body]
                overflow = page.evaluate('() => document.documentElement.scrollWidth - window.innerWidth')
                small = page.evaluate(SMALL_JS)
                res[label] = {'overflow': overflow, 'suspect': sus, 'small': len(small), 'small_ex': small[:3]}
                page.screenshot(path=f'/tmp/e2e/shots/{name}-{label}.png')
            res['errors'] = errors[:6]
            report[name] = res
            ctx.close()
        browser.close()
    return report


if __name__ == '__main__':
    only = sys.argv[1:] or None
    rep = run(only)
    print(json.dumps(rep, ensure_ascii=False, indent=1))
