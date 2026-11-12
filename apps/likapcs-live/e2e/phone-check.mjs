// Checks the real app on an Android device or emulator: installs the APK, signs in through the
// app's own screen, makes real sales on a test server and reads what Android itself reports —
// the notifications, the background service — with the app open, in the background, with the
// screen off, in deep sleep (Doze), after its process is killed and after the phone restarts.
//
//   node phone-check.mjs <debug.apk>
//
// Needs: `adb` with one device attached (an emulator: the server on this machine is 10.0.2.2
// for it), a seeded test server (see engine-check.mjs) and Node 22+. The APK must be the debug
// build: only that one lets a test look into its screen.
//
// Environment: LIKAPCS_URL (the server as this machine sees it), PHONE_SERVER (the address typed
// into the app, default 10.0.2.2:4700), OUT (folder for the screenshots), STEPS (comma list to
// run only some of: reboot, kill, doze).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commands, call, as, sleep } from './shop.mjs';

const APK = process.argv[2];
if (!APK || !fs.existsSync(APK)) {
  console.error('usage: node phone-check.mjs <debug.apk>');
  process.exit(2);
}
const PKG = 'com.likapcs.live';
const PHONE_SERVER = process.env.PHONE_SERVER ?? '10.0.2.2:4700';
const OUT = process.env.OUT ?? 'phone-check-out';
const STEPS = new Set((process.env.STEPS ?? 'doze,kill,reboot').split(',').filter(Boolean));
const DEVTOOLS_PORT = 9222;
fs.mkdirSync(OUT, { recursive: true });

// Everything printed also goes to a file: the emulator runner cannot pipe a script's output.
const LOG_FILE = path.join(OUT, 'phone-check.log');
fs.writeFileSync(LOG_FILE, '');
const print = console.log.bind(console);
console.log = (...args) => {
  print(...args);
  fs.appendFileSync(LOG_FILE, `${args.join(' ')}\n`);
};

let failures = 0;
const started = Date.now();
const stamp = () => `${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s`;
const log = (line) => console.log(`${stamp()}  ${line}`);
const ok = (name) => log(`  ok   ${name}`);
const fail = (name, detail) => {
  failures++;
  log(
    `  FAIL ${name}${detail ? `\n         ${String(detail).split('\n').join('\n         ')}` : ''}`,
  );
};
const check = (name, passed, detail) => {
  if (passed) ok(name);
  else fail(name, typeof detail === 'function' ? detail() : detail);
};
const section = (title) => console.log(`\n${title}`);

// ─── adb ─────────────────────────────────────────────────────────────────────────────────────

function adb(args, { timeout = 60_000, binary = false, allowFail = false } = {}) {
  try {
    const out = execFileSync('adb', args, {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return binary ? out : out.toString('utf8');
  } catch (e) {
    if (allowFail) return binary ? Buffer.alloc(0) : `${e.stdout ?? ''}${e.stderr ?? ''}`;
    throw new Error(`adb ${args.join(' ')} failed: ${e.stderr ?? e.message}`);
  }
}
const shell = (command, options) => adb(['shell', command], options);

let shots = 0;
function screenshot(name) {
  const file = path.join(OUT, `${String(++shots).padStart(2, '0')}-${name}.png`);
  try {
    fs.writeFileSync(file, adb(['exec-out', 'screencap', '-p'], { binary: true }));
    log(`  shot ${path.basename(file)}`);
  } catch (e) {
    log(`  (no screenshot ${name}: ${e.message})`);
  }
}

async function waitFor(what, probe, timeoutMs = 15_000, everyMs = 400) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      last = await probe();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(everyMs);
  }
  throw new Error(
    `timed out waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`,
  );
}

/** Runs a step; a thrown error is one failed check and the run goes on. */
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(name, e.message);
  }
}

// ─── What Android reports ────────────────────────────────────────────────────────────────────

