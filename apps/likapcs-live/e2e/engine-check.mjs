// Checks the engine (the part that runs in the phone's background service) against a real
// LIKApcs server, on a desktop JVM: real sign-in, real WebSocket, real sales — and the texts of
// the notifications it would show. No phone and no emulator are involved.
//
// Needs: a seeded test server (node e2e/seed.mjs && node e2e/users.mjs from the repo root, then
// `node shop.mjs setup`) and the dev host:
//   LIKALIVE_DEVHOST="<command that starts DevHost>" node engine-check.mjs
// The command gets two more arguments: the port and the store file.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { commands, call, as, sleep, allPcsOff } from './shop.mjs';

const HOST_CMD = process.env.LIKALIVE_DEVHOST;
if (!HOST_CMD) {
  console.error('Set LIKALIVE_DEVHOST to the command that starts the dev host.');
  process.exit(2);
}
const SERVER = (process.env.LIKAPCS_URL ?? 'http://127.0.0.1:4700/api/v1').replace(
  /\/api\/v1$/,
  '',
);
const PORT = Number(process.env.LIKALIVE_DEVHOST_PORT ?? 4781);
const STORE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'likalive-check-')), 'store.json');
const BRIDGE = `http://127.0.0.1:${PORT}`;

// The engine reaches the server through this relay, so the check can take the network away:
// 'refuse' (the server is gone: connections are cut and refused) and 'silent' (the worst case:
// connections stay open but nothing gets through, as when the Wi-Fi dies without a word).
const RELAY_PORT = Number(process.env.LIKALIVE_RELAY_PORT ?? PORT + 1);
const relay = { mode: 'open', pairs: new Set(), server: null };
function startRelay() {
  const target = new URL(SERVER);
  relay.server = net.createServer((client) => {
    if (relay.mode === 'refuse') {
      client.destroy();
      return;
    }
    const upstream = net.connect(Number(target.port || 80), target.hostname);
    const pair = { client, upstream };
    relay.pairs.add(pair);
    const drop = () => {
      relay.pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on('data', (d) => {
      if (relay.mode === 'open') upstream.write(d);
    });
    upstream.on('data', (d) => {
      if (relay.mode === 'open') client.write(d);
    });
    client.on('close', drop);
    upstream.on('close', drop);
    client.on('error', drop);
    upstream.on('error', drop);
  });
  return new Promise((resolve) => relay.server.listen(RELAY_PORT, '127.0.0.1', resolve));
}
function network(mode) {
  relay.mode = mode;
  if (mode === 'refuse')
    for (const p of [...relay.pairs]) {
      p.client.destroy();
      p.upstream.destroy();
    }
}
const VIA_RELAY = `127.0.0.1:${RELAY_PORT}`;

let host = null;
let failures = 0;
const ok = (name) => console.log(`  ok   ${name}`);
const fail = (name, detail) => {
  failures++;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
};
/** `detail` (a text, or a function that makes one) is shown only when the check fails. */
const check = (name, passed, detail) => {
  if (passed) ok(name);
  else fail(name, typeof detail === 'function' ? detail() : detail);
};

async function startHost() {
  // The audit log is read every 3 s here (60 s on the phone), so "quiet" changes show up quickly.
  host = spawn('bash', ['-c', `${HOST_CMD} ${PORT} ${STORE}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      LIKALIVE_POLL_MS: process.env.LIKALIVE_POLL_MS ?? '3000',
      LIKALIVE_OUTAGE_MS: process.env.LIKALIVE_OUTAGE_MS ?? '4000',
    },
  });
  host.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`    | ${d}`));
  host.stderr.on('data', (d) => process.env.VERBOSE && process.stderr.write(`    ! ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      await bridge('getState');
      return;
    } catch {
      await sleep(200);
    }
  }
  throw new Error('the dev host did not start');
}
async function stopHost() {
  if (!host) return;
  const done = new Promise((r) => host.once('exit', r));
  host.kill('SIGKILL');
  await done;
  host = null;
}
async function bridge(method, args) {
  const res = await fetch(`${BRIDGE}/bridge/call`, {
    method: 'POST',
    body: JSON.stringify({ method, args }),
  });
  return res.json();
}
const notes = async () => (await fetch(`${BRIDGE}/dev/notes`)).json();
const clearNotes = () => fetch(`${BRIDGE}/dev/notes`, { method: 'DELETE' });
const show = (list) => list.map((n) => `[${n.category}] ${n.title} | ${n.text}`).join('\n       ');

/** Waits until a note matches; reports the notes seen when none does. */
async function expectNote(name, test, timeoutMs = 8000) {
  const until = Date.now() + timeoutMs;
  let list = [];
  while (Date.now() < until) {
    list = await notes();
    const hit = list.find(test);
    if (hit) {
      ok(`${name}  →  ${hit.title} | ${hit.text}`);
      return hit;
    }
    await sleep(250);
  }
  fail(name, `notes seen:\n       ${show(list) || '(none)'}`);
  return null;
}
/** After things have settled: no note may match. */
async function expectNoNote(name, test, settleMs = 2500) {
  await sleep(settleMs);
  const hit = (await notes()).find(test);
  check(name, !hit, () => `unexpected: [${hit.category}] ${hit.title} | ${hit.text}`);
}
async function waitState(name, test, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < until) {
    state = (await bridge('getState')).data;
    if (test(state)) {
      ok(`${name}  →  ${state.connection}`);
      return state;
    }
    await sleep(250);
  }
  fail(
    name,
    `state: ${JSON.stringify({ connection: state?.connection, detail: state?.detail, signedIn: state?.signedIn })}`,
  );
  return state;
}
const has = (category, title, text) => (n) =>
  n.category === category &&
  (title instanceof RegExp ? title.test(n.title) : n.title.includes(title)) &&
  (text === undefined || (text instanceof RegExp ? text.test(n.text) : n.text.includes(text)));

