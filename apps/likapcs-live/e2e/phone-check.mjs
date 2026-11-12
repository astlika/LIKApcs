// Checks the real app on an Android device or emulator: installs the APK, signs in through the
// app's own screen, makes real sales on a test server and reads what Android itself reports —
// the notifications, the background service — with the app open, in the background, with the
// screen off, in deep sleep (Doze), after its process is killed and after the phone restarts.
//
//   node phone-check.mjs <debug.apk> [release.apk]
//
// Needs: `adb` with one device attached (an emulator: the server on this machine is 10.0.2.2
// for it), a seeded test server (see engine-check.mjs) and Node 22+. The APK must be the debug
// build: only that one lets a test look into its screen. With a release APK as well, that file
// (the one that is handed out) is installed at the end and used with the touch screen and the
// keyboard alone: sign-in, the permission, a sale, its notification.
//
// Environment: LIKAPCS_URL (the server as this machine sees it), PHONE_SERVER (the address typed
// into the app, default 10.0.2.2:4700), OUT (folder for the screenshots), STEPS (comma list to
// run only some of: doze, kill, reboot, update).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { commands, call, as, sleep, station, allPcsOff } from './shop.mjs';

const APK = process.argv[2];
const RELEASE_APK = process.argv[3];
if (!APK || !fs.existsSync(APK) || (RELEASE_APK && !fs.existsSync(RELEASE_APK))) {
  console.error('usage: node phone-check.mjs <debug.apk> [release.apk]');
  process.exit(2);
}
const PKG = 'com.likapcs.live';
const PHONE_SERVER = process.env.PHONE_SERVER ?? '10.0.2.2:4700';
const OUT = process.env.OUT ?? 'phone-check-out';
const STEPS = new Set((process.env.STEPS ?? 'doze,kill,reboot,update').split(',').filter(Boolean));
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

/**
 * The alarm the app set for its appointment with the clock, as Android lists it:
 * { when (epoch ms), window ("0" = exact), reason (why Android allows it to be exact), flags }.
 */
function clockAlarm() {
  const dump = shell('dumpsys alarm', { timeout: 30_000 });
  const found =
    /Alarm\{\S+ type \d+ origWhen (\d+) whenElapsed \d+ com\.likapcs\.live\}\s*\n\s*tag=\S*com\.likapcs\.live\.CLOCK\s*\n\s*type=\S+ origWhen=.*? window=(\S+)(?: exactAllowReason=(\S+))?.*? flags=(0x[0-9a-f]+)/.exec(
      dump,
    );
  if (!found) return null;
  return { when: Number(found[1]), window: found[2], reason: found[3] ?? '', flags: found[4] };
}