/** The app's notifications as the system holds them: [{ channel, title, text, big, key }]. */
function notifications() {
  const dump = shell('dumpsys notification --noredact', { timeout: 30_000 });
  const records = [];
  const blocks = dump.split(/\n(?=\s+NotificationRecord\()/);
  for (const block of blocks) {
    const head =
      /NotificationRecord\(\S+ pkg=(\S+) .*? key=(\S+?): Notification\(channel=(\S+)/.exec(block);
    if (!head || head[1] !== PKG) continue;
    const field = (name) =>
      new RegExp(`android\\.${name}=\\w+ \\((.*)\\)\\s*$`, 'm').exec(block)?.[1] ?? '';
    records.push({
      key: head[2],
      channel: head[3],
      title: field('title'),
      text: field('text'),
      big: field('bigText'),
      sub: field('subText'),
    });
  }
  return records;
}
const show = (list) =>
  list.map((n) => `[${n.channel}] ${n.title} | ${n.text}`).join('\n') || '(none)';

async function expectNotification(name, test, timeoutMs = 12_000) {
  try {
    const hit = await waitFor(name, () => notifications().find(test), timeoutMs, 500);
    ok(`${name}  →  [${hit.channel}] ${hit.title} | ${hit.big || hit.text}`);
    return hit;
  } catch {
    fail(name, `notifications now:\n${show(notifications())}`);
    return null;
  }
}
const sales = () =>
  notifications().filter((n) => n.channel === 'sales' && / shiti | sold /.test(n.title));

/** Makes one sale on the server and waits for its notification: there must be one more than before. */
async function saleArrives(name, timeoutMs = 12_000) {
  const before = new Set(sales().map((n) => n.key));
  const at = Date.now();
  await commands.sale();
  try {
    const hit = await waitFor(name, () => sales().find((n) => !before.has(n.key)), timeoutMs, 300);
    ok(
      `${name}  →  ${hit.title} | ${hit.big || hit.text}  (${((Date.now() - at) / 1000).toFixed(1)} s)`,
    );
    return true;
  } catch {
    fail(name, `sale notifications now:\n${show(sales())}`);
    return false;
  }
}

const servicesDump = () => shell(`dumpsys activity services ${PKG}`, { timeout: 30_000 });
const serviceRunning = () =>
  /ServiceRecord\{[^}]*com\.likapcs\.live\/\.LiveService/.test(servicesDump());
const serviceForeground = () => /isForeground=true/.test(servicesDump());
const pid = () => shell(`pidof ${PKG}`, { allowFail: true }).trim().split(/\s+/)[0] || null;

/** The screen as Android's accessibility tree: [{ id, text, cls, bounds: [x1, y1, x2, y2] }]. */
function uiNodes() {
  shell('uiautomator dump /sdcard/likalive-ui.xml', { allowFail: true, timeout: 30_000 });
  const xml = shell('cat /sdcard/likalive-ui.xml', { allowFail: true });
  const nodes = [];
  for (const m of xml.matchAll(/<node [^>]*>/g)) {
    const attr = (name) => new RegExp(` ${name}="([^"]*)"`).exec(m[0])?.[1] ?? '';
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(attr('bounds'));
    if (b)
      nodes.push({
        id: attr('resource-id'),
        text: attr('text'),
        cls: attr('class'),
        pkg: attr('package'),
        bounds: b.slice(1).map(Number),
      });
  }
  return nodes;
}
function tap(node) {
  const [x1, y1, x2, y2] = node.bounds;
  shell(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
}

// ─── The app's screen (a WebView), through its debugging socket ──────────────────────────────

class Page {
  static async attach() {
    const page = new Page();
    await waitFor(
      'the app’s screen',
      async () => {
        const id = pid();
        if (!id) return false;
        adb(['forward', `tcp:${DEVTOOLS_PORT}`, `localabstract:webview_devtools_remote_${id}`]);
        const targets = await (await fetch(`http://127.0.0.1:${DEVTOOLS_PORT}/json`)).json();
        const target = targets.find((t) => t.type === 'page' && t.url.includes('/www/index.html'));
        if (!target) return false;
        await page.open(target.webSocketDebuggerUrl);
        return true;
      },
      40_000,
      1000,
    );
    return page;
  }

  open(url) {
    this.next = 0;
    this.waiting = new Map();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.addEventListener('error', () => reject(new Error('the debugging socket did not open')));
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        const done = this.waiting.get(message.id);
        if (done) {
          this.waiting.delete(message.id);
          done(message);
        }
      });
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
  }

  /** Evaluates JavaScript in the app's page and returns its (awaited) value. */
  async eval(expression) {
    const id = ++this.next;
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`no answer from the page: ${expression.slice(0, 80)}`));
      }, 20_000);
      this.waiting.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
      this.ws.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (answer.error) throw new Error(answer.error.message);
    if (answer.result.exceptionDetails) {
      throw new Error(
        answer.result.exceptionDetails.exception?.description ??
          answer.result.exceptionDetails.text,
      );
    }
    return answer.result.result.value;
  }

  exists(selector) {
    return this.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
  }
  text(selector) {
    return this.eval(
      `(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`,
    );
  }
  click(selector) {
    return this.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  type(selector, value) {
    return this
      .eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  }
  waitFor(what, expression, timeoutMs = 15_000) {
    return waitFor(what, () => this.eval(expression), timeoutMs);
  }
  /** A call to the app's own bridge (the same the screens use). */
  bridge(method, args = {}) {
    return this.eval(`window.__lika.call(${JSON.stringify(method)}, ${JSON.stringify(args)})`);
  }
  async state() {
    return (await this.bridge('getState')).data;
  }
}

