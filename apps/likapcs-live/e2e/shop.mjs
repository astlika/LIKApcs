// A small "shop" for tests: does real things on a LIKApcs server through its public API, so the
// live app has something to report. Test data only — never point it at a real shop.
//
//   node shop.mjs <command> [args]      (after e2e/seed.mjs and e2e/users.mjs of the repo root)
//
// Commands: setup · sale [n] · credit-sale · refund · session-start <pc> [min] · session-open <pc> ·
// session-extend <pc> <min> · session-gift <pc> <min> · session-end <pc> · session-cancel <pc> ·
// expense [cents] · cash-in [cents] · cash-out [cents] · stock [delta] · price [cents] · bad-login · debt-pay ·
// discount-sale · loss-sale · big-sale · debt-due-today · reservation [minutes] ·
// pc-on <pc> · pc-off <pc> · pc-wake <pc> · pc-wake-all · pc-shutdown <pc> · pc-restart <pc> ·
// day (a little of everything, with pauses)
//
// The pc-* commands play a gaming PC: `pc-on` holds a client connection open for as long as this
// process lives (the checks import the commands and keep running; from a shell use `pcs`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.env.LIKAPCS_URL ?? 'http://127.0.0.1:4700/api/v1';
const PASSWORD = process.env.LIKAPCS_PASSWORD ?? 'Owner12345';

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return json;
}

const tokens = {};
async function as(username) {
  tokens[username] ??= (await call('POST', '/auth/login', { username, password: PASSWORD })).token;
  return tokens[username];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const requestId = () => `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

async function products(token) {
  const r = await call('GET', '/products?pageSize=100', undefined, token);
  return r.items ?? r;
}
async function station(number, token) {
  const list = await call('GET', '/stations', undefined, token);
  const s = list.find((x) => x.number === Number(number));
  if (!s) throw new Error(`no PC ${number}`);
  return s;
}

// ─── A pretend gaming PC ──────────────────────────────────────────────────────────────────
// Registers like the real client program, is approved for its station, and then holds the client
// WebSocket open: for the server that PC is switched on. Closing the socket is the PC going off.
const WS_BASE = BASE.replace(/^http/, 'ws').replace(/\/api\/v1$/, '');
const PC_FILE = path.join(
  os.tmpdir(),
  `likalive-pcs-${Buffer.from(BASE).toString('hex').slice(0, 24)}.json`,
);
/** PC number → { socket, beat } of the PCs that are "on" in this process. */
const running = new Map();
const mac = (n) => `08:BF:B8:00:00:${String(Number(n)).padStart(2, '0')}`;

function savedPcs() {
  try {
    return JSON.parse(fs.readFileSync(PC_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/** The device token of PC `n`: paired once, then kept in a file for the next run. */
async function pcToken(n) {
  const t = await as('owner');
  const s = await station(n, t);
  const saved = savedPcs();
  const known = saved[s.id];
  if (known && s.device?.id === known.deviceId && s.device.status === 'approved') return known;
  // A device from an earlier run whose token is gone: it gives way to a new one.
  if (s.device) await call('POST', `/devices/${s.device.id}/revoke`, {}, t).catch(() => undefined);
  const machineId = `likalive-test-${s.number}-${Math.random().toString(36).slice(2, 10)}`;
  const registrationSecret = `${requestId()}-${requestId()}-${requestId()}`;
  const { version } = await call('GET', '/system/health');
  const reg = await call('POST', '/client/register', {
    machineId,
    hostname: `PC-${String(s.number).padStart(2, '0')}`,
    osInfo: 'Windows 11 (test)',
    appVersion: version,
    registrationSecret,
  });
  await call('POST', `/devices/${reg.registrationId}/approve`, { stationId: s.id }, t);
  const poll = await call(
    'GET',
    `/client/registration/${reg.registrationId}?secret=${registrationSecret}`,
  );
  if (!poll.deviceToken) throw new Error(`no device token for ${s.code}: ${JSON.stringify(poll)}`);
  const entry = { deviceId: reg.registrationId, token: poll.deviceToken, machineId, version };
  fs.writeFileSync(PC_FILE, JSON.stringify({ ...saved, [s.id]: entry }));
  return entry;
}

/** Switches the pretend PC on: connects, says hello, answers the server's commands. */
async function pcOn(n) {
  const number = Number(n);
  if (running.has(number)) return;
  const { token, machineId, version } = await pcToken(number);
  const socket = new WebSocket(`${WS_BASE}/ws/client`);
  const pc = { socket, beat: null };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PC ${number}: no welcome`)), 8000);
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          type: 'client.hello',
          token,
          appVersion: version,
          protocolVersion: 1,
          machineId,
          hardware: {
            cpu: 'Test CPU',
            gpus: [],
            network: [
              { name: 'Ethernet', mac: mac(number), ipv4: null, up: true, wakeOnMagicPacket: true },
            ],
            fastStartup: false,
          },
        }),
      ),
    );
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === 'server.welcome') {
        clearTimeout(timer);
        resolve();
      } else if (message.type === 'server.command') {
        // The real client confirms a command before it acts on it.
        socket.send(JSON.stringify({ type: 'client.ack', commandId: message.commandId, ok: true }));
        if (message.command === 'power.shutdown') setTimeout(() => pcOff(number), 300);
        if (message.command === 'power.restart') {
          setTimeout(() => pcOff(number), 300);
          setTimeout(() => pcOn(number).catch(() => undefined), 4000);
        }
      }
    });
    socket.addEventListener('close', () => {
      clearTimeout(timer);
      if (running.get(number) === pc) running.delete(number);
      clearInterval(pc.beat);
      reject(new Error(`PC ${number}: connection closed`));
    });
    socket.addEventListener('error', () => undefined);
  });
  pc.beat = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'client.heartbeat', ts: new Date().toISOString() }));
  }, 8000);
  running.set(number, pc);
}

