const BASE = 'http://127.0.0.1:4700/api/v1';
const j = (r) => r.json();
const login = await fetch(BASE + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'Owner12345' }) }).then(j);
const token = login.token;
const make = async (body) => {
  const r = await fetch(BASE + '/users', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const t = await r.text();
  console.log(body.username, r.status, t.slice(0, 160));
};
await make({ username: 'telefon', fullName: 'Telefoni Test', password: 'Owner12345', email: 'telefon@test.local', roles: ['owner'], mustChangePassword: false });
await make({ username: 'kasjere', fullName: 'Kasjere Test', password: 'Owner12345', email: 'kasjere@test.local', roles: ['cashier'], mustChangePassword: false });