async function signIn(page, password = 'Owner12345') {
  await page.waitFor('the sign-in form', `!!document.getElementById('signin-submit')`);
  await page.type('#signin-server', PHONE_SERVER);
  await page.type('#signin-username', 'telefon');
  await page.type('#signin-email', 'telefon@test.local');
  await page.type('#signin-password', password);
  await page.click('#signin-submit');
}

function launch(extra = '') {
  shell(`am start -W -n ${PKG}/.MainActivity ${extra}`.trim(), { timeout: 60_000 });
}

async function setUserActive(active) {
  const owner = await as('owner');
  const users = await call('GET', '/users', undefined, owner);
  const phoneUser = (users.items ?? users).find((u) => u.username === 'telefon');
  await call('PATCH', `/users/${phoneUser.id}`, { isActive: active }, owner);
}

// ─── The run ─────────────────────────────────────────────────────────────────────────────────

let page = null;
try {
  section('The device');
  const release = shell('getprop ro.build.version.release').trim();
  const sdk = shell('getprop ro.build.version.sdk').trim();
  // The realme Note 60's screen: 720 × 1600 at density 2 (360 × 800 dp).
  shell('wm size 720x1600');
  shell('wm density 320');
  shell(
    'settings put global window_animation_scale 0; settings put global transition_animation_scale 0; settings put global animator_duration_scale 0',
  );
  shell('svc power stayon true', { allowFail: true });
  shell('input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard', { allowFail: true });
  log(
    `  Android ${release} (API ${sdk}), ${shell('getprop ro.product.model').trim()}, screen ${shell('wm size').trim().split('\n').pop()}, ${shell('wm density').trim().split('\n').pop()}`,
  );
  const webview = /versionName=(\S+)/.exec(
    shell('dumpsys package com.android.webview com.google.android.webview | grep -m1 versionName', {
      allowFail: true,
    }),
  )?.[1];
  log(`  WebView ${webview ?? '(unknown)'}`);

  await commands.setup();
  await setUserActive(true);
  adb(['uninstall', PKG], { allowFail: true });
  const installed = adb(['install', '-r', APK], { timeout: 180_000 });
  check('the APK installs', /Success/.test(installed), installed);
  const info = shell(`dumpsys package ${PKG}`);
  log(
    `  ${/versionName=\S+/.exec(info)?.[0]} ${/targetSdk=\d+/.exec(info)?.[0]} ${/minSdk=\d+/.exec(info)?.[0]}`,
  );

  section('First start and sign-in');
  launch();
  page = await Page.attach();
  await page.waitFor('the sign-in form', `!!document.getElementById('signin-submit')`);
  ok('the app starts on the sign-in screen');
  await sleep(600);
  screenshot('signin');
  const layout = await page.eval(
    `JSON.stringify({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, scrollW: document.documentElement.scrollWidth })`,
  );
  log(`  page ${layout}`);
  check(
    'the page is as wide as the screen (no sideways scroll)',
    JSON.parse(layout).scrollW <= JSON.parse(layout).w,
    layout,
  );

  await step('a wrong password', async () => {
    await signIn(page, 'gabim-gabim');
    const error = await page.waitFor(
      'the error message',
      `(document.getElementById('signin-error') || {}).textContent || ''`,
      20_000,
    );
    check('a wrong password is refused in words', error.includes('nuk përputhen'), error);
    screenshot('signin-error');
  });

  await step('sign-in', async () => {
    await signIn(page);
    await page.waitFor('the Live screen', `!!document.getElementById('view-live')`, 25_000);
    ok('the owner signs in through the app’s own screen');
  });

  await step('the notification permission', async () => {
    // Android 13+: the app asks right after the first sign-in; the system shows its own dialog.
    let allowed = false;
    try {
      const button = await waitFor(
        'Android’s permission dialog',
        () => uiNodes().find((n) => n.id.endsWith('permission_allow_button')),
        15_000,
        1000,
      );
      screenshot('permission-dialog');
      tap(button);
      allowed = true;
      ok('Android asks for the notification permission, and "Allow" is tapped');
    } catch (e) {
      fail(
        'Android asks for the notification permission',
        `${e.message}; granting it with adb instead`,
      );
      shell(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`, { allowFail: true });
    }
    await waitFor(
      'the permission',
      async () => (await page.state()).setup.notifications === 'granted',
      10_000,
    );
    if (allowed) ok('the app sees the permission as granted');
  });

  await step('the background service', async () => {
    await waitFor('the service', () => serviceRunning(), 10_000);
    check(
      'the background service runs in the foreground (Android 14 "special use")',
      serviceForeground(),
      () => servicesDump().slice(0, 1500),
    );
    const state = await waitFor(
      'the link',
      async () => {
        const s = await page.state();
        return s.connection === 'online' ? s : null;
      },
      20_000,
    );
    ok(
      `the live link to the server is up (server ${state.serverVersion}, ${state.device.brand} ${state.device.model}, Android ${state.device.release})`,
    );
    await expectNotification(
      'the permanent notification shows the day so far',
      (n) => n.channel === 'status' && /^Sot \d+\.\d\d € · \d+ shitje$/.test(n.title),
    );
  });

  await step('the battery question', async () => {
    check(
      'before: the phone may put the app to sleep',
      (await page.state()).setup.battery === false,
    );
    await sleep(800);
    screenshot('live-setup');
    await page.click('#setup-battery');
    try {
      const button = await waitFor(
        'Android’s battery dialog',
        () => uiNodes().find((n) => n.id === 'android:id/button1'),
        15_000,
        1000,
      );
      screenshot('battery-dialog');
      tap(button);
      ok('Android asks whether the app may always run in the background, and "Allow" is tapped');
    } catch (e) {
      fail('Android asks about the battery', `${e.message}; allowing it with adb instead`);
      shell('input keyevent KEYCODE_BACK', { allowFail: true });
      shell(`dumpsys deviceidle whitelist +${PKG}`);
    }
    await waitFor('the exemption', async () => (await page.state()).setup.battery === true, 10_000);
    ok('the app sees that it may run in the background');
  });

  section('Sales, with the app open');
  await step('a sale', async () => {
    await saleArrives('a sale made on the server is a notification on the phone');
    await page.waitFor(
      'the sale on the Live screen',
      `document.querySelectorAll('#feed .sale').length > 0 && document.getElementById('turnover').textContent`,
      10_000,
    );
    const staff = await page.text('#staff');
    check(
      'the Live screen shows who sold how much',
      staff.includes('Kasjere Test') && /\d+\.\d\d €/.test(staff),
      staff,
    );
    await sleep(700);
    screenshot('live');
    await expectNotification(
      'the permanent notification says who sold how much',
      (n) => n.channel === 'status' && /Kasjere Test \d+\.\d\d €/.test(n.text),
    );
  });

  await step('a change', async () => {
    await commands.expense(1250);
    await expectNotification(
      'an expense is announced (from the audit log)',
      (n) => n.channel === 'money' && n.title === 'Shpenzim 12.50 €',
    );
    await commands.refund();
    await expectNotification(
      'a refund is an alert',
      (n) => n.channel === 'alerts' && /^Rimbursim /.test(n.title),
    );
  });

  await step('the activity screen', async () => {
    // A real touch on the screen, where the tab is drawn.
    const webView = uiNodes().find((n) => n.cls === 'android.webkit.WebView' && n.pkg === PKG);
    const r = JSON.parse(
      await page.eval(
        `JSON.stringify(document.getElementById('tab-activity').getBoundingClientRect())`,
      ),
    );
    const dpr = await page.eval('devicePixelRatio');
    const top = webView ? webView.bounds[1] : 48;
    shell(
      `input tap ${Math.round((r.x + r.width / 2) * dpr)} ${Math.round(top + (r.y + r.height / 2) * dpr)}`,
    );
    await page.waitFor(
      'the Activity tab',
      `document.getElementById('tab-activity').className.includes('tab--on') && document.querySelectorAll('#view-activity .act').length > 3`,
      10_000,
    );
    const first = await page.text('#view-activity .acts');
    check(
      'a finger tap on "Aktiviteti" opens the list of changes',
      first.includes('Rimbursim') && first.includes('Shpenzim 12.50 €'),
      first.slice(0, 300),
    );
    await sleep(500);
    screenshot('activity');
  });

  await step('the notification shade', async () => {
    shell('cmd statusbar expand-notifications');
    await sleep(1500);
    screenshot('shade');
    shell('cmd statusbar collapse');
    await sleep(500);
  });

  section('The app in the background');
  await step('home', async () => {
    shell('input keyevent KEYCODE_HOME');
    await sleep(1500);
    await saleArrives('a sale while another app is in front');
  });
  await step('screen off', async () => {
    shell('svc power stayon false', { allowFail: true });
    shell('input keyevent KEYCODE_SLEEP');
    await sleep(2000);
    check(
      'the screen is off',
      /mWakefulness=(Asleep|Dozing)/.test(shell('dumpsys power | grep mWakefulness=')),
      () => shell('dumpsys power | grep mWakefulness='),
    );
    await saleArrives('a sale with the screen off');
    await commands['credit-sale']();
    await expectNotification(
      'a sale on credit names the customer',
      (n) => n.channel === 'sales' && /me borxh: Arben Test/.test(`${n.text} ${n.big}`),
    );
  });

  if (STEPS.has('doze')) {
    await step('deep sleep', async () => {
      shell('dumpsys battery unplug');
      const forced = shell('dumpsys deviceidle force-idle', { allowFail: true }).trim();
      await sleep(1500);
      const mode = shell('dumpsys deviceidle get deep', { allowFail: true }).trim();
      check('the phone is in deep sleep (Doze)', mode === 'IDLE', `${forced} / ${mode}`);
      await saleArrives(
        'a sale during deep sleep (the app is exempt from battery optimisation)',
        20_000,
      );
      shell('dumpsys deviceidle unforce', { allowFail: true });
      shell('dumpsys battery reset', { allowFail: true });
    });
  }

  if (STEPS.has('kill')) {
    section('The phone kills the app');
    await step('killed', async () => {
      const before = pid();
      const known = new Set(sales().map((n) => n.key));
      adb(['root'], { allowFail: true });
      await sleep(3000);
      adb(['wait-for-device'], { timeout: 60_000 });
      shell(`kill -9 ${before}`, { allowFail: true });
      await sleep(500);
      check('the process is gone', pid() !== before, () => `still ${pid()}`);
      await commands.sale(); // while nothing is running
      const after = await waitFor(
        'the service to come back by itself',
        () => {
          const p = pid();
          return p && p !== before && serviceRunning() ? p : null;
        },
        90_000,
        1000,
      );
      ok(
        `Android restarts the service by itself (process ${before} → ${after}), without the app being opened`,
      );
      await expectNotification(
        'the sale made while it was dead is announced after all',
        (n) => n.channel === 'sales' && / shiti /.test(n.title) && !known.has(n.key),
        40_000,
      );
      await saleArrives('and new sales arrive again');
    });
  }

  if (STEPS.has('reboot')) {
    section('The phone restarts');
    await step('reboot', async () => {
      page?.close();
      page = null;
      adb(['reboot'], { allowFail: true });
      await sleep(5000);
      adb(['wait-for-device'], { timeout: 300_000 });
      await waitFor(
        'the phone to finish starting',
        () => shell('getprop sys.boot_completed', { allowFail: true }).trim() === '1',
        300_000,
        2000,
      );
      ok('the phone is back');
      await waitFor('the service after the restart', () => serviceRunning(), 120_000, 2000);
      ok('the service starts by itself after the restart: the app was not opened');
      await expectNotification(
        'the permanent notification is back and the link is live',
        (n) => n.channel === 'status' && n.sub === 'live',
        90_000,
      );
      await saleArrives('a sale after the restart, app still not opened', 30_000);
    });
  }

  section('Opening from a notification');
  await step('open on a tab', async () => {
    shell('input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard', { allowFail: true });
    shell('svc power stayon true', { allowFail: true });
    await sleep(1000);
    // What a tap on an "activity" notification sends.
    launch('-a com.likapcs.live.OPEN --es tab activity');
    page?.close();
    page = await Page.attach();
    await page.waitFor(
      'the Activity tab',
      `!!document.getElementById('tab-activity') && document.getElementById('tab-activity').className.includes('tab--on')`,
      20_000,
    );
    ok('the app opens on the list the notification belongs to');
    check('still signed in', (await page.state()).signedIn === true);
  });

  await step('settings', async () => {
    await page.click('#tab-settings');
    await page.waitFor('the settings', `!!document.getElementById('settings-kinds')`);
    await sleep(500);
    screenshot('settings');
    await page.click('#lang-en');
    await page.waitFor(
      'English',
      `document.documentElement.lang === 'en' && !!document.getElementById('signout')`,
    );
    await expectNotification(
      'English: the permanent notification changes too',
      (n) => n.channel === 'status' && /^Today /.test(n.title),
    );
    await page.click('#lang-sq');
    await page.waitFor('Albanian', `document.documentElement.lang === 'sq'`);
    await page.click('#settings-test');
    await expectNotification(
      '"send a test notification"',
      (n) => n.channel === 'sales' && n.title === 'Arta shiti 3.50 €',
    );
  });

  section('The sign-in ends on the server');
  await step('ended', async () => {
    await setUserActive(false);
    await page.bridge('refresh');
    await page.waitFor('the sign-in screen', `!!document.getElementById('signin-submit')`, 30_000);
    ok('the app goes back to the sign-in screen');
    await expectNotification(
      'the owner is told to sign in again',
      (n) => n.channel === 'connection' && n.title === 'Hyni përsëri në likalivepcs',
    );
    await waitFor('the service to stop', () => !serviceRunning(), 15_000);
    ok('the background service stops (nothing to watch without a sign-in)');
    await sleep(500);
    screenshot('signed-out');
    await setUserActive(true);
    await signIn(page);
    await page.waitFor('the Live screen', `!!document.getElementById('view-live')`, 25_000);
    await waitFor('the service', () => serviceRunning(), 10_000);
    await saleArrives('after signing in again, sales arrive');
  });

  section('Sign-out');
  await step('sign-out', async () => {
    await page.click('#tab-settings');
    await page.waitFor('the settings', `!!document.getElementById('signout')`);
    await page.click('#signout');
    await sleep(300);
    await page.click('#signout');
    await page.waitFor('the sign-in screen', `!!document.getElementById('signin-submit')`, 15_000);
    await waitFor(
      'everything to be gone',
      () => !serviceRunning() && notifications().length === 0,
      15_000,
    );
    ok('signed out: no service, no notification left');
    await commands.sale();
    await sleep(4000);
    check('and nothing arrives any more', notifications().length === 0, () =>
      show(notifications()),
    );
  });

  const crashes = shell('logcat -d -b crash -v brief', { allowFail: true })
    .split('\n')
    .filter((l) => l.includes(PKG) || l.includes('likalive'));
  check('the app never crashed', crashes.length === 0, crashes.slice(0, 20).join('\n'));
} catch (e) {
  fail('the check itself', e.stack ?? String(e));
  screenshot('failure');
} finally {
  page?.close();
  try {
    fs.writeFileSync(
      path.join(OUT, 'logcat.txt'),
      adb(
        [
          'logcat',
          '-d',
          '-v',
          'time',
          'likalive:V',
          'AndroidRuntime:E',
          'ActivityManager:W',
          '*:S',
        ],
        { allowFail: true },
      ),
    );
    fs.writeFileSync(
      path.join(OUT, 'notifications.txt'),
      shell('dumpsys notification --noredact', { allowFail: true }),
    );
  } catch {
    /* the device is gone */
  }
  await setUserActive(true).catch(() => undefined);
}

console.log(failures === 0 ? '\nAll phone checks passed.' : `\n${failures} phone check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
