"""Real sales through the UI (phone and tablet), then verified in the API."""
import json, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:4700'
API = BASE + '/api/v1'


def api(method, path, body=None, token=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={'content-type': 'application/json', **({'authorization': f'Bearer {token}'} if token else {})})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or b'null')


OWNER_TOKEN = api('POST', '/auth/login', {'username': 'owner', 'password': 'Owner12345'})['token']


def latest_sales(n=3):
    return api('GET', '/sales?pageSize=%d' % n, token=OWNER_TOKEN)['items']


def login(page, app):
    page.goto(f'{BASE}/{"phone" if app == "phone" else "tab"}/', wait_until='networkidle')
    page.fill('input[autocomplete=username]', 'telefon')
    page.fill('input[type=email]', 'telefon@test.local')
    page.fill('input[type=password]', 'Owner12345')
    page.click('button[type=submit]')
    page.wait_for_load_state('networkidle')
    page.wait_for_timeout(600)


def open_pos(page, app):
    if app == 'phone':
        page.locator('nav.tabbar button', has_text='Shitje').first.click()
    else:
        page.locator('.tb-nav__item', has_text='Shitje').first.click()
    page.wait_for_selector('.tiles', timeout=8000)
    page.wait_for_timeout(300)


def add_product(page, name, times=1):
    tile = page.locator('.tile', has_text=name).first
    for _ in range(times):
        tile.click()
        page.wait_for_timeout(120)


def open_cart(page):
    page.locator('.cart-bar__btn').click()
    page.wait_for_selector('.pay-panel', timeout=8000)
    page.wait_for_timeout(300)


def sheet_btn(page, pattern):
    return page.locator('.sheet button.btn--primary', has_text=pattern).first


def run_case(page, app, name, actions, expect_total, expect_change, expect_methods):
    before = {s['id'] for s in latest_sales(5)}
    actions()
    page.wait_for_timeout(400)
    new = [s for s in latest_sales(5) if s['id'] not in before]
    if not new:
        return {'case': name, 'ok': False, 'why': 'no new sale in API'}
    sale = api('GET', f"/sales/{new[0]['id']}", token=OWNER_TOKEN)
    total = sale['totalCents']
    methods = sorted(p['method'] for p in sale['payments'])
    change = sale.get('changeCents', 0)
    ok = total == expect_total and change == expect_change and methods == sorted(expect_methods)
    return {'case': name, 'ok': ok, 'total': total, 'change': change, 'methods': methods, 'payments': [(p['method'], p['amountCents']) for p in sale['payments']]}


def main(app, width, height):
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(viewport={'width': width, 'height': height}, has_touch=True)
        page = ctx.new_page()
        page.set_default_timeout(8000)
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)[:200]))
        login(page, app)
        open_pos(page, app)

        # 1) Two espressos + a sandwich = 9,30 €. Cash 10,00 → change 0,70 €.
        def case1():
            add_product(page, 'Kafe espresso', 2)
            add_product(page, 'Sanduiç', 1)
            open_cart(page)
            page.locator('.pay-quick .chip', has_text='10 €').click()
            page.wait_for_timeout(200)
            sheet_btn(page, 'Përfundo').click()
        results.append(run_case(page, app, 'cash 10 € for 9,30 €', case1, 930, 70, ['cash']))
        page.wait_for_timeout(600)

        # 2) Split: sandwich 4,50 € → cash 2,50 + card 2,00.
        def case2():
            open_pos(page, app)
            add_product(page, 'Sanduiç', 1)
            open_cart(page)
            page.locator('.pay-quick .chip', has_text='Sakto').click()  # full amount in cash first
            page.locator('.pay-add button', has_text='Kartelë').click()
            page.wait_for_timeout(200)
            inputs = page.locator('.pay-panel .pay-line input')
            inputs.nth(0).fill('2,50')
            inputs.nth(1).fill('2,00')
            page.wait_for_timeout(200)
            sheet_btn(page, 'Përfundo').click()
        results.append(run_case(page, app, 'split cash 2,50 + card 2,00 for 4,50 €', case2, 450, 0, ['card', 'cash']))
        page.wait_for_timeout(600)

        # 3) Sale cannot be finished while money is missing (Përfundo must be disabled).
        open_pos(page, app)
        add_product(page, 'Coca-Cola', 1)  # 1,50 €
        open_cart(page)
        page.locator('.pay-line input').first.fill('1,00')
        page.wait_for_timeout(200)
        disabled = sheet_btn(page, 'Përfundo').is_disabled()
        remaining_text = page.locator('.pay-summary').inner_text()
        results.append({'case': 'blocked when short 0,50 €', 'ok': disabled, 'remaining_text': remaining_text.replace('\n', ' ')})
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)

        # 4) Home shows today's sales KPI (phone and tablet).
        page.locator('nav.tabbar button', has_text='Kryefaqja').first.click() if app == 'phone' else page.locator('.tb-nav__item', has_text='Kryefaqja').first.click()
        page.wait_for_timeout(800)
        body = page.inner_text('body')
        results.append({'case': "home shows 'Shitjet sot'", 'ok': "Shitjet sot" in body})

        browser.close()
    return results, errors


if __name__ == '__main__':
    app = sys.argv[1]
    w, h = int(sys.argv[2]), int(sys.argv[3])
    res, errs = main(app, w, h)
    for r in res:
        print(json.dumps(r, ensure_ascii=False))
    print('PAGE ERRORS:', errs)
