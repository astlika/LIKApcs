// Seeds a fresh LIKApcs database through the public API (test data only).
const BASE = process.env.LIKAPCS_URL ?? 'http://127.0.0.1:4700/api/v1';
const OWNER = { username: 'owner', password: 'Owner12345', fullName: 'Pronari Test' };

async function call(method, path, body, token) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const status = await call('GET', '/system/setup-status');
let token;
if (status?.needsSetup ?? status?.setupRequired ?? true) {
  const r = await call('POST', '/system/setup', { businessName: 'Test Arena', language: 'sq', owner: OWNER });
  token = r.token;
  console.log('setup ok');
} else {
  token = (await call('POST', '/auth/login', { username: OWNER.username, password: OWNER.password })).token;
  console.log('already set up');
}

for (let n = 1; n <= 6; n++) {
  await call('POST', '/stations', { number: n, name: `PC ${n}`, zone: n <= 3 ? 'Salla A' : 'Salla B', isEnabled: true }, token);
}
console.log('stations ok');

const products = [
  { name: 'Kafe espresso', sellingPriceCents: 240, categoryId: null, unitCode: 'pc' },
  { name: 'Kafe me qumësht', sellingPriceCents: 330, categoryId: null, unitCode: 'pc' },
  { name: 'Ujë 0.5l', sellingPriceCents: 100, categoryId: null, unitCode: 'pc' },
  { name: 'Coca-Cola 0.33l', sellingPriceCents: 150, categoryId: null, unitCode: 'pc' },
  { name: 'Çips', sellingPriceCents: 200, categoryId: null, unitCode: 'pc' },
  { name: 'Sanduiç', sellingPriceCents: 450, categoryId: null, unitCode: 'pc' },
];
for (const p of products) {
  await call('POST', '/products', { ...p, trackStock: false, minStockMilli: 0, isActive: true, priceIncludesTax: true }, token);
}
console.log('products ok');

const customer = await call('POST', '/customers', { name: 'Arben Test', phone: '+38344111222', creditLimitCents: 50000, status: 'active', discountBp: 0 }, token);
console.log('customer ok', customer?.id ?? '');

await call('POST', '/cash/shifts/open', { openingCents: 10000 }, token);
console.log('cash shift open');

console.log(JSON.stringify({ token }));