function pcOff(n) {
  const pc = running.get(Number(n));
  if (!pc) return;
  running.delete(Number(n));
  clearInterval(pc.beat);
  pc.socket.close();
}

const COSTED = 'Red Bull 0.25l';

const commands = {
  /** What the repo's seed leaves out: an hourly price, so sessions can be started (2.00 € an hour). */
  async setup() {
    const t = await as('owner');
    const rules = await call('GET', '/pricing/rules', undefined, t);
    if ((rules.items ?? rules).length === 0) {
      await call('POST', '/pricing/rules', { name: 'Standard', rateCentsPerHour: 200 }, t);
      console.log('pricing rule created');
    } else console.log('pricing rule exists');
    // One product whose cost is on record (the seeded ones have none), so that a sale can be
    // seen to lose money.
    if (!(await products(t)).some((p) => p.name === COSTED)) {
      await call(
        'POST',
        '/products',
        {
          name: COSTED,
          sellingPriceCents: 250,
          purchaseCostCents: 140,
          unitCode: 'pc',
          trackStock: false,
          priceIncludesTax: true,
        },
        t,
      );
      console.log('product with a cost created');
    }
  },

  /** Two colas and a bag of crisps, paid in cash, sold by the cashier. */
  async sale(n = 1) {
    const t = await as('kasjere');
    const list = await products(t);
    const cola = list.find((p) => p.name.startsWith('Coca'));
    const chips = list.find((p) => p.name.startsWith('Çips'));
    for (let i = 0; i < Number(n); i++) {
      const total = cola.sellingPriceCents * 2 + chips.sellingPriceCents;
      const sale = await call(
        'POST',
        '/sales',
        {
          items: [
            { productId: cola.id, quantityMilli: 2000 },
            { productId: chips.id, quantityMilli: 1000 },
          ],
          payments: [{ method: 'cash', amountCents: total }],
          clientRequestId: requestId(),
        },
        t,
      );
      console.log('sale', sale.receiptNo, sale.totalCents);
    }
  },

  /** A sandwich on the customer's tab, sold by the owner. */
  async 'credit-sale'() {
    const t = await as('owner');
    const list = await products(t);
    const item = list.find((p) => p.name.startsWith('Sandui'));
    const customers = await call('GET', '/customers?pageSize=5', undefined, t);
    const customer = (customers.items ?? customers)[0];
    const sale = await call(
      'POST',
      '/sales',
      {
        items: [{ productId: item.id, quantityMilli: 1000 }],
        customerId: customer.id,
        payments: [{ method: 'credit', amountCents: item.sellingPriceCents }],
        clientRequestId: requestId(),
      },
      t,
    );
    console.log('credit sale', sale.receiptNo, sale.totalCents, customer.name);
  },

  /** Gives back the first line of the newest sale. */
  async refund() {
    const t = await as('owner');
    const list = await call('GET', '/sales?pageSize=5&status=completed', undefined, t);
    const sale = await call('GET', `/sales/${(list.items ?? list)[0].id}`, undefined, t);
    const line = sale.items[0];
    const r = await call(
      'POST',
      `/sales/${sale.id}/refund`,
      {
        items: [{ saleItemId: line.id, quantityMilli: Math.min(1000, line.quantityMilli) }],
        reason: 'Klienti e ktheu',
        restock: true,
        method: 'cash',
      },
      t,
    );
    console.log('refund of', sale.receiptNo, r.refundedCents ?? '');
  },

  async 'session-start'(pc = 1, minutes = 60) {
    const t = await as('kasjere');
    const s = await station(pc, t);
    const quote = await call(
      'POST',
      '/sessions/quote',
      { stationId: s.id, billingMode: 'prepaid', minutes: Number(minutes) },
      t,
    );
    const r = await call(
      'POST',
      '/sessions',
      {
        stationId: s.id,
        billingMode: 'prepaid',
        minutes: Number(minutes),
        paymentMethod: 'cash',
        payments: quote.priceCents > 0 ? [{ method: 'cash', amountCents: quote.priceCents }] : [],
        customerName: 'Driton',
        clientRequestId: requestId(),
      },
      t,
    );
    console.log('session started on', s.code, quote.priceCents, (r.session ?? r).id);
  },

  async 'session-open'(pc = 2) {
    const t = await as('kasjere');
    const s = await station(pc, t);
    const r = await call(
      'POST',
      '/sessions',
      { stationId: s.id, billingMode: 'postpaid', clientRequestId: requestId() },
      t,
    );
    console.log('open session on', s.code, (r.session ?? r).id);
  },

  async 'session-extend'(pc = 1, minutes = 30) {
    const t = await as('kasjere');
    const s = await station(pc, t);
    const id = s.activeSession?.id;
    if (!id) throw new Error(`${s.code} has no session`);
    const quote = await call(
      'POST',
      '/sessions/quote',
      { stationId: s.id, billingMode: 'prepaid', minutes: Number(minutes) },
      t,
    );
    await call(
      'POST',
      `/sessions/${id}/extend`,
      {
        minutes: Number(minutes),
        paymentMethod: 'cash',
        payments: quote.priceCents > 0 ? [{ method: 'cash', amountCents: quote.priceCents }] : [],
        clientRequestId: requestId(),
      },
      t,
    );
    console.log('extended', s.code, minutes);
  },

  async 'session-gift'(pc = 1, minutes = 15) {
    const t = await as('owner');
    const s = await station(pc, t);
    const id = s.activeSession?.id;
    if (!id) throw new Error(`${s.code} has no session`);
    await call(
      'POST',
      `/sessions/${id}/gift`,
      { minutes: Number(minutes), reason: 'Na vjen keq për pritjen' },
      t,
    );
    console.log('gift', s.code, minutes);
  },

  async 'session-end'(pc = 1) {
    const t = await as('kasjere');
    const s = await station(pc, t);
    const id = s.activeSession?.id;
    if (!id) throw new Error(`${s.code} has no session`);
    await call('POST', `/sessions/${id}/end`, { paymentMethod: 'cash' }, t);
    console.log('ended', s.code);
  },

  async 'session-cancel'(pc = 1) {
    const t = await as('owner');
    const s = await station(pc, t);
    const id = s.activeSession?.id;
    if (!id) throw new Error(`${s.code} has no session`);
    await call('POST', `/sessions/${id}/cancel`, { reason: 'Gabim në nisje' }, t);
    console.log('cancelled', s.code);
  },

  async expense(cents = 1250) {
    const t = await as('owner');
    const cats = await call('GET', '/expenses/categories', undefined, t);
    const code = (cats.items ?? cats)[0]?.code ?? 'other';
    await call(
      'POST',
      '/expenses',
      {
        expenseDate: new Date().toLocaleDateString('sv-SE'),
        categoryCode: code,
        amountCents: Number(cents),
        paymentMethod: 'cash',
        description: 'Kafe për lokalin',
        fromDrawer: true,
      },
      t,
    );
    console.log('expense', cents, code);
  },

  async 'cash-in'(cents = 10000) {
    const t = await as('owner');
    await call(
      'POST',
      '/cash/movements',
      { type: 'deposit', amountCents: Number(cents), reason: 'Kusur për arkën' },
      t,
    );
    console.log('cash in', cents);
  },

  async 'cash-out'(cents = 5000) {
    const t = await as('owner');
    await call(
      'POST',
      '/cash/movements',
      { type: 'withdrawal', amountCents: Number(cents), reason: 'Në kasafortë' },
      t,
    );
    console.log('cash out', cents);
  },

  async stock(delta = -3000) {
    const t = await as('owner');
    const list = await products(t);
    const p = list.find((x) => x.name.startsWith('Ujë'));
    await call(
      'POST',
      `/products/${p.id}/stock`,
      {
        type: Number(delta) < 0 ? 'damaged' : 'adjustment',
        quantityMilliDelta: Number(delta),
        reason: 'U thyen shishet',
      },
      t,
    );
    console.log('stock', p.name, delta);
  },

  async price(cents = 180) {
    const t = await as('owner');
    const list = await products(t);
    const p = list.find((x) => x.name.startsWith('Coca'));
    await call('PATCH', `/products/${p.id}`, { sellingPriceCents: Number(cents) }, t);
    console.log('price', p.name, cents);
  },

  async 'bad-login'() {
    const res = await fetch(BASE + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'kasjere', password: 'gabim-fare' }),
    });
    console.log('bad login ->', res.status);
  },

  async 'debt-pay'() {
    const t = await as('owner');
    const debts = await call('GET', '/debts?pageSize=5', undefined, t);
    const debt = (debts.items ?? debts).find((d) => (d.remainingCents ?? d.amountCents) > 0);
    if (!debt) throw new Error('no open debt');
    const amount = Math.min(200, debt.remainingCents ?? debt.amountCents);
    await call('POST', `/debts/${debt.id}/pay`, { amountCents: amount, method: 'cash' }, t);
    console.log('debt paid', amount);
  },

  /** Two colas with one euro off the total, sold by the cashier. */
  async 'discount-sale'() {
    const t = await as('owner');
    const list = await products(t);
    const cola = list.find((p) => p.name.startsWith('Coca'));
    const total = cola.sellingPriceCents * 2 - 100;
    const sale = await call(
      'POST',
      '/sales',
      {
        items: [{ productId: cola.id, quantityMilli: 2000 }],
        discountCents: 100,
        payments: [{ method: 'cash', amountCents: total }],
        clientRequestId: requestId(),
      },
      t,
    );
    console.log('sale with a discount', sale.receiptNo, sale.totalCents);
  },

  /** A can that cost 1.40 € let go for 1.00 €: sold at a loss. */
  async 'loss-sale'() {
    const t = await as('owner');
    const list = await products(t);
    const item = list.find((p) => p.name === COSTED);
    const sale = await call(
      'POST',
      '/sales',
      {
        items: [{ productId: item.id, quantityMilli: 1000 }],
        discountCents: item.sellingPriceCents - 100,
        payments: [{ method: 'cash', amountCents: 100 }],
        clientRequestId: requestId(),
      },
      t,
    );
    console.log('sale below cost', sale.receiptNo, sale.totalCents);
  },

  /** Forty colas at once. */
  async 'big-sale'(quantity = 40) {
    const t = await as('kasjere');
    const list = await products(t);
    const cola = list.find((p) => p.name.startsWith('Coca'));
    const total = cola.sellingPriceCents * Number(quantity);
    const sale = await call(
      'POST',
      '/sales',
      {
        items: [{ productId: cola.id, quantityMilli: Number(quantity) * 1000 }],
        payments: [{ method: 'cash', amountCents: total }],
        clientRequestId: requestId(),
      },
      t,
    );
    console.log('big sale', sale.receiptNo, sale.totalCents);
  },

  /** A sale on the customer's tab that has to be paid back today. */
  async 'debt-due-today'() {
    const t = await as('owner');
    const list = await products(t);
    const item = list.find((p) => p.name.startsWith('Sandui'));
    const customers = await call('GET', '/customers?pageSize=5', undefined, t);
    const customer = (customers.items ?? customers)[0];
    const sale = await call(
      'POST',
      '/sales',
      {
        items: [{ productId: item.id, quantityMilli: 1000 }],
        customerId: customer.id,
        payments: [
          {
            method: 'credit',
            amountCents: item.sellingPriceCents,
            dueDate: new Date().toLocaleDateString('sv-SE'),
          },
        ],
        clientRequestId: requestId(),
      },
      t,
    );
    console.log('debt due today', sale.receiptNo, sale.totalCents, customer.name);
  },

  /** A reservation of PC 5 and PC 6 that starts in `minutes`, with its reminder `remind` minutes before. */
  async reservation(minutes = 20, remind = 15) {
    const t = await as('owner');
    const a = await station(5, t);
    const b = await station(6, t);
    const r = await call(
      'POST',
      '/reservations',
      {
        stationIds: [a.id, b.id],
        startsAt: new Date(Date.now() + Number(minutes) * 60_000).toISOString(),
        remindMinutes: Number(remind),
        customerName: 'Driton',
        phone: '044 123 456',
      },
      t,
    );
    console.log('reservation', r.id, r.startsAt);
    return r;
  },

  async 'reservation-cancel'(id) {
    await call('POST', `/reservations/${id}/cancel`, {}, await as('owner'));
    console.log('reservation cancelled', id);
  },

  /**
   * Makes sure the server knows these PCs as real ones: each gets a client paired, which is on
   * for a moment so its network card is on record (without one the server refuses to wake it).
   */
  async 'pc-pair'(...numbers) {
    for (const n of numbers.length ? numbers : [1, 2, 3, 5]) {
      await pcOn(n);
      pcOff(n);
    }
    await sleep(300);
    console.log('PCs paired', numbers.join(' '));
  },

  /** The pretend PC is switched on (it connects to the server like the real client program). */
  async 'pc-on'(pc = 1) {
    await pcOn(pc);
    console.log('PC on', pc);
  },

  /** …and off: its connection ends. */
  async 'pc-off'(pc = 1) {
    pcOff(pc);
    console.log('PC off', pc);
  },

  /** "Ndiz" in the Admin: the wake signal for one PC that is off. */
  async 'pc-wake'(pc = 1) {
    const t = await as('owner');
    const s = await station(pc, t);
    await call('POST', `/stations/${s.id}/wake`, {}, t);
    console.log('wake sent to', s.code);
  },

  /** "Ndiz të gjitha". */
  async 'pc-wake-all'() {
    const r = await call('POST', '/stations/wake-all', {}, await as('owner'));
    console.log('wake sent to', r.sent.length, 'PCs; skipped', r.skipped.length);
  },

  /** "Fik PC-në" in the Admin. */
  async 'pc-shutdown'(pc = 1) {
    const t = await as('owner');
    const s = await station(pc, t);
    const r = await call('POST', `/stations/${s.id}/command`, { command: 'power.shutdown' }, t);
    console.log('shutdown', s.code, r.ok);
  },

  /** "Rinis PC-në". */
  async 'pc-restart'(pc = 1) {
    const t = await as('owner');
    const s = await station(pc, t);
    const r = await call('POST', `/stations/${s.id}/command`, { command: 'power.restart' }, t);
    console.log('restart', s.code, r.ok);
  },

  /** From a shell: keeps the listed pretend PCs on until Ctrl+C, e.g. `node shop.mjs pcs 1 2 3`. */
  async pcs(...numbers) {
    for (const n of numbers.length ? numbers : [1, 2, 3]) await commands['pc-on'](n);
    console.log('PCs are on; Ctrl+C switches them off');
    await new Promise(() => undefined);
  },

  /** A little of everything, a few seconds apart. */
  async day(pause = 2500) {
    const steps = [
      ['sale'],
      ['session-start', 1, 60],
      ['credit-sale'],
      ['session-open', 2],
      ['session-open', 3],
      ['expense', 1250],
      ['session-extend', 1, 30],
      ['refund'],
      ['session-gift', 1, 15],
      ['stock', 10000],
      ['stock', -3000],
      ['price', 180],
      ['bad-login'],
      ['cash-in', 10000],
      ['cash-out', 5000],
      ['debt-pay'],
      ['session-end', 2],
      ['session-cancel', 3],
      ['session-end', 1],
      ['sale', 2],
    ];
    for (const [name, ...args] of steps) {
      try {
        await commands[name](...args);
      } catch (e) {
        console.log(`${name} FAILED: ${e.message}`);
      }
      await sleep(Number(pause));
    }
  },
};

/** Every pretend PC of this process goes off (the checks call it when they finish). */
function allPcsOff() {
  for (const n of [...running.keys()]) pcOff(n);
}

export { commands, call, as, sleep, station, allPcsOff };

// Run as a command line tool only when started directly (the checks import the commands).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [name, ...args] = process.argv.slice(2);
  if (!commands[name]) {
    console.error(`unknown command "${name ?? ''}". One of: ${Object.keys(commands).join(', ')}`);
    process.exit(2);
  }
  try {
    await commands[name](...args);
  } catch (e) {
    console.error(`${name} failed: ${e.message}`);
    process.exit(1);
  }
}