/** The app's notification channels as Android holds them: the ids. */
function channels() {
  const dump = shell('dumpsys notification --noredact', { timeout: 30_000 });
  const start = dump.indexOf(`AppSettings: ${PKG} (`);
  if (start < 0) return [];
  const next = dump.indexOf('AppSettings: ', start + 20);
  const block = dump.slice(start, next < 0 ? undefined : next);
  return [...block.matchAll(/NotificationChannel\{mId='([^']+)'/g)].map((m) => m[1]);
}

/** "HH:MM" on the phone's own clock, `minutes` from now. */
function phoneClock(minutes = 0) {
  const [h, m] = shell('date +%H:%M').trim().split(':').map(Number);
  const at = (((h * 60 + m + minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
}

function forceDoze() {
  shell('dumpsys battery unplug');
  shell('dumpsys deviceidle enable', { allowFail: true });
  const forced = shell('dumpsys deviceidle force-idle', { allowFail: true }).trim();
  return { forced, mode: () => shell('dumpsys deviceidle get deep', { allowFail: true }).trim() };
}
function endDoze() {
  shell('dumpsys deviceidle unforce', { allowFail: true });
  shell('dumpsys battery reset', { allowFail: true });
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

let phoneUserId = null;
async function setUserActive(active) {
  const owner = await as('owner');
  if (!phoneUserId) {
    // Looked up once: a switched-off account is no longer in the list.
    const users = await call('GET', '/users', undefined, owner);
    phoneUserId = (users.items ?? users).find((u) => u.username === 'telefon').id;
  }
  await call('PATCH', `/users/${phoneUserId}`, { isActive: active }, owner);
}

/** Where the app's page starts on the screen (below the status bar), in pixels. */
function pageTop() {
  const bar = /type=statusBars frame=\[0,0\]\[\d+,(\d+)\]/.exec(
    shell('dumpsys window displays', { allowFail: true }),
  );
  return bar ? Number(bar[1]) : 48;
}
/** The colour [r, g, b] of one pixel of a PNG screenshot (8-bit RGB or RGBA, not interlaced). */
function pixel(png, x, y) {
  let pos = 8;
  let width = 0;
  let channels = 4;
  const parts = [];
  while (pos < png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.toString('latin1', pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      if (body[8] !== 8 || body[12] !== 0 || (body[9] !== 6 && body[9] !== 2))
        throw new Error('unsupported PNG');
      channels = body[9] === 6 ? 4 : 3;
    }
    if (type === 'IDAT') parts.push(body);
    pos += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  let previous = Buffer.alloc(stride);
  let row = previous;
  for (let r = 0; r <= y; r++) {
    const start = r * (stride + 1);
    const filter = raw[start];
    row = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      row[i] = (row[i] + add) & 255;
    }
    previous = row;
  }
  return [row[x * channels], row[x * channels + 1], row[x * channels + 2]];
}

/**
 * Is this tab drawn as the open one — on the screen itself, not in the page's own book-keeping?
 * The open tab has a blue bar along its top edge; a screenshot tells.
 */
async function tabDrawnOpen(page, selector) {
  const r = JSON.parse(
    await page.eval(
      `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`,
    ),
  );
  const dpr = await page.eval('devicePixelRatio');
  const png = adb(['exec-out', 'screencap', '-p'], { binary: true });
  const [red, green, blue] = pixel(
    png,
    Math.round((r.x + r.width / 2) * dpr),
    Math.round(pageTop() + r.y * dpr + 3),
  );
  return blue > 200 && red < 110 && green > 90 && green < 170;
}

/** Taps a tab with a finger and waits until the screen shows it open; returns how long that took (ms). */
async function tapTab(page, selector, name) {
  check(`before the tap, "${name}" is not the open tab`, !(await tabDrawnOpen(page, selector)));
  const at = Date.now();
  await tapElement(page, selector);
  await waitFor(`"${name}" drawn as the open tab`, () => tabDrawnOpen(page, selector), 8000, 50);
  return Date.now() - at;
}

/** A finger tap in the middle of an element of the page. */
async function tapElement(page, selector) {
  const r = JSON.parse(
    await page.eval(
      `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`,
    ),
  );
  const dpr = await page.eval('devicePixelRatio');
  shell(
    `input tap ${Math.round((r.x + r.width / 2) * dpr)} ${Math.round(pageTop() + (r.y + r.height / 2) * dpr)}`,
  );
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
  // Four of the six PCs get a (pretend) client program, as in a real shop; all are off for now.
  await commands['pc-pair'](1, 2, 3, 5);
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
  // Where the form is drawn, in screen pixels: the release build shows the same page.
  const formAt = JSON.parse(
    await page.eval(`JSON.stringify(Object.fromEntries(['signin-server', 'signin-submit'].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, [Math.round((r.x + r.width / 2) * devicePixelRatio), Math.round((r.y + r.height / 2) * devicePixelRatio)]];
    })))`),
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
    const dayBefore = notifications().find((n) => n.channel === 'status')?.title ?? '';
    const turnoverBefore = await page.text('#turnover');
    await saleArrives('a sale made on the server is a notification on the phone');
    await page.waitFor(
      'the sale on the Live screen',
      `document.querySelectorAll('#feed .sale').length > 0 && document.getElementById('turnover').textContent !== ${JSON.stringify(turnoverBefore)}`,
      10_000,
    );
    const staff = await page.text('#staff');
    check(
      'the Live screen shows the new total and who sold how much',
      staff.includes('Kasjere Test') && /\d+\.\d\d €/.test(staff),
      staff,
    );
    await sleep(700);
    screenshot('live');
    await expectNotification(
      `the permanent notification moves on from "${dayBefore}"`,
      (n) =>
        n.channel === 'status' &&
        /^Sot /.test(n.title) &&
        n.title !== dayBefore &&
        /Kasjere Test \d+\.\d\d €/.test(n.text),
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
    // Real touches, and what the screen itself then shows (screenshots, not the page's word).
    // First let the refund's pop-up leave the screen: the delay measured below is the app's own.
    await sleep(6500);
    const opened = await tapTab(page, '#tab-activity', 'Aktiviteti');
    ok(
      `a finger tap on "Aktiviteti" opens it on the screen (${opened} ms, including the screenshot)`,
    );
    await page.waitFor(
      'the list',
      `document.querySelectorAll('#view-activity .act').length > 3`,
      10_000,
    );
    const first = await page.text('#view-activity .acts');
    check(
      'the list of changes has the refund and the expense',
      first.includes('Rimbursim') && first.includes('Shpenzim 12.50 €'),
      first.slice(0, 300),
    );
    screenshot('activity');
    // A finger swipe scrolls the list.
    const before = await page.eval(`document.getElementById('view-activity').scrollTop`);
    shell('input swipe 360 1200 360 500 300');
    await sleep(800);
    const after = await page.eval(`document.getElementById('view-activity').scrollTop`);
    check('a finger swipe scrolls the list', after > before + 100, `${before} → ${after}`);
    screenshot('activity-scrolled');
    const back = await tapTab(page, '#tab-live', 'Live');
    ok(`a finger tap on "Live" goes back (${back} ms)`);
    // What a tap on a notification does while the app is open: the same window, another tab.
    launch('-a com.likapcs.live.OPEN --es tab settings');
    await page.waitFor(
      'the Settings tab',
      `document.getElementById('tab-settings').className.includes('tab--on')`,
      10_000,
    );
    ok('a notification tapped while the app is open switches the tab');
    await page.click('#tab-live');
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
    // For the check of the clock further down: "time is running out" one minute before the end.
    await page.bridge('setOptions', { options: { 'ending.minutes': 1 } });
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
      shell('dumpsys deviceidle enable', { allowFail: true });
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

    await step('the clock, in deep sleep', async () => {
      // 1.1: "PC 05: one minute left" is not sent by the server: the app itself has to wake up
      // at that minute, with the screen off and the phone in deep sleep.
      await commands['session-start'](5, 2);
      const endsAt = Date.parse((await station(5, await as('owner'))).activeSession.endsAt);
      const due = endsAt - 60_000;
      const alarm = await waitFor('the app’s alarm', () => clockAlarm(), 10_000, 1000).catch(
        () => null,
      );
      check(
        'the app asks Android to wake it at that minute',
        alarm && Math.abs(alarm.when - due) < 5000,
        () => `alarm ${JSON.stringify(alarm)}, the minute ${due}`,
      );
      check(
        `…to the second, without a further permission (Android: "${alarm?.reason}", flags ${alarm?.flags})`,
        alarm?.window === '0',
        () => JSON.stringify(alarm),
      );
      const doze = forceDoze();
      await sleep(1500);
      check('the phone is in deep sleep again', doze.mode() === 'IDLE', doze.forced);
      const warned = await expectNotification(
        'a session with a minute left is told while the phone sleeps',
        (n) => n.channel === 'pcs' && n.title === 'PC 05: mbeten 1 min',
        Math.max(15_000, due + 40_000 - Date.now()),
      );
      const late = Date.now() - due;
      if (warned) {
        check(
          `…at that minute (seen ${(late / 1000).toFixed(1)} s after it)`,
          late > -3000 && late < 20_000,
          `${late} ms`,
        );
      }
      await expectNotification(
        'and the time running out, a minute later',
        (n) => n.channel === 'pcs' && n.title === 'PC 05: koha mbaroi',
        Math.max(15_000, endsAt + 45_000 - Date.now()),
      );
      endDoze();
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

    await step('stopped', async () => {
      // Some phones stop a background service without killing the app. The app sets an alarm
      // every few minutes for that: here the service is stopped and the alarm is sent by hand.
      const alarms = shell('dumpsys alarm', { timeout: 30_000 });
      check(
        'a wake-up alarm is waiting',
        /com\.likapcs\.live\.WAKE/.test(alarms),
        'no com.likapcs.live.WAKE in dumpsys alarm',
      );
      shell(`am stopservice -n ${PKG}/.LiveService`, { allowFail: true });
      await waitFor('the service to be stopped', () => !serviceRunning(), 15_000);
      shell(`am broadcast -n ${PKG}/.WakeReceiver -a com.likapcs.live.WAKE`, { allowFail: true });
      await waitFor(
        'the service after the alarm',
        () => serviceRunning() && serviceForeground(),
        20_000,
      );
      ok('the alarm finds the service stopped and starts it again');
      await saleArrives('and sales arrive');
    });
  }

  if (STEPS.has('reboot')) {
    section('The phone restarts');
    await step('reboot', async () => {
      page?.close();
      page = null;
      fs.writeFileSync(
        path.join(OUT, 'logcat-before-restart.txt'),
        adb(['logcat', '-d', '-v', 'time', 'likalive:V', 'AndroidRuntime:E', 'chromium:W', '*:S'], {
          allowFail: true,
        }),
      );
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

  if (STEPS.has('update')) {
    section('The app is updated');
    await step('update', async () => {
      // Installing a new version over the old one ends the running app. It must come back by
      // itself, still signed in, without being opened.
      const before = pid();
      const again = adb(['install', '-r', APK], { timeout: 180_000 });
      check('the new version installs over the old one', /Success/.test(again), again);
      await waitFor(
        'the service after the update',
        () => serviceRunning() && pid() !== before,
        90_000,
        1000,
      );
      ok('the service starts by itself after the update: the app was not opened');
      await expectNotification(
        'the link is live again',
        (n) => n.channel === 'status' && n.sub === 'live',
        60_000,
      );
      await saleArrives('a sale after the update', 30_000);
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

  section('What is new in 1.1');
  await step('the kinds', async () => {
    const ids = channels();
    check(
      'Android has a channel for each new kind, and the silent one',
      ['power', 'day', 'quiet'].every((id) => ids.includes(id)),
      ids.join(', '),
    );
  });

  await step('the finer switches', async () => {
    await page.click('#tab-settings');
    await page.waitFor(
      'the new switches',
      `!!document.querySelector('[data-kind="power"]') && !!document.querySelector('[data-kind="day"]') && !!document.querySelector('[data-topic="pc.wake"]')`,
    );
    await page.eval(
      `document.querySelector('[data-kind="pcs"]').scrollIntoView({ block: 'start' })`,
    );
    await sleep(600);
    screenshot('settings-pcs');
    await page.click('[data-topic="pc.wake"]');
    await waitFor('the switch', async () => (await page.state()).topics['pc.wake'] === false);
    await page.click('[data-topic="pc.wake"]');
    await waitFor('the switch', async () => (await page.state()).topics['pc.wake'] === true);
    ok('a switch inside a kind is switched off and on again from the screen');
    // A number typed into its field (the check above set it to 1).
    await page.eval(`(() => { const el = document.querySelector('[data-option="ending.minutes"]');
      el.focus(); el.value = '5'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor('the minutes', async () => (await page.state()).options['ending.minutes'] === 5);
    ok('"minutes before the end" is typed into its field and stored');
    await page.eval(`(() => { const el = document.querySelector('[data-option="ending.minutes"]');
      el.focus(); el.value = '0'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await sleep(800);
    check(
      'a value that makes no sense is not stored, and the field is marked',
      (await page.state()).options['ending.minutes'] === 5 &&
        (await page.eval(
          `document.querySelector('[data-option="ending.minutes"]').parentNode.className.includes('opt--bad')`,
        )),
    );
    await page.eval(
      `document.querySelector('[data-kind="power"]').scrollIntoView({ block: 'start' })`,
    );
    await sleep(600);
    screenshot('settings-power');
    await page.eval(`document.getElementById('settings-quiet').scrollIntoView({ block: 'start' })`);
    await sleep(600);
    screenshot('settings-quiet');
  });

  await step('PCs coming on', async () => {
    await commands['pc-on'](1);
    const first = await expectNotification(
      'a PC that comes on is a notification of the new kind',
      (n) => n.channel === 'power' && n.title === 'PC 01 u ndez',
    );
    await commands['pc-on'](2);
    await commands['pc-on'](3);
    const grown = await expectNotification(
      'the ones right behind it make the same notification grow',
      (n) => n.title === 'U ndezën 3 PC',
    );
    const about = notifications().filter((n) => /u ndez$|^U ndezën/.test(n.title));
    check(
      '…one notification in the place of the first, not three',
      first && grown && grown.key === first.key && about.length === 1,
      () => show(about),
    );
    await commands['pc-wake-all']();
    await expectNotification(
      '"Ndiz të gjitha" in the Admin: who did it, and how many PCs',
      (n) =>
        n.channel === 'power' && /^Pronari Test i ndezi të gjitha PC-të \(\d+\)$/.test(n.title),
      20_000,
    );
    shell('cmd statusbar expand-notifications');
    await sleep(1500);
    screenshot('shade-pcs');
    shell('cmd statusbar collapse');
    await sleep(500);
    allPcsOff();
  });

  await step('quiet hours', async () => {
    const set = await page.bridge('setOptions', {
      options: { 'quiet.on': true, 'quiet.from': phoneClock(-60), 'quiet.to': phoneClock(60) },
    });
    check('the quiet hours are set around now', set.ok && set.data.options['quiet.on'] === true);
    const before = new Set(notifications().map((n) => n.key));
    await commands.sale();
    const hushed = await expectNotification(
      'a sale during the quiet hours is still shown',
      (n) => !before.has(n.key) && / shiti /.test(n.title),
    );
    check(
      '…through the silent channel, still as a sale',
      hushed?.channel === 'quiet' && /\|sales\|/.test(hushed?.key ?? ''),
      () => JSON.stringify(hushed),
    );
    await page.bridge('setOptions', { options: { 'quiet.on': false } });
    await saleArrives('with the quiet hours over, a sale rings again');
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

  if (RELEASE_APK) {
    section('The release APK (the file that is handed out)');
    await step('release', async () => {
      page?.close();
      page = null;
      // A release build cannot be looked into: only the touch screen, the keyboard, screenshots
      // and what Android reports are used here.
      adb(['uninstall', PKG], { allowFail: true });
      const installed = adb(['install', RELEASE_APK], { timeout: 180_000 });
      check('the release APK installs', /Success/.test(installed), installed);
      const flags = /pkgFlags=\[([^\]]*)\]/.exec(shell(`dumpsys package ${PKG}`))?.[1] ?? '';
      check('it is not a debug build', !/DEBUGGABLE/.test(flags), flags);
      launch();
      const top = pageTop();
      const [submitX, submitY] = formAt['signin-submit'];
      const blueButton = () => {
        const [red, green, blue] = pixel(
          adb(['exec-out', 'screencap', '-p'], { binary: true }),
          submitX,
          top + submitY - 30,
        );
        return blue > 200 && red < 80 && green > 70 && green < 130;
      };
      await waitFor('the sign-in screen to be drawn', blueButton, 30_000, 500);
      ok('it starts and draws the sign-in screen');
      // The form by touch and keyboard: a tap into the first field, Tab from field to field
      // (the search button and the eye button are stops too), Enter to sign in.
      const [serverX, serverY] = formAt['signin-server'];
      shell(`input tap ${serverX} ${top + serverY}`);
      await sleep(600);
      shell(`input text '${PHONE_SERVER}'`);
      shell('input keyevent KEYCODE_TAB; input keyevent KEYCODE_TAB');
      shell(`input text 'telefon'`);
      shell('input keyevent KEYCODE_TAB');
      shell(`input text 'telefon@test.local'`);
      shell('input keyevent KEYCODE_TAB');
      shell(`input text 'Owner12345'`);
      await sleep(300);
      screenshot('release-form');
      shell('input keyevent KEYCODE_ENTER');
      try {
        const allow = await waitFor(
          'Android’s permission dialog',
          () => uiNodes().find((n) => n.id.endsWith('permission_allow_button')),
          25_000,
          1000,
        );
        tap(allow);
        ok(
          'typed with the keyboard, the sign-in works and Android asks for the notification permission',
        );
      } catch (e) {
        fail('the sign-in with the keyboard', e.message);
        screenshot('release-failure');
        return;
      }
      await waitFor('the service', () => serviceRunning() && serviceForeground(), 20_000);
      await expectNotification(
        'the release build is live',
        (n) => n.channel === 'status' && n.sub === 'live' && /^Sot /.test(n.title),
        30_000,
      );
      await saleArrives('a sale is a notification in the release build');
      await sleep(1500);
      screenshot('release-live');
      adb(['uninstall', PKG], { allowFail: true });
    });
  }

  const crashes = shell('logcat -d -b crash -v brief', { allowFail: true })
    .split('\n')
    .filter((l) => l.includes(PKG) || l.includes('likalive'));
  check('the app never crashed', crashes.length === 0, crashes.slice(0, 20).join('\n'));
} catch (e) {
  fail('the check itself', e.stack ?? String(e));
  screenshot('failure');
} finally {
  allPcsOff();
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