/** "HH:MM" on this machine's clock, `minutes` from now: the quiet hours are the phone's own. */
function clock(minutes = 0) {
  const d = new Date(Date.now() + minutes * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** The same on the shop's clock (the server's time zone): the day's hours follow that one. */
let shopZone = 'UTC';
function shopClock(minutes = 0) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: shopZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() + minutes * 60_000));
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('hour')}:${part('minute')}`;
}
const options = async (values) => bridge('setOptions', values);

async function cancelReservations() {
  const t = await as('owner');
  const from = encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString());
  const to = encodeURIComponent(new Date(Date.now() + 48 * 3_600_000).toISOString());
  const list = await call('GET', `/reservations?from=${from}&to=${to}`, undefined, t);
  for (const r of list.items ?? []) {
    if (r.status !== 'scheduled') continue;
    await call('POST', `/reservations/${r.id}/cancel`, {}, t).catch(() => undefined);
  }
}

async function endOpenSessions() {
  const t = await as('owner');
  for (const s of await call('GET', '/stations', undefined, t)) {
    if (!s.activeSession) continue;
    try {
      await call('POST', `/sessions/${s.activeSession.id}/end`, { paymentMethod: 'cash' }, t);
    } catch {
      /* next */
    }
  }
}

try {
  await commands.setup();
  shopZone = (await call('GET', '/settings/public'))['locale.timezone'] ?? 'UTC';
  await endOpenSessions();
  await cancelReservations();
  // Four of the six PCs get a (pretend) client program, as in a real shop; PC 04 and PC 06 stay
  // without one. All of them are off when the owner signs in.
  await commands['pc-pair'](1, 2, 3, 5);
  await startRelay();
  await startHost();

  console.log('\nSign-in');
  const wrong = await bridge('signIn', {
    server: SERVER,
    username: 'telefon',
    email: 'telefon@test.local',
    password: 'nope-nope',
  });
  check(
    'a wrong password is refused',
    wrong.ok === false && wrong.error.code === 'invalid_credentials',
    () => JSON.stringify(wrong),
  );
  const cashier = await bridge('signIn', {
    server: SERVER,
    username: 'kasjere',
    email: 'kasjere@test.local',
    password: 'Owner12345',
  });
  check(
    'an account without live.view is refused',
    cashier.ok === false && cashier.error.code === 'no_permission',
    () => JSON.stringify(cashier),
  );
  const nowhere = await bridge('signIn', {
    server: 'http://127.0.0.1:9',
    username: 'telefon',
    email: 'telefon@test.local',
    password: 'Owner12345',
  });
  check(
    'an address with no server is reported',
    nowhere.ok === false && nowhere.error.code === 'unreachable',
    () => JSON.stringify(nowhere),
  );
  const signedIn = await bridge('signIn', {
    server: VIA_RELAY,
    username: 'telefon',
    email: 'telefon@test.local',
    password: 'Owner12345',
  });
  check(
    'the owner signs in (address typed without http://)',
    signedIn.ok && signedIn.data.signedIn,
    () => JSON.stringify(signedIn).slice(0, 300),
  );
  await waitState('the link comes up', (s) => s.connection === 'online');
  await expectNoNote('nothing from before the sign-in is announced', () => true, 3000);

  console.log('\nSales');
  await clearNotes();
  await commands.sale();
  await expectNote(
    'a sale: who, what, how much',
    has('sales', /^Kasjere Test shiti \d+\.\d\d €$/, 'Coca-Cola 0.33l ×2, Çips ×1'),
  );
  await expectNote('the cashier signing in', has('people', 'Kasjere Test u kyç', 'nga kompjuteri'));
  await commands['credit-sale']();
  await expectNote(
    'a sale on the tab names the customer',
    has('sales', /^Pronari Test shiti 4\.50 €$/, 'me borxh: Arben Test'),
  );
  await expectNoNote(
    'the debt of that sale is not announced a second time',
    has('money', 'Borxh i ri'),
  );

  console.log('\nPC sessions');
  await clearNotes();
  await commands['session-start'](1, 60);
  await expectNote(
    'time paid at the start is told as what it is: a session that began',
    has('sales', 'Kasjere Test nisi PC 01 · 60 min · 2.00 €'),
  );
  await expectNoNote('…and is not announced a second time', has('pcs', /nisi PC 01/));
  await commands['session-open'](2);
  await expectNote(
    'open time (nothing paid yet) is a PC message',
    has('pcs', 'Kasjere Test nisi PC 02', 'kohë e hapur'),
  );
  await commands['session-open'](3);
  await expectNote('a second open session right after', has('pcs', 'Kasjere Test nisi PC 03'));
  await commands['session-extend'](1, 30);
  await expectNote(
    'an extension says so, with the minutes and the money',
    has('sales', 'Kasjere Test zgjati PC 01 · +30 min · 1.00 €'),
  );
  await commands['session-gift'](1, 15);
  await expectNote(
    'free minutes are an alert with the reason',
    has('alerts', 'PC 01: 15 min dhuratë', 'Na vjen keq'),
  );
  await commands['session-cancel'](3);
  await expectNote(
    'a cancelled session is an alert',
    has('alerts', 'PC 03: seanca u anulua', 'Gabim në nisje'),
  );
  await commands['session-end'](1);
  await expectNote(
    'a session that staff end: who, which PC, how long',
    has('pcs', /^Kasjere Test mbylli PC 01 · /),
  );

  console.log('\nMoney, stock, accounts');
  await clearNotes();
  await commands.expense(1250);
  await expectNote(
    'an expense with its category in Albanian',
    has('money', 'Shpenzim 12.50 €', 'Pastrimi'),
  );
  await commands.refund();
  await expectNote(
    'a refund is an alert',
    has('alerts', /^Rimbursim \d+\.\d\d €$/, 'Klienti e ktheu'),
  );
  await commands.stock(10000);
  await expectNote('stock added', has('stock', 'Stoku: Ujë 0.5l +10'));
  await commands.stock(-3000);
  await expectNote('stock written off is an alert', has('alerts', 'Stoku: Ujë 0.5l -3', 'dëmtuar'));
  await commands.price(190);
  await expectNote(
    'a price change',
    has('stock', 'Produkt i ndryshuar: Coca-Cola 0.33l', 'çmimi 1.90 €'),
  );
  await commands['bad-login']();
  await expectNote(
    'a failed sign-in is an alert',
    has('alerts', 'Hyrje e dështuar: kasjere', 'fjalëkalim i gabuar'),
  );
  await commands['cash-in'](10000);
  await expectNote(
    'cash put into the drawer',
    has('money', /^Hyrje parash në arkë 100\.00 €$/, 'Kusur për arkën'),
  );
  await commands['cash-out'](5000);
  await expectNote(
    'cash taken from the drawer',
    has('money', 'Dalje parash nga arka 50.00 €', 'Në kasafortë'),
  );
  await commands['debt-pay']();
  await expectNote(
    'a debt payment names the customer',
    has('money', 'Pagesë borxhi 2.00 €', 'Arben Test'),
  );

  console.log('\nThe activity list');
  const activity = await bridge('activity', { page: 1, pageSize: 30 });
  const titles = (activity.data?.items ?? []).map((i) => i.title);
  check(
    `the audit log in words (${activity.data?.total} rows; newest: ${titles[0]})`,
    activity.ok &&
      titles.some((t) => t.startsWith('Pagesë borxhi')) &&
      titles.some((t) => t.startsWith('Shitje ')),
    () => JSON.stringify(activity).slice(0, 400),
  );
  const snapshot = await bridge('request', { path: '/live/snapshot' });
  check(
    'the day’s figures per staff member are readable',
    snapshot.ok &&
      snapshot.data.status === 200 &&
      JSON.parse(snapshot.data.body).staff.some(
        (s) => s.name === 'Kasjere Test' && s.salesCents > 0,
      ),
    () => JSON.stringify(snapshot).slice(0, 300),
  );
  const write = await fetch(`${BRIDGE}/bridge/call`, {
    method: 'POST',
    body: JSON.stringify({ method: 'request', args: { path: '/../x' } }),
  }).then((r) => r.json());
  check('the screens cannot reach outside the API', write.ok === false, () =>
    JSON.stringify(write),
  );

  console.log('\nSettings');
  await clearNotes();
  await bridge('setOptions', { categories: { money: false } });
  await commands.expense(300);
  await expectNoNote('a switched-off kind stays silent', has('money', 'Shpenzim 3.00 €'), 4000);
  await bridge('setOptions', { categories: { money: true }, lang: 'en' });
  await commands.sale();
  await expectNote('English wording', has('sales', /^Kasjere Test sold \d+\.\d\d €$/, 'profit'));
  await bridge('setOptions', { lang: 'sq' });

  console.log('\nSales worth a look');
  await clearNotes();
  await commands['discount-sale']();
  await expectNote(
    'a sale with a discount is an alert: who gave it, how much, on what',
    has(
      'alerts',
      'Pronari Test dha zbritje 1.00 €',
      /^shitja 2\.80 € · Coca-Cola 0\.33l ×2 · fitimi 2\.37 €/,
    ),
  );
  await sleep(2500);
  const discounted = (await notes()).filter((n) => /2\.80 €/.test(`${n.title} ${n.text}`));
  check('…one message for that sale, not two or three', discounted.length === 1, () =>
    show(discounted),
  );
  await clearNotes();
  await commands['loss-sale']();
  await expectNote(
    'a sale below its cost is an alert, with the loss',
    has(
      'alerts',
      'Shitje nën kosto: Pronari Test · 1.00 €',
      'Red Bull 0.25l ×1 · zbritje 1.50 € · humbje 0.55 €',
    ),
  );
  await sleep(2500);
  const lost = (await notes()).filter((n) => /1\.00 €|1\.50 €/.test(`${n.title} ${n.text}`));
  check('…again one message', lost.length === 1, () => show(lost));
  await commands['big-sale'](2);
  await expectNoNote(
    'a big sale is not announced unless asked for',
    has('alerts', /Shitje e madhe/),
  );
  const big = await options({ topics: { 'sale.big': true }, options: { 'big.cents': 300 } });
  check(
    'the owner switches "big sale" on, from 3 €',
    big.ok && big.data.topics['sale.big'] === true && big.data.options['big.cents'] === 300,
    () => JSON.stringify(big).slice(0, 300),
  );
  await commands['big-sale'](2);
  await expectNote('…and now it is', has('alerts', 'Shitje e madhe: Kasjere Test · 3.80 €'));
  const refused = await options({ options: { 'ending.minutes': 0 } });
  check(
    'a value out of range is refused',
    refused.ok === false && refused.error.code === 'bad_option',
    () => JSON.stringify(refused).slice(0, 300),
  );
  await options({ topics: { 'sale.big': false } });

  console.log('\nThe PCs themselves');
  await clearNotes();
  // Three things are set going that take a minute or two, and are looked at further down:
  // a two-minute session (a warning one minute before its end, then its time is up), a
  // reservation with its reminder a minute from now, and "no sale for a minute".
  const set = await options({
    topics: { 'sales.idle': true },
    options: {
      'ending.minutes': 1,
      'idle.minutes': 1,
      'work.from': shopClock(-120),
      'work.to': shopClock(120),
    },
  });
  check('minutes and hours are set', set.ok && set.data.options['ending.minutes'] === 1, () =>
    JSON.stringify(set).slice(0, 300),
  );
  const booking = await commands.reservation(2, 1);
  await commands['session-start'](5, 2);
  const shortAt = Date.now();
  await expectNote('the short session begins', has('sales', /^Kasjere Test nisi PC 05 · 2 min/));

  await commands['pc-on'](1);
  const first = await expectNote(
    'a PC that comes on',
    has('power', 'PC 01 u ndez', '1 nga 4 PC janë ndezur'),
  );
  await commands['pc-on'](2);
  await commands['pc-on'](3);
  const grown = await expectNote(
    'the ones right behind it join the same message',
    has('power', 'U ndezën 3 PC', 'PC 01, PC 02, PC 03 · 3 nga 4 PC janë ndezur'),
  );
  check(
    '…which takes the place of the first without ringing again',
    grown && first && grown.key === first.key && grown.update === true,
    () => JSON.stringify({ first, grown }),
  );
  const came = (await notes()).filter((n) => n.topic === 'pc.power');
  check('…so there is one message, not three', came.length === 1, () => show(came));

  await commands['pc-wake'](5);
  await expectNote(
    '"Ndiz" in the Admin: who woke which PC',
    has('power', 'Pronari Test e ndezi PC 05', 'sinjali i ndezjes u dërgua'),
  );
  await commands['pc-wake-all']();
  await expectNote(
    '"Ndiz të gjitha": how many, and why the others were left out',
    has(
      'power',
      'Pronari Test i ndezi të gjitha PC-të (1)',
      'PC 05 · 3 ishin ndezur · 2 nuk mund të ndizen nga rrjeti',
    ),
  );
  await commands['pc-restart'](2);
  await expectNote('a restart sent from the Admin', has('power', 'Pronari Test e rinisi PC 02'));
  await commands['pc-shutdown'](3);
  await expectNote('a shut-down sent from the Admin', has('power', 'Pronari Test e fiku PC 03'));
  await expectNote(
    '…and the PC really going off, once it stays off',
    has('power', 'PC 03 u fik', '2 nga 4 PC janë ndezur'),
    20000,
  );
  await expectNoNote(
    'the restarted PC only blinked: not announced as off',
    (n) => n.topic === 'pc.power' && /PC 02/.test(n.title) && /u fik/.test(n.title),
    500,
  );

  await commands['session-start'](1, 60);
  await sleep(1500);
  await commands['pc-off'](1);
  await expectNote(
    'a PC that goes off while a customer plays on it is an alert',
    has(
      'alerts',
      'PC 01 u fik gjatë seancës',
      /^Driton · mbeten 5\d min · PC-ja nuk është më e lidhur/,
    ),
    45000,
  );
  await expectNoNote(
    '…and not also a plain "went off"',
    (n) => n.topic === 'pc.power' && /PC 01 u fik/.test(n.title),
    500,
  );

  await expectNote(
    'a session with a minute left',
    has('pcs', 'PC 05: mbeten 1 min', /^Driton · mbaron në \d\d:\d\d$/),
    Math.max(5000, shortAt + 75_000 - Date.now()),
  );
  await expectNote(
    'the reservation is announced at its reminder time',
    has('pcs', /^Rezervim pas 1 min: Driton$/, /^PC 05, PC 06 · ora \d\d:\d\d · 044 123 456$/),
    Math.max(5000, shortAt + 80_000 - Date.now()),
  );
  await expectNote(
    'no sale for a minute, inside the working hours',
    has('alerts', /^Asnjë shitje prej 1 min/, /^Shitja e fundit: ora \d\d:\d\d\.$/),
    Math.max(5000, shortAt + 110_000 - Date.now()),
  );
  await expectNote(
    'time that runs out',
    has('pcs', 'PC 05: koha mbaroi', /^Driton · 2 min/),
    Math.max(5000, shortAt + 150_000 - Date.now()),
  );
  await options({
    topics: { 'sales.idle': false },
    options: { 'ending.minutes': 5, 'idle.minutes': 120 },
  });
  await commands['reservation-cancel'](booking.id);

  await clearNotes();
  await options({ topics: { 'pc.power': false } });
  await commands['pc-on'](3);
  await expectNoNote(
    'with its switch off, a PC coming on is not told',
    (n) => n.topic === 'pc.power',
    6000,
  );
  await options({ topics: { 'pc.power': true } });
  await commands['pc-off'](3);
  await expectNote(
    '…and with it on again, its going off is',
    has('power', 'PC 03 u fik', '1 nga 4 PC janë ndezur'),
    20000,
  );
  // Closing time. (PC 02 still has its open session from above: it is paid first, or the PC
  // going off would be the alert seen before.)
  await commands['session-end'](2);
  await commands['session-end'](1);
  allPcsOff();
  await expectNote(
    'closing time: the last one going off joins the message before it',
    has('power', 'U fikën 2 PC', 'PC 02, PC 03 · 0 nga 4 PC janë ndezur'),
    20000,
  );

  console.log('\nThe day');
  await clearNotes();
  await options({ options: { 'step.cents': 1000 } });
  await bridge('refresh');
  await sleep(1500);
  await commands['big-sale'](40);
  await expectNote(
    'the turnover passing the next mark',
    has('day', /^Qarkullimi i ditës kaloi \d+0\.00 €$/, /^Sot \d+\.\d\d € · \d+ shitje · fitimi /),
  );
  await options({ options: { 'step.cents': 100000000 } });
  await commands['debt-due-today']();
  await options({ options: { 'debts.at': shopClock() } });
  await expectNote(
    'the debts that are due today, at the hour the owner chose',
    has('day', /^Sot skado(n një borxh|jnë \d+ borxhe) · \d+\.\d\d €$/, 'Arben Test'),
  );
  await options({ options: { 'summary.at': shopClock() } });
  await expectNote(
    'the summary of the day',
    has('day', /^Dita sot: \d+\.\d\d € · \d+ shitje$/, /^fitimi .* · .*Kasjere Test \d+\.\d\d €/),
  );
  await clearNotes();
  await options({
    options: { 'quiet.on': true, 'quiet.from': clock(-60), 'quiet.to': clock(60) },
  });
  await commands.sale();
  const hushed = await expectNote(
    'a sale during the quiet hours is still shown',
    has('sales', /shiti/),
  );
  check('…but without sound', hushed?.silent === true, () => JSON.stringify(hushed));
  await commands.refund();
  const hushedAlert = await expectNote(
    'an alert during the quiet hours',
    has('alerts', /^Rimbursim/),
  );
  check('…is silent too', hushedAlert?.silent === true, () => JSON.stringify(hushedAlert));
  await options({ options: { 'quiet.alerts': true } });
  await commands['bad-login']();
  const loud = await expectNote(
    'unless the owner wants alerts to ring',
    has('alerts', /^Hyrje e dështuar/),
  );
  check('…then it rings', loud?.silent === false, () => JSON.stringify(loud));
  await options({ options: { 'quiet.on': false, 'quiet.alerts': false } });
  await commands.sale();
  await sleep(1500);
  const ringing = (await notes()).filter(has('sales', /shiti/));
  check(
    'after the quiet hours sales ring again',
    ringing.length === 2 && ringing.some((n) => n.silent === false),
    () => JSON.stringify(ringing),
  );

  console.log('\nA gap (the phone was off)');
  await stopHost();
  await commands.sale(2);
  await commands.expense(700);
  await commands['session-open'](4);
  await startHost();
  await waitState(
    'the link comes back after a restart, still signed in',
    (s) => s.connection === 'online' && s.signedIn,
  );
  await expectNote('the sales made meanwhile are announced', has('sales', /^Kasjere Test shiti/));
  const missed = (await notes()).filter(has('sales', /^Kasjere Test shiti/));
  check('…each one once (2)', missed.length === 2, () => `got ${missed.length}`);
  await expectNote('the expense made meanwhile', has('money', 'Shpenzim 7.00 €'));
  await expectNote('the session opened meanwhile', has('pcs', 'Kasjere Test nisi PC 04'));
  await stopHost();
  await startHost();
  await waitState('a second restart', (s) => s.connection === 'online');
  await expectNoNote('nothing is announced twice', () => true, 3500);

  console.log('\nA long gap (more happened than is worth listing one by one)');
  await stopHost();
  const before = await call('GET', '/live/snapshot', undefined, await as('owner'));
  await commands.sale(12);
  for (let i = 1; i <= 10; i++) await commands.expense(100 + i);
  const after = await call('GET', '/live/snapshot', undefined, await as('owner'));
  const each = (after.totals.turnoverCents - before.totals.turnoverCents) / 12;
  await startHost();
  await waitState('online again', (s) => s.connection === 'online');
  const euros = (cents) => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')} €`;
  await expectNote(
    'the older sales are one line with their sum',
    has('sales', `Edhe 7 shitje ndërkohë · ${euros(each * 7)}`),
  );
  await sleep(1500);
  const single = (await notes()).filter(has('sales', /^Kasjere Test shiti/));
  check('the newest five sales one by one', single.length === 5, () => `got ${single.length}`);
  await expectNote(
    'the older changes are one line',
    has('connection', 'Edhe 5 ndryshime ndërkohë'),
  );
  const spent = (await notes()).filter(has('money', /^Shpenzim 1\.\d\d €$/));
  check(
    'the newest five changes one by one',
    spent.length === 5 && spent.some((n) => n.title === 'Shpenzim 1.10 €'),
    () => show(spent),
  );

  console.log('\nThe server goes away and comes back');
  await clearNotes();
  network('refuse');
  await waitState('the engine sees the link end', (s) => s.connection === 'offline', 8000);
  await commands.sale();
  await commands.expense(900);
  await expectNote(
    'after a while the owner is told',
    has('connection', 'Pa lidhje me serverin'),
    9000,
  );
  network('open');
  const backAt = Date.now();
  await waitState(
    'it comes back by itself (no wake-up, no app opened)',
    (s) => s.connection === 'online',
    50000,
  );
  console.log(`       (${Math.round((Date.now() - backAt) / 1000)} s after the server returned)`);
  await expectNote('the sale made meanwhile', has('sales', /^Kasjere Test shiti/));
  await expectNote('the expense made meanwhile', has('money', 'Shpenzim 9.00 €'));
  await expectNoNote(
    'the "no connection" message is taken back',
    has('connection', 'Pa lidhje me serverin'),
    500,
  );

  console.log('\nThe link dies without a word');
  await clearNotes();
  network('silent');
  await commands.sale();
  await expectNoNote('nothing can arrive', has('sales', /shiti/), 1500);
  await bridge('refresh'); // what the phone's alarm does every few minutes
  await waitState('a wake-up finds the dead link', (s) => s.connection === 'offline', 25000);
  network('open');
  await bridge('refresh');
  await waitState('and the next one brings it back', (s) => s.connection === 'online', 30000);
  await expectNote('the sale that could not arrive', has('sales', /^Kasjere Test shiti/));
  const twice = (await notes()).filter(has('sales', /^Kasjere Test shiti/));
  check('…once', twice.length === 1, () => `got ${twice.length}`);

  console.log('\nThe sign-in ends');
  const owner = await as('owner');
  const users = await call('GET', '/users', undefined, owner);
  const phoneUser = (users.items ?? users).find((u) => u.username === 'telefon');
  await call('PATCH', `/users/${phoneUser.id}`, { isActive: false }, owner);
  await bridge('refresh');
  await waitState(
    'the engine notices and stops',
    (s) => s.connection === 'unauthorized' && !s.signedIn,
    20000,
  );
  await expectNote('the owner is told to sign in again', has('connection', 'Hyni përsëri'));
  await call('PATCH', `/users/${phoneUser.id}`, { isActive: true }, owner);
  const again = await bridge('signIn', {
    server: VIA_RELAY,
    username: 'telefon',
    email: 'telefon@test.local',
    password: 'Owner12345',
  });
  check('signing in again works', again.ok, () => JSON.stringify(again).slice(0, 300));
  await waitState('…and the link is back', (s) => s.connection === 'online');
  const out = await bridge('signOut');
  check('sign-out', out.ok && out.data.signedIn === false, () => JSON.stringify(out).slice(0, 300));
} catch (e) {
  fail('the check itself', e.stack ?? String(e));
} finally {
  allPcsOff();
  await endOpenSessions().catch(() => undefined);
  await cancelReservations().catch(() => undefined);
  await stopHost();
  relay.server?.close();
  for (const p of relay.pairs) {
    p.client.destroy();
    p.upstream.destroy();
  }
}

console.log(failures === 0 ? '\nAll engine checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
