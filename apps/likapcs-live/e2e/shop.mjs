// A small "shop" for tests: does real things on a LIKApcs server through its public API, so the
// live app has something to report. Test data only — never point it at a real shop.
//
//   node shop.mjs <command> [args]      (after e2e/seed.mjs and e2e/users.mjs of the repo root)
//
// Commands: setup · sale [n] · credit-sale · refund · session-start <pc> [min] · session-open <pc> ·
// session-extend <pc> <min> · session-gift <pc> <min> · session-end <pc> · session-cancel <pc> ·
// expense [cents] · cash-in [cents] · cash-out [cents] · stock [delta] · price [cents] · bad-login · debt-pay ·
// day (a little of everything, with pauses)
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

const commands = {
  /** What the repo's seed leaves out: an hourly price, so sessions can be started (2.00 € an hour). */
  async setup() {
    const t = await as('owner');
    const rules = await call('GET', '/pricing/rules', undefined, t);
    if ((rules.items ?? rules).length === 0) {
      await call('POST', '/pricing/rules', { name: 'Standard', rateCentsPerHour: 200 }, t);
      console.log('pricing rule created');
    } else console.log('pricing rule exists');
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

export { commands, call, as, sleep };

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
