/*
 * likalivepcs — the screens (sign-in, Live, Activity, Settings).
 *
 * The page never talks to the LIKApcs server itself and never holds the sign-in: everything goes
 * through the bridge (`call(method, args)`), which the Android app provides as `window.LikaLive`.
 * Opened in a desktop browser from the development host, the same calls go over HTTP instead.
 * No framework: on a small phone a few hundred DOM nodes built by hand start faster than any.
 */
(function () {
  'use strict';

  // ─── Bridge ────────────────────────────────────────────────────────────────────────────
  const native = window.LikaLive || null;
  const pending = new Map();
  let seq = 0;
  const handlers = {};

  function on(type, fn) {
    (handlers[type] = handlers[type] || []).push(fn);
  }
  function emit(type, data) {
    (handlers[type] || []).forEach((fn) => {
      try {
        fn(data);
      } catch (e) {
        console.error(e);
      }
    });
  }

  // Called by the Android app.
  window.__lika = {
    resolve(id, json) {
      const done = pending.get(id);
      if (!done) return;
      pending.delete(id);
      let result;
      try {
        result = JSON.parse(json);
      } catch (e) {
        result = { ok: false, error: { code: 'internal', message: String(e) } };
      }
      done(result);
    },
    event(type, json) {
      let data = null;
      try {
        data = json ? JSON.parse(json) : null;
      } catch {
        /* no payload */
      }
      emit(type, data);
    },
  };

  function call(method, args) {
    if (native) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        native.call(id, method, JSON.stringify(args || {}));
      });
    }
    return fetch('/bridge/call', {
      method: 'POST',
      body: JSON.stringify({ method, args: args || {} }),
    })
      .then((r) => r.json())
      .catch((e) => ({ ok: false, error: { code: 'internal', message: String(e) } }));
  }
  // For the checks that drive the app from outside (e2e/phone-check.mjs).
  window.__lika.call = call;

  if (!native && window.EventSource) {
    const source = new EventSource('/bridge/events');
    ['state', 'changed', 'note'].forEach((type) => {
      source.addEventListener(type, (e) => {
        let data = null;
        try {
          data = JSON.parse(e.data);
        } catch {
          /* ignore */
        }
        emit(type, data);
      });
    });
  }

  // ─── Words ─────────────────────────────────────────────────────────────────────────────
  // Albanian is the source text; English is looked up by it.
  const EN = {
    'Shitjet dhe çdo ndryshim në lokal, drejtpërdrejt në telefon.':
      'Sales and every change in the shop, live on your phone.',
    'Adresa e serverit': 'Server address',
    'Gjej serverin në Wi-Fi': 'Find the server on Wi-Fi',
    'Kompjuteri kryesor i LIKApcs. Adresën e gjeni te Admin › Kopjet rezervë › Serveri dhe rrjeti.':
      'The main LIKApcs computer. Its address is under Admin › Backups › Server and network.',
    'Po kërkoj në Wi-Fi…': 'Searching the Wi-Fi…',
    'Nuk u gjet asnjë server në këtë Wi-Fi. Shkruani adresën me dorë.':
      'No server found on this Wi-Fi. Type the address by hand.',
    'Emri i përdoruesit': 'Username',
    'E-maili': 'E-mail',
    Fjalëkalimi: 'Password',
    'Shfaq fjalëkalimin': 'Show the password',
    Hyr: 'Sign in',
    'Po hyj…': 'Signing in…',
    'Llogaria duhet të jetë e pronarit ose e administratorit dhe të ketë e-mail të ruajtur te Admin › Punonjësit.':
      'The account must be the owner’s or an administrator’s and have an e-mail saved under Admin › Employees.',
    'Kyçja ka skaduar ose u mbyll nga Admin. Hyni përsëri që njoftimet të vazhdojnë.':
      'The sign-in expired or was closed from the Admin. Sign in again to keep the notifications coming.',
    'Plotësoni të gjitha fushat.': 'Fill in every field.',
    'Kjo nuk duket si adresë serveri. Shembull: 192.168.1.10:4700':
      'This does not look like a server address. Example: 192.168.1.10:4700',
    'Serveri nuk u gjet në këtë adresë. Telefoni duhet të jetë në të njëjtin Wi-Fi me kompjuterin kryesor, ose Tailscale të jetë i ndezur.':
      'No server at this address. The phone must be on the same Wi-Fi as the main computer, or Tailscale must be on.',
    'Në këtë adresë nuk ka server LIKApcs.': 'There is no LIKApcs server at this address.',
    'Emri, e-maili ose fjalëkalimi nuk përputhen.':
      'The username, e-mail or password do not match.',
    'Llogaria është bllokuar përkohësisht pas shumë provave. Provoni më vonë.':
      'The account is locked for a while after too many attempts. Try later.',
    'Shumë prova njëra pas tjetrës. Prisni një minutë.':
      'Too many attempts in a row. Wait a minute.',
    'Kjo llogari nuk ka të drejtë të shohë Live tracking. Hyni me llogarinë e pronarit.':
      'This account may not see Live tracking. Sign in with the owner’s account.',
    'Serveri ktheu një gabim. Provoni përsëri.': 'The server returned an error. Try again.',
    'Diçka shkoi keq. Provoni përsëri.': 'Something went wrong. Try again.',

    Live: 'Live',
    Aktiviteti: 'Activity',
    Cilësimet: 'Settings',
    'Po lidhet…': 'Connecting…',
    'Pa lidhje': 'Offline',
    Ndalur: 'Stopped',
    'Hyni përsëri': 'Sign in again',
    'Përditësuar {time}': 'Updated {time}',

    'Pa lidhje me serverin që nga ora {time}. Shifrat më poshtë janë të fundit që u lexuan; sapo të kthehet lidhja, vijnë edhe njoftimet që munguan.':
      'No connection to the server since {time}. The figures below are the last ones read; when the link is back, the missed notifications arrive too.',
    'Që njoftimet të vijnë gjithmonë': 'So that notifications always arrive',
    'Lejo njoftimet': 'Allow notifications',
    'Telefoni ende nuk e lejon këtë aplikacion të shfaqë njoftime.':
      'The phone does not let this app show notifications yet.',
    'Njoftimet janë të fikura për këtë aplikacion. Ndizini te cilësimet e telefonit.':
      'Notifications are switched off for this app. Switch them on in the phone settings.',
    'Hap cilësimet e njoftimeve': 'Open notification settings',
    'Lejo punën në sfond': 'Allow running in the background',
    'Pa këtë, telefoni e ndal aplikacionin pas pak kohe me ekran të fikur dhe njoftimet vonohen.':
      'Without it the phone stops the app a while after the screen goes off, and notifications are late.',
    'Njoftimet janë të lejuara': 'Notifications are allowed',
    'Puna në sfond është e lejuar': 'Running in the background is allowed',
    'Te telefonat realme': 'On realme phones',
    'Cilësimet › Aplikacionet › likalivepcs › Përdorimi i baterisë: ndizni “Lejo aktivitetin në sfond” dhe “Lejo nisjen automatike”. Pastaj te aplikacionet e fundit hapni menynë mbi kartën e likalivepcs dhe zgjidhni “Kyç”, që telefoni të mos e mbyllë.':
      'Settings › Apps › likalivepcs › Battery usage: switch on “Allow background activity” and “Allow auto launch”. Then, in the recent apps, open the menu above the likalivepcs card and choose “Lock”, so the phone does not close it.',
    'Hap cilësimet e aplikacionit': 'Open the app’s settings',

    'Qarkullimi sot (me TVSH)': 'Turnover today (VAT included)',
    '{count} shitje': '{count} sales',
    'mesatarja {amount}': 'average {amount}',
    'Fitimi bruto': 'Gross profit',
    'Pa TVSH, minus kosto': 'Without VAT, minus cost',
    'Fitimi neto': 'Net profit',
    'Pas shpenzimeve': 'After expenses',
    Shpenzimet: 'Expenses',
    Humbjet: 'Losses',
    'Kthime {refunded} · stok {stock}': 'Refunds {refunded} · stock {stock}',
    'Borxh i dhënë sot': 'Sold on credit today',
    'Borxh i paguar sot': 'Debt paid today',
    Arka: 'Drawer',
    'Duhet të ketë tani': 'Should hold now',
    'Asnjë turn i hapur': 'No shift is open',
    'Disa kosto mungojnë: fitimi mund të jetë më i lartë se realiteti.':
      'Some costs are missing: the profit may be higher than it really is.',
    'Kush sa ka shitur': 'Who sold how much',
    'Ende asnjë shitje nga punonjësit sot': 'No sales by the staff yet today',
    'Në punë': 'On duty',
    'Jashtë pune': 'Off duty',
    'shitja e fundit {time}': 'last sale {time}',
    'punoi {time}': 'worked {time}',
    'Shitjet live': 'Live sales',
    'Ende asnjë shitje sot': 'No sales yet today',
    'fitimi {amount}': 'profit {amount}',
    'pa kosto': 'no cost',
    Borxh: 'Credit',
    'Produktet kryesore sot': 'Top products today',
    'Po lexoj shifrat e ditës…': 'Reading today’s figures…',
    'Shifrat e ditës nuk u lexuan. Provoni përsëri.':
      'Today’s figures could not be read. Try again.',
    'Provo përsëri': 'Try again',

    'Të gjitha': 'All',
    Shitje: 'Sales',
    Vëmendje: 'Attention',
    PC: 'PCs',
    Para: 'Money',
    Stoku: 'Stock',
    Njerëz: 'People',
    Sistemi: 'System',
    Lidhja: 'Connection',
    Sot: 'Today',
    Dje: 'Yesterday',
    'Më shumë': 'More',
    'Po lexoj…': 'Reading…',
    'Asgjë për të shfaqur këtu.': 'Nothing to show here.',
    'Ndryshime të reja': 'New changes',
    'Kjo llogari nuk ka të drejtë të lexojë regjistrin e auditimit, prandaj lista e ndryshimeve mbetet bosh. Shitjet vijnë gjithsesi.':
      'This account may not read the audit log, so the list of changes stays empty. Sales still arrive.',
    'Regjistri nuk u lexua. Provoni përsëri.': 'The log could not be read. Try again.',

    Gjendja: 'Status',
    'I lidhur': 'Connected',
    Serveri: 'Server',
    'Versioni i serverit': 'Server version',
    'Mesazhi i fundit': 'Last message',
    Llogaria: 'Account',
    'Kyçja vlen deri më': 'Signed in until',
    'Kontrollo lidhjen tani': 'Check the link now',
    'Për çfarë të njoftohem': 'What to notify me about',
    'Çdo shitje': 'Every sale',
    'Kush shiti, çfarë dhe sa.': 'Who sold, what and how much.',
    'Gjëra për t’u parë': 'Things to look at',
    'Rimbursime, anulime, ndryshime çmimi, minuta falas, hyrje të dështuara.':
      'Refunds, voids, price changes, free minutes, failed sign-ins.',
    Kompjuterët: 'The PCs',
    'Sesione, kërkesa dhe porosi nga PC-të, rezervime.':
      'Sessions, requests and orders from the PCs, reservations.',
    Paratë: 'Money',
    'Arka, shpenzimet, blerjet, borxhet.': 'The drawer, expenses, purchases, debts.',
    'Stoku dhe çmimet': 'Stock and prices',
    'Stok i ulët, rregullime stoku, produkte.': 'Low stock, stock adjustments, products.',
    Punonjësit: 'Staff',
    'Kush u kyç, llogari, klientë.': 'Who signed in, accounts, customers.',
    'Cilësime, kopje rezervë, pajisje.': 'Settings, backups, devices.',
    'Lidhja me serverin': 'The link to the server',
    'Kur lidhja mungon më shumë se 5 minuta.': 'When the link is down for more than 5 minutes.',
    'Tingulli dhe mënyra si shfaqet secili lloj ndryshohen te cilësimet e njoftimeve të telefonit.':
      'The sound and the way each kind is shown are changed in the phone’s notification settings.',
    'Dërgo një njoftim provë': 'Send a test notification',
    Gjuha: 'Language',
    'Dil nga llogaria': 'Sign out',
    'Shtypni përsëri për të dalë': 'Press again to sign out',
    'Pas daljes nuk vjen më asnjë njoftim.': 'After signing out no more notifications arrive.',
  };

  let lang = 'sq';
  function t(sq, vars) {
    let text = lang === 'en' && EN[sq] ? EN[sq] : sq;
    if (vars)
      Object.keys(vars).forEach((k) => {
        text = text.replace('{' + k + '}', vars[k]);
      });
    return text;
  }

  // ─── Formats ───────────────────────────────────────────────────────────────────────────
  function money(cents) {
    if (cents === null || cents === undefined) return '—';
    const abs = Math.abs(cents);
    return (
      (cents < 0 ? '-' : '') +
      Math.floor(abs / 100) +
      '.' +
      String(abs % 100).padStart(2, '0') +
      ' €'
    );
  }
  const qty = (milli) => String(Number((milli / 1000).toFixed(3)));
  const two = (n) => String(n).padStart(2, '0');
  function clock(value) {
    if (!value) return '—';
    const d = new Date(value);
    return isNaN(d) ? '—' : two(d.getHours()) + ':' + two(d.getMinutes());
  }
  const dayKey = (d) => d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  function dayLabel(value) {
    const d = new Date(value);
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (dayKey(d) === dayKey(now)) return t('Sot');
    if (dayKey(d) === dayKey(yesterday)) return t('Dje');
    return two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear();
  }
  function dateTime(value) {
    if (!value) return '—';
    const d = new Date(value);
    return isNaN(d)
      ? '—'
      : two(d.getDate()) + '.' + two(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + clock(d);
  }
  function worked(minutes) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h === 0 ? m + ' min' : m === 0 ? h + ' h' : h + ' h ' + m + ' min';
  }
  /** The server names PC time lines in English ("… min (prepaid)"); the bracket is dropped. */
  const timeLine = (name) =>
    name.replace(
      /\s*\((?:prepaid|extension|postpaid|pay at the end)(?:: ([^)]*))?\)\s*$/,
      (m, pkg) => (pkg ? ' (' + pkg + ')' : ''),
    );

  // ─── DOM helpers ───────────────────────────────────────────────────────────────────────
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') el.className = v;
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
        else if (k === 'value') el.value = v;
        else el.setAttribute(k, v === true ? '' : v);
      });
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach((c) => append(el, c));
    else el.appendChild(child.nodeType ? child : document.createTextNode(String(child)));
  }
  function fill(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    for (let i = 1; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  const ICONS = {
    pulse: 'M3 12h4l2.5-7 5 14 2.5-7h4',
    list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    gear: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4ZM19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.4-2.3.9a7.5 7.5 0 0 0-2.6-1.5L14 2.5h-4l-.5 2.5a7.5 7.5 0 0 0-2.6 1.5l-2.3-.9-2 3.4 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.4 2.3-.9a7.5 7.5 0 0 0 2.6 1.5l.5 2.5h4l.5-2.5a7.5 7.5 0 0 0 2.6-1.5l2.3.9 2-3.4-2-1.5Z',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    check: 'M5 12.5l4.5 4.5L19 7.5',
    alert:
      'M12 8v5M12 16.5h.01M10.3 3.9 2.5 17.5A2 2 0 0 0 4.2 20.5h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
    cart: 'M3 4h2.5l2.2 10.5h10l2-7.5H7M9.5 19.5h.01M17 19.5h.01',
    pc: 'M4 5h16v11H4zM9 20h6M12 16v4',
    coins:
      'M12 7c3.9 0 7-1.1 7-2.5S15.9 2 12 2 5 3.1 5 4.5 8.1 7 12 7ZM5 4.5v5C5 10.9 8.1 12 12 12s7-1.1 7-2.5v-5M5 9.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5M5 14.5v5c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5v-5',
    box: 'M21 8 12 3 3 8v8l9 5 9-5V8ZM3 8l9 5 9-5M12 13v8',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5c.8-3.6 3.8-5.5 7.5-5.5s6.7 1.9 7.5 5.5',
    wrench:
      'M14.5 6.5a4 4 0 0 0 5 5L21 13l-8.5 8.5a2.1 2.1 0 0 1-3-3L18 10M14.5 6.5 17 4a5 5 0 0 0-6.5 6.5L3 18l3 3 7.5-7.5',
    link: 'M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1',
    refresh:
      'M20 11a8 8 0 0 0-14.5-4L4 8.5M4 4v4.5h4.5M4 13a8 8 0 0 0 14.5 4l1.5-1.5M20 20v-4.5h-4.5',
    bell: 'M6 16.5V11a6 6 0 1 1 12 0v5.5l1.5 2h-15l1.5-2ZM10 21h4',
  };
  function icon(name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', ICONS[name] || ICONS.list);
    svg.appendChild(path);
    return svg;
  }

  // ─── State ─────────────────────────────────────────────────────────────────────────────
  const root = document.getElementById('app');
  let state = null; // the bridge's getState
  let screen = null; // 'signin' | 'main'
  let tab = 'live';
  let pendingTab = null; // a tab asked for by a tapped notification
  let snapshot = null; // LiveSnapshot
  let snapshotError = false;
  let snapshotTimer = null;
  let snapshotBusy = false;
  let knownSales = null; // sale ids already on screen: new ones flash
  const activity = {
    items: [],
    total: 0,
    page: 0,
    loading: false,
    error: null,
    filter: 'all',
    stale: false,
  };
  let activityTimer = null;
  let signOutArmed = 0;
  const ui = {}; // elements of the main screen

  const CATEGORY = {
    sales: { icon: 'cart', label: 'Shitje' },
    alerts: { icon: 'alert', label: 'Vëmendje' },
    pcs: { icon: 'pc', label: 'PC' },
    money: { icon: 'coins', label: 'Para' },
    stock: { icon: 'box', label: 'Stoku' },
    people: { icon: 'user', label: 'Njerëz' },
    system: { icon: 'wrench', label: 'Sistemi' },
    connection: { icon: 'link', label: 'Lidhja' },
  };

  // ─── Start ─────────────────────────────────────────────────────────────────────────────
  on('state', (s) => {
    if (s) applyState(s);
  });
  on('changed', (c) => {
    const kind = (c && c.kind) || 'all';
    if (kind === 'sales' || kind === 'all') loadSnapshotSoon(350);
    if (kind === 'activity' || kind === 'all' || kind === 'sales') loadActivitySoon(900);
  });
  on('tab', (d) => {
    if (d && d.tab) openTab(d.tab === 'sales' ? 'live' : d.tab);
  });
  on('resume', () =>
    refreshState().then(() => {
      if (screen === 'main') {
        loadSnapshotSoon(0);
        loadActivitySoon(300);
      }
    }),
  );
  on('note', (n) => {
    if (!native && n) toast(n);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && screen === 'main') {
      refreshState();
      loadSnapshotSoon(0);
    }
  });
  // While the screen is on: a safety net next to the server's pushes.
  setInterval(() => {
    if (screen === 'main' && document.visibilityState === 'visible') loadSnapshotSoon(0);
  }, 30000);

  refreshState();

  function refreshState() {
    return call('getState').then((r) => {
      if (r.ok) applyState(r.data);
    });
  }

  function applyState(next) {
    const before = state;
    state = next;
    if (next.lang !== lang) {
      lang = next.lang === 'en' ? 'en' : 'sq';
      document.documentElement.lang = lang;
      screen = null; // every text changes
    }
    const want = next.signedIn ? 'main' : 'signin';
    if (want !== screen) {
      screen = want;
      if (want === 'main') showMain();
      else showSignIn();
      return;
    }
    if (screen === 'signin') {
      renderSignInNotice();
      return;
    }
    renderTop();
    renderSettings();
    renderLiveSetup();
    if (!before || before.connection !== next.connection) {
      renderLive();
      if (next.connection === 'online') {
        loadSnapshotSoon(0);
        loadActivitySoon(400);
      }
    }
  }

  // ─── Sign-in ───────────────────────────────────────────────────────────────────────────
  const form = {
    server: '',
    username: '',
    email: '',
    password: '',
    busy: false,
    error: null,
    found: null,
    searching: false,
  };

  function showSignIn() {
    snapshot = null;
    knownSales = null;
    activity.items = [];
    activity.page = 0;
    activity.total = 0;
    if (!form.server) form.server = (state.server || '').replace(/^http:\/\//, '');
    if (!form.username) form.username = (state.last && state.last.username) || '';
    if (!form.email) form.email = (state.last && state.last.email) || '';
    form.password = '';
    form.error = null;

    const input = (key, attrs) =>
      h(
        'input',
        Object.assign(
          {
            class: 'input',
            value: form[key],
            autocomplete: 'off',
            autocapitalize: 'none',
            autocorrect: 'off',
            spellcheck: 'false',
            oninput: (e) => {
              form[key] = e.target.value;
            },
          },
          attrs,
        ),
      );

    ui.signNotice = h('div');
    ui.signError = h('div');
    ui.found = h('div');
    ui.signButton = h(
      'button',
      { class: 'btn btn--primary', id: 'signin-submit', type: 'submit' },
      t('Hyr'),
    );
    const password = input('password', {
      id: 'signin-password',
      type: 'password',
      enterkeyhint: 'go',
    });

    fill(
      root,
      h(
        'form',
        {
          class: 'signin',
          novalidate: true,
          onsubmit: (e) => {
            e.preventDefault();
            signIn();
          },
        },
        h(
          'div',
          { class: 'brand' },
          h('div', { class: 'brand__mark' }, icon('pulse')),
          h('div', { class: 'brand__name' }, 'lika', h('b', null, 'live'), 'pcs'),
        ),
        h(
          'p',
          { class: 'lead' },
          t('Shitjet dhe çdo ndryshim në lokal, drejtpërdrejt në telefon.'),
        ),
        ui.signNotice,
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field__label' }, t('Adresa e serverit')),
          h(
            'span',
            { class: 'field__box' },
            input('server', {
              id: 'signin-server',
              type: 'text',
              inputmode: 'url',
              placeholder: '192.168.1.10:4700',
              enterkeyhint: 'next',
            }),
            h(
              'button',
              {
                class: 'icon-btn',
                type: 'button',
                id: 'signin-find',
                'aria-label': t('Gjej serverin në Wi-Fi'),
                onclick: discover,
              },
              icon('search'),
            ),
          ),
          ui.found,
          h(
            'span',
            { class: 'hint' },
            t(
              'Kompjuteri kryesor i LIKApcs. Adresën e gjeni te Admin › Kopjet rezervë › Serveri dhe rrjeti.',
            ),
          ),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field__label' }, t('Emri i përdoruesit')),
          input('username', { id: 'signin-username', type: 'text', enterkeyhint: 'next' }),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field__label' }, t('E-maili')),
          input('email', {
            id: 'signin-email',
            type: 'email',
            inputmode: 'email',
            enterkeyhint: 'next',
          }),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { class: 'field__label' }, t('Fjalëkalimi')),
          h(
            'span',
            { class: 'field__box' },
            password,
            h(
              'button',
              {
                class: 'icon-btn',
                type: 'button',
                'aria-label': t('Shfaq fjalëkalimin'),
                onclick: () => {
                  password.type = password.type === 'password' ? 'text' : 'password';
                },
              },
              icon('eye'),
            ),
          ),
        ),
        ui.signError,
        ui.signButton,
        h(
          'p',
          { class: 'hint', style: 'margin-top:14px' },
          t(
            'Llogaria duhet të jetë e pronarit ose e administratorit dhe të ketë e-mail të ruajtur te Admin › Punonjësit.',
          ),
        ),
        h('p', { class: 'foot', style: 'margin-top:18px' }, footText()),
      ),
    );
    root.className = '';
    renderSignInNotice();
    renderFound();
  }

  function renderSignInNotice() {
    if (!ui.signNotice) return;
    fill(
      ui.signNotice,
      state.connection === 'unauthorized'
        ? h(
            'div',
            { class: 'notice notice--bad' },
            icon('alert'),
            h(
              'span',
              null,
              t('Kyçja ka skaduar ose u mbyll nga Admin. Hyni përsëri që njoftimet të vazhdojnë.'),
            ),
          )
        : null,
    );
  }

  function renderFound() {
    if (!ui.found) return;
    if (form.searching) {
      fill(ui.found, h('span', { class: 'hint' }, t('Po kërkoj në Wi-Fi…')));
      return;
    }
    if (form.found === null) {
      fill(ui.found);
      return;
    }
    if (form.found.length === 0) {
      fill(
        ui.found,
        h(
          'span',
          { class: 'hint' },
          t('Nuk u gjet asnjë server në këtë Wi-Fi. Shkruani adresën me dorë.'),
        ),
      );
      return;
    }
    fill(
      ui.found,
      h(
        'ul',
        { class: 'found' },
        form.found.map((s) =>
          h(
            'li',
            null,
            h(
              'button',
              {
                type: 'button',
                onclick: () => {
                  form.server = s.url.replace(/^http:\/\//, '');
                  document.getElementById('signin-server').value = form.server;
                  form.found = null;
                  renderFound();
                },
              },
              h('strong', null, s.name || 'LIKApcs'),
              h(
                'span',
                null,
                s.url.replace(/^http:\/\//, '') + (s.version ? ' · v' + s.version : ''),
              ),
            ),
          ),
        ),
      ),
    );
  }

  function discover() {
    if (form.searching) return;
    form.searching = true;
    renderFound();
    call('discover').then((r) => {
      form.searching = false;
      form.found = r.ok ? r.data.servers : [];
      if (form.found.length === 1 && !form.server) {
        form.server = form.found[0].url.replace(/^http:\/\//, '');
        document.getElementById('signin-server').value = form.server;
      }
      renderFound();
    });
  }

  const SIGN_IN_ERRORS = {
    missing: 'Plotësoni të gjitha fushat.',
    bad_address: 'Kjo nuk duket si adresë serveri. Shembull: 192.168.1.10:4700',
    unreachable:
      'Serveri nuk u gjet në këtë adresë. Telefoni duhet të jetë në të njëjtin Wi-Fi me kompjuterin kryesor, ose Tailscale të jetë i ndezur.',
    not_likapcs: 'Në këtë adresë nuk ka server LIKApcs.',
    invalid_credentials: 'Emri, e-maili ose fjalëkalimi nuk përputhen.',
    locked: 'Llogaria është bllokuar përkohësisht pas shumë provave. Provoni më vonë.',
    too_many: 'Shumë prova njëra pas tjetrës. Prisni një minutë.',
    no_permission:
      'Kjo llogari nuk ka të drejtë të shohë Live tracking. Hyni me llogarinë e pronarit.',
    server_error: 'Serveri ktheu një gabim. Provoni përsëri.',
  };

  function signIn() {
    if (form.busy) return;
    form.busy = true;
    form.error = null;
    renderSignInBusy();
    call('signIn', {
      server: form.server,
      username: form.username,
      email: form.email,
      password: form.password,
    }).then((r) => {
      form.busy = false;
      if (r.ok) {
        form.password = '';
        applyState(r.data);
        // The phone asks for the notification permission once, right after the first sign-in.
        if (r.data.setup && r.data.setup.notifications === 'denied') call('askNotifications');
        return;
      }
      form.error = t(SIGN_IN_ERRORS[r.error.code] || 'Diçka shkoi keq. Provoni përsëri.');
      renderSignInBusy();
    });
  }

  function renderSignInBusy() {
    if (!ui.signButton) return;
    ui.signButton.disabled = form.busy;
    ui.signButton.textContent = form.busy ? t('Po hyj…') : t('Hyr');
    fill(
      ui.signError,
      form.error
        ? h(
            'div',
            { class: 'notice notice--bad', id: 'signin-error' },
            icon('alert'),
            h('span', null, form.error),
          )
        : null,
    );
  }

  // ─── Main screen ───────────────────────────────────────────────────────────────────────
  function showMain() {
    ui.signNotice = ui.signError = ui.found = ui.signButton = null;
    ui.topName = h('div', { class: 'top__name' });
    ui.topSub = h('div', { class: 'top__sub' });
    ui.pill = h('div', { class: 'pill', id: 'conn' });
    ui.views = {
      live: h('section', { class: 'view', id: 'view-live' }),
      activity: h('section', { class: 'view', id: 'view-activity' }),
      settings: h('section', { class: 'view', id: 'view-settings' }),
    };
    ui.liveSetup = h('div');
    ui.liveBody = h('div');
    fill(ui.views.live, ui.liveSetup, ui.liveBody);
    ui.tabs = {};
    const tabButton = (id, iconName, label) =>
      (ui.tabs[id] = h(
        'button',
        { class: 'tab', id: 'tab-' + id, onclick: () => openTab(id) },
        icon(iconName),
        h('span', null, label),
      ));
    ui.fresh = h(
      'button',
      {
        class: 'fresh',
        hidden: true,
        onclick: () => {
          ui.views.activity.scrollTop = 0;
          activity.stale = false;
          renderActivity();
        },
      },
      '↑ ' + t('Ndryshime të reja'),
    );

    fill(
      root,
      h(
        'header',
        { class: 'top' },
        h('div', { class: 'top__title' }, ui.topName, ui.topSub),
        ui.pill,
      ),
      h('main', { class: 'views' }, ui.views.live, ui.views.activity, ui.views.settings, ui.fresh),
      h(
        'nav',
        { class: 'tabs' },
        tabButton('live', 'pulse', t('Live')),
        tabButton('activity', 'list', t('Aktiviteti')),
        tabButton('settings', 'gear', t('Cilësimet')),
      ),
    );
    root.className = '';
    ui.views.activity.addEventListener(
      'scroll',
      () => {
        if (activity.stale && ui.views.activity.scrollTop < 60) {
          activity.stale = false;
          renderActivity();
        }
      },
      { passive: true },
    );

    renderTop();
    renderLiveSetup();
    renderLive();
    renderActivity();
    renderSettings();
    openTab(pendingTab || tab);
    pendingTab = null;
    loadSnapshotSoon(0);
    loadActivitySoon(200);
  }

  function openTab(id) {
    if (!ui.views || screen !== 'main') {
      pendingTab = id;
      return;
    }
    if (!ui.views[id]) id = 'live';
    tab = id;
    Object.keys(ui.views).forEach((k) => {
      ui.views[k].hidden = k !== id;
      ui.tabs[k].className = 'tab' + (k === id ? ' tab--on' : '');
    });
    ui.fresh.hidden = !(id === 'activity' && activity.stale);
    if (id === 'activity' && activity.page === 0) loadActivitySoon(0);
    if (id === 'settings') refreshState();
  }

  function renderTop() {
    if (!ui.topName) return;
    ui.topName.textContent = state.business || 'likalivepcs';
    const c = state.connection;
    const label =
      c === 'online'
        ? t('Live')
        : c === 'connecting'
          ? t('Po lidhet…')
          : c === 'offline'
            ? t('Pa lidhje')
            : c === 'unauthorized'
              ? t('Hyni përsëri')
              : t('Ndalur');
    ui.pill.className = 'pill pill--' + c;
    fill(ui.pill, h('span', { class: 'pill__dot' }), label);
    ui.topSub.textContent = snapshot
      ? t('Përditësuar {time}', { time: clock(snapshot.generatedAt) })
      : 'likalivepcs';
  }

  // ─── Live ──────────────────────────────────────────────────────────────────────────────
  function loadSnapshotSoon(delay) {
    if (screen !== 'main') return;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(loadSnapshot, delay);
  }

  function loadSnapshot() {
    if (screen !== 'main' || snapshotBusy) return;
    snapshotBusy = true;
    call('request', { path: '/live/snapshot' }).then((r) => {
      snapshotBusy = false;
      if (screen !== 'main') return;
      let next = null;
      if (r.ok && r.data.status === 200) {
        try {
          next = JSON.parse(r.data.body);
        } catch {
          next = null;
        }
      }
      if (next) {
        snapshot = next;
        snapshotError = false;
      } else if (!snapshot) {
        snapshotError = true;
      }
      renderTop();
      renderLive();
    });
  }

  /** What still has to be allowed on the phone, at the top of the Live tab until it is done. */
  function renderLiveSetup() {
    if (!ui.liveSetup) return;
    const setup = state.setup || {};
    if (setup.notifications === 'granted' && setup.battery) {
      fill(ui.liveSetup);
      return;
    }
    fill(
      ui.liveSetup,
      h(
        'div',
        { class: 'card', id: 'setup-card' },
        h('h2', { class: 'card__title' }, t('Që njoftimet të vijnë gjithmonë')),
        setupChecks(false),
      ),
    );
  }

  function setupChecks(full) {
    const setup = state.setup || {};
    const rows = [];
    const check = (ok, title, text, button) =>
      h(
        'div',
        { class: 'check' + (ok ? ' check--ok' : '') },
        h('div', { class: 'check__mark' }, icon(ok ? 'check' : 'alert')),
        h(
          'div',
          { class: 'check__body' },
          h('strong', null, title),
          text ? h('span', null, text) : null,
          button || null,
        ),
      );
    const small = (id, label, method, args) =>
      h(
        'button',
        {
          class: 'btn btn--small' + (full ? '' : ' btn--primary'),
          id,
          onclick: () =>
            call(method, args).then((r) => {
              if (r.ok) applyState(r.data);
            }),
        },
        label,
      );

    if (setup.notifications === 'granted') {
      if (full) rows.push(check(true, t('Njoftimet janë të lejuara')));
    } else if (setup.notifications === 'blocked') {
      rows.push(
        check(
          false,
          t('Lejo njoftimet'),
          t('Njoftimet janë të fikura për këtë aplikacion. Ndizini te cilësimet e telefonit.'),
          small('setup-notifications', t('Hap cilësimet e njoftimeve'), 'openSettings', {
            page: 'notifications',
          }),
        ),
      );
    } else {
      rows.push(
        check(
          false,
          t('Lejo njoftimet'),
          t('Telefoni ende nuk e lejon këtë aplikacion të shfaqë njoftime.'),
          small('setup-notifications', t('Lejo njoftimet'), 'askNotifications'),
        ),
      );
    }
    if (setup.battery) {
      if (full) rows.push(check(true, t('Puna në sfond është e lejuar')));
    } else {
      rows.push(
        check(
          false,
          t('Lejo punën në sfond'),
          t(
            'Pa këtë, telefoni e ndal aplikacionin pas pak kohe me ekran të fikur dhe njoftimet vonohen.',
          ),
          small('setup-battery', t('Lejo punën në sfond'), 'askBattery'),
        ),
      );
    }
    const brand = ((state.device && state.device.brand) || '').toLowerCase();
    if (full || /realme|oppo|oneplus/.test(brand)) {
      rows.push(
        h(
          'div',
          { class: 'check check--ok' },
          h(
            'div',
            {
              class: 'check__mark',
              style: 'background:var(--accent-soft);color:var(--accent-text)',
            },
            icon('bell'),
          ),
          h(
            'div',
            { class: 'check__body' },
            h('strong', null, t('Te telefonat realme')),
            h(
              'span',
              null,
              t(
                'Cilësimet › Aplikacionet › likalivepcs › Përdorimi i baterisë: ndizni “Lejo aktivitetin në sfond” dhe “Lejo nisjen automatike”. Pastaj te aplikacionet e fundit hapni menynë mbi kartën e likalivepcs dhe zgjidhni “Kyç”, që telefoni të mos e mbyllë.',
              ),
            ),
            small('setup-app', t('Hap cilësimet e aplikacionit'), 'openSettings', { page: 'app' }),
          ),
        ),
      );
    }
    return rows;
  }

  function renderLive() {
    if (!ui.liveBody) return;
    const parts = [];
    if (state.connection === 'offline') {
      parts.push(
        h(
          'div',
          { class: 'notice notice--bad', id: 'offline-notice' },
          icon('alert'),
          h(
            'span',
            null,
            t(
              'Pa lidhje me serverin që nga ora {time}. Shifrat më poshtë janë të fundit që u lexuan; sapo të kthehet lidhja, vijnë edhe njoftimet që munguan.',
              { time: clock(state.since) },
            ),
          ),
        ),
      );
    }
    if (!snapshot) {
      parts.push(
        snapshotError
          ? h(
              'div',
              { class: 'card' },
              h('div', { class: 'empty' }, t('Shifrat e ditës nuk u lexuan. Provoni përsëri.')),
              h(
                'button',
                {
                  class: 'btn',
                  onclick: () => {
                    snapshotError = false;
                    renderLive();
                    loadSnapshotSoon(0);
                  },
                },
                icon('refresh'),
                t('Provo përsëri'),
              ),
            )
          : h('div', { class: 'empty' }, t('Po lexoj shifrat e ditës…')),
      );
      fill(ui.liveBody, parts);
      return;
    }
    const s = snapshot;
    const x = s.totals;
    const d = s.drawer;

    parts.push(
      h(
        'div',
        { class: 'hero', id: 'hero' },
        h('div', { class: 'hero__label' }, t('Qarkullimi sot (me TVSH)')),
        h('div', { class: 'hero__value num', id: 'turnover' }, money(x.turnoverCents)),
        h(
          'div',
          { class: 'hero__row' },
          h(
            'span',
            { class: 'chip', id: 'sales-count' },
            t('{count} shitje', { count: x.salesCount }),
          ),
          x.salesCount > 0
            ? h(
                'span',
                { class: 'chip' },
                t('mesatarja {amount}', { amount: money(x.averageSaleCents) }),
              )
            : null,
        ),
      ),
    );

    if (x.incomplete) {
      parts.push(
        h(
          'div',
          { class: 'notice' },
          icon('alert'),
          h('span', null, t('Disa kosto mungojnë: fitimi mund të jetë më i lartë se realiteti.')),
        ),
      );
    }

    // Who sold how much: the reason this app exists, so it comes right under the day's total.
    const staff = s.staff
      .slice()
      .sort(
        (a, b) =>
          b.salesCents - a.salesCents ||
          Number(b.onDuty) - Number(a.onDuty) ||
          a.name.localeCompare(b.name),
      );
    const top = staff.reduce((m, p) => Math.max(m, p.salesCents), 0);
    parts.push(
      h(
        'section',
        { class: 'card', id: 'staff' },
        h('h2', { class: 'card__title' }, t('Kush sa ka shitur')),
        staff.length === 0
          ? h('div', { class: 'empty' }, t('Ende asnjë shitje nga punonjësit sot'))
          : h(
              'ul',
              { class: 'staff' },
              staff.map((p) =>
                h(
                  'li',
                  {
                    class:
                      'staff__row' + (top > 0 && p.salesCents === top ? ' staff__row--top' : ''),
                  },
                  h(
                    'div',
                    { class: 'staff__head' },
                    h('span', { class: 'staff__name' }, p.name),
                    h('span', { class: 'staff__amount num' }, money(p.salesCents)),
                  ),
                  h(
                    'div',
                    { class: 'staff__bar' },
                    h('i', {
                      style:
                        'width:' + (top > 0 ? Math.round((p.salesCents / top) * 100) : 0) + '%',
                    }),
                  ),
                  h(
                    'div',
                    { class: 'staff__meta' },
                    h(
                      'span',
                      { class: 'duty' + (p.onDuty ? ' duty--on' : '') },
                      p.onDuty ? t('Në punë') : t('Jashtë pune'),
                    ),
                    h('span', null, t('{count} shitje', { count: p.salesCount })),
                    p.lastSaleAt
                      ? h('span', null, t('shitja e fundit {time}', { time: clock(p.lastSaleAt) }))
                      : null,
                    p.workedMinutes > 0
                      ? h('span', null, t('punoi {time}', { time: worked(p.workedMinutes) }))
                      : null,
                  ),
                ),
              ),
            ),
      ),
    );

    parts.push(
      h(
        'div',
        { class: 'kpis' },
        kpi(t('Fitimi bruto'), money(x.grossProfitCents), t('Pa TVSH, minus kosto'), 'good'),
        kpi(
          t('Fitimi neto'),
          money(x.netProfitCents),
          t('Pas shpenzimeve'),
          x.netProfitCents < 0 ? 'bad' : '',
        ),
        kpi(
          t('Arka'),
          d.open && d.expectedCents !== null ? money(d.expectedCents) : '—',
          d.open ? t('Duhet të ketë tani') : t('Asnjë turn i hapur'),
          '',
        ),
        kpi(t('Shpenzimet'), money(x.expensesCents), '', ''),
        kpi(t('Borxh i dhënë sot'), money(x.debtGivenCents), '', ''),
        kpi(t('Borxh i paguar sot'), money(x.debtCollectedCents), '', ''),
        x.lossCents > 0
          ? kpi(
              t('Humbjet'),
              money(x.lossCents),
              t('Kthime {refunded} · stok {stock}', {
                refunded: money(x.refundedCents),
                stock: money(x.stockLossCents),
              }),
              'bad',
            )
          : null,
      ),
    );

    const fresh = new Set();
    if (knownSales)
      s.feed.forEach((sale) => {
        if (!knownSales.has(sale.saleId)) fresh.add(sale.saleId);
      });
    knownSales = new Set(s.feed.map((sale) => sale.saleId));
    parts.push(
      h(
        'section',
        { class: 'card', id: 'feed' },
        h('h2', { class: 'card__title' }, t('Shitjet live')),
        s.feed.length === 0
          ? h('div', { class: 'empty' }, t('Ende asnjë shitje sot'))
          : h(
              'ol',
              { class: 'feed' },
              s.feed.map((sale) =>
                h(
                  'li',
                  { class: 'sale' + (fresh.has(sale.saleId) ? ' sale--new' : '') },
                  h('span', { class: 'sale__time num' }, clock(sale.completedAt)),
                  h(
                    'div',
                    { class: 'sale__body' },
                    h(
                      'div',
                      { class: 'sale__head' },
                      h('span', { class: 'sale__who' }, sale.cashierName),
                      h('span', { class: 'sale__amount num' }, money(sale.totalCents)),
                    ),
                    h(
                      'div',
                      { class: 'sale__items' },
                      sale.items
                        .map((i) =>
                          i.isTime ? timeLine(i.name) : i.name + ' ×' + qty(i.quantityMilli),
                        )
                        .join(', '),
                    ),
                    h(
                      'div',
                      { class: 'sale__meta' },
                      t('fitimi {amount}', { amount: money(sale.profitCents) }) +
                        (sale.missingCost ? ' (' + t('pa kosto') + ')' : ''),
                      sale.onCredit
                        ? h(
                            'span',
                            { class: 'tag' },
                            t('Borxh') + (sale.customerName ? ' · ' + sale.customerName : ''),
                          )
                        : null,
                    ),
                  ),
                ),
              ),
            ),
      ),
    );

    if (s.topProducts.length > 0) {
      parts.push(
        h(
          'section',
          { class: 'card' },
          h('h2', { class: 'card__title' }, t('Produktet kryesore sot')),
          h(
            'ul',
            { class: 'rows' },
            s.topProducts.map((p) =>
              h(
                'li',
                null,
                h(
                  'span',
                  { class: 'rows__main' },
                  p.name,
                  h('span', { class: 'muted' }, '  ×' + qty(p.quantityMilli)),
                ),
                h('span', { class: 'rows__end num' }, money(p.amountCents)),
              ),
            ),
          ),
        ),
      );
    }
    fill(ui.liveBody, parts);
  }

  function kpi(label, value, note, tone) {
    return h(
      'div',
      { class: 'kpi' + (tone ? ' kpi--' + tone : '') },
      h('span', null, label),
      h('strong', { class: 'num' }, value),
      note ? h('small', null, note) : null,
    );
  }

  // ─── Activity ──────────────────────────────────────────────────────────────────────────
  const PAGE = 40;

  function loadActivitySoon(delay) {
    if (screen !== 'main') return;
    clearTimeout(activityTimer);
    activityTimer = setTimeout(() => loadActivity(1), delay);
  }

  function loadActivity(page) {
    if (screen !== 'main' || activity.loading) return;
    activity.loading = true;
    if (page > 1) renderActivity();
    call('activity', { page, pageSize: PAGE }).then((r) => {
      activity.loading = false;
      if (screen !== 'main') return;
      if (!r.ok) {
        activity.error = r.error.code;
        renderActivity();
        return;
      }
      activity.error = null;
      activity.total = r.data.total;
      if (page === 1) {
        // The newest page again: put new rows on top of what is already loaded.
        const have = new Set(activity.items.map((i) => i.id));
        const added = r.data.items.filter((i) => !have.has(i.id));
        activity.items = added.concat(activity.items);
        activity.page = Math.max(activity.page, 1);
        if (added.length === 0 && activity.items.length > 0) {
          if (tab === 'activity') renderActivityFoot();
          return;
        }
        // Reading further down: do not move the list under the finger, offer the new rows instead.
        if (tab === 'activity' && ui.views.activity.scrollTop > 60 && added.length > 0) {
          activity.stale = true;
          ui.fresh.hidden = false;
          return;
        }
      } else {
        const have = new Set(activity.items.map((i) => i.id));
        activity.items = activity.items.concat(r.data.items.filter((i) => !have.has(i.id)));
        activity.page = page;
      }
      renderActivity();
    });
  }

  function renderActivity() {
    const view = ui.views && ui.views.activity;
    if (!view) return;
    ui.fresh.hidden = !(tab === 'activity' && activity.stale);
    const filters = [['all', 'Të gjitha']].concat(
      Object.keys(CATEGORY)
        .filter((k) => k !== 'connection')
        .map((k) => [k, CATEGORY[k].label]),
    );
    const bar = h(
      'div',
      { class: 'filters' },
      filters.map(([id, label]) =>
        h(
          'button',
          {
            class: 'filter' + (activity.filter === id ? ' filter--on' : ''),
            'data-filter': id,
            onclick: () => {
              activity.filter = id;
              view.scrollTop = 0;
              renderActivity();
            },
          },
          t(label),
        ),
      ),
    );

    const parts = [bar];
    if (activity.error === 'no_permission') {
      parts.push(
        h(
          'div',
          { class: 'notice notice--info' },
          icon('alert'),
          h(
            'span',
            null,
            t(
              'Kjo llogari nuk ka të drejtë të lexojë regjistrin e auditimit, prandaj lista e ndryshimeve mbetet bosh. Shitjet vijnë gjithsesi.',
            ),
          ),
        ),
      );
    } else if (activity.error && activity.items.length === 0) {
      parts.push(
        h(
          'div',
          { class: 'card' },
          h('div', { class: 'empty' }, t('Regjistri nuk u lexua. Provoni përsëri.')),
          h(
            'button',
            { class: 'btn', onclick: () => loadActivity(1) },
            icon('refresh'),
            t('Provo përsëri'),
          ),
        ),
      );
    }
    const shown = activity.items.filter(
      (i) => activity.filter === 'all' || i.category === activity.filter,
    );
    if (shown.length === 0 && !activity.error) {
      parts.push(
        h(
          'div',
          { class: 'empty' },
          activity.loading || activity.page === 0
            ? t('Po lexoj…')
            : t('Asgjë për të shfaqur këtu.'),
        ),
      );
    }
    let day = null;
    let list = null;
    shown.forEach((item) => {
      const label = dayLabel(item.at);
      if (label !== day) {
        day = label;
        parts.push(h('div', { class: 'day' }, label));
        list = h('ul', { class: 'acts' });
        parts.push(list);
      }
      const meta = CATEGORY[item.category] || CATEGORY.system;
      list.appendChild(
        h(
          'li',
          { class: 'act c-' + item.category },
          h('div', { class: 'act__icon' }, icon(meta.icon)),
          h(
            'div',
            { class: 'act__body' },
            h('div', { class: 'act__title' }, item.title),
            item.text ? h('div', { class: 'act__text' }, item.text) : null,
          ),
          h('span', { class: 'act__time num' }, clock(item.at)),
        ),
      );
    });
    ui.activityFoot = h('div', { class: 'more' });
    parts.push(ui.activityFoot);
    const keep = view.scrollTop;
    fill(view, parts);
    view.scrollTop = keep;
    renderActivityFoot();
  }

  function renderActivityFoot() {
    if (!ui.activityFoot) return;
    const more = activity.page > 0 && activity.page * PAGE < activity.total;
    fill(
      ui.activityFoot,
      more
        ? h(
            'button',
            {
              class: 'btn',
              id: 'activity-more',
              disabled: activity.loading,
              onclick: () => loadActivity(activity.page + 1),
            },
            activity.loading ? t('Po lexoj…') : t('Më shumë'),
          )
        : null,
    );
  }

  // ─── Settings ──────────────────────────────────────────────────────────────────────────
  const KINDS = [
    ['sales', 'Çdo shitje', 'Kush shiti, çfarë dhe sa.'],
    [
      'alerts',
      'Gjëra për t’u parë',
      'Rimbursime, anulime, ndryshime çmimi, minuta falas, hyrje të dështuara.',
    ],
    ['pcs', 'Kompjuterët', 'Sesione, kërkesa dhe porosi nga PC-të, rezervime.'],
    ['money', 'Paratë', 'Arka, shpenzimet, blerjet, borxhet.'],
    ['stock', 'Stoku dhe çmimet', 'Stok i ulët, rregullime stoku, produkte.'],
    ['people', 'Punonjësit', 'Kush u kyç, llogari, klientë.'],
    ['system', 'Sistemi', 'Cilësime, kopje rezervë, pajisje.'],
    ['connection', 'Lidhja me serverin', 'Kur lidhja mungon më shumë se 5 minuta.'],
  ];

  function footText() {
    const d = (state && state.device) || {};
    const bits = [
      'likalivepcs v1' + (state && state.appVersion ? ' (' + state.appVersion + ')' : ''),
    ];
    // "realme RMX3933"; the brand is left out when the model already says it.
    const brand = d.brand || '';
    const model = d.model || '';
    const named =
      model.toLowerCase().indexOf(brand.toLowerCase()) === 0 ? model : (brand + ' ' + model).trim();
    if (named) bits.push(named);
    if (d.release) bits.push('Android ' + d.release);
    return bits.join(' · ');
  }

  function renderSettings() {
    const view = ui.views && ui.views.settings;
    if (!view) return;
    const c = state.connection;
    const status =
      c === 'online'
        ? t('I lidhur')
        : c === 'connecting'
          ? t('Po lidhet…')
          : c === 'offline'
            ? t('Pa lidhje')
            : c === 'unauthorized'
              ? t('Hyni përsëri')
              : t('Ndalur');
    const kv = (label, value) =>
      h('div', { class: 'kv' }, h('span', null, label), h('span', null, value || '—'));
    const user = state.user || {};

    const setOption = (args) =>
      call('setOptions', args).then((r) => {
        if (r.ok) applyState(r.data);
      });
    const armed = Date.now() < signOutArmed;

    const keep = view.scrollTop;
    fill(
      view,
      h(
        'section',
        { class: 'card', id: 'settings-link' },
        h('h2', { class: 'card__title' }, t('Lidhja')),
        kv(
          t('Gjendja'),
          status + (c === 'offline' || c === 'connecting' ? ' · ' + clock(state.since) : ''),
        ),
        kv(t('Serveri'), (state.server || '').replace(/^http:\/\//, '')),
        kv(t('Versioni i serverit'), state.serverVersion),
        kv(t('Mesazhi i fundit'), state.lastEventAt ? dateTime(state.lastEventAt) : '—'),
        kv(
          t('Llogaria'),
          user.fullName ? user.fullName + ' (' + user.username + ')' : user.username,
        ),
        kv(t('Kyçja vlen deri më'), state.expiresAt ? dateTime(state.expiresAt) : '—'),
        h(
          'div',
          { class: 'btn-row' },
          h(
            'button',
            {
              class: 'btn',
              id: 'settings-refresh',
              onclick: () =>
                call('refresh').then((r) => {
                  if (r.ok) applyState(r.data);
                  loadSnapshotSoon(300);
                }),
            },
            icon('refresh'),
            t('Kontrollo lidhjen tani'),
          ),
        ),
      ),

      h(
        'section',
        { class: 'card', id: 'settings-setup' },
        h('h2', { class: 'card__title' }, t('Që njoftimet të vijnë gjithmonë')),
        setupChecks(true),
      ),

      h(
        'section',
        { class: 'card', id: 'settings-kinds' },
        h('h2', { class: 'card__title' }, t('Për çfarë të njoftohem')),
        KINDS.map(([id, title, text]) => {
          const isOn = !state.categories || state.categories[id] !== false;
          return h(
            'button',
            {
              class: 'switch-row',
              role: 'switch',
              'aria-checked': String(isOn),
              'data-kind': id,
              onclick: () => {
                const patch = {};
                patch[id] = !isOn;
                setOption({ categories: patch });
              },
            },
            h(
              'span',
              { class: 'switch-row__text' },
              h('strong', null, t(title)),
              h('span', null, t(text)),
            ),
            h('span', { class: 'switch' + (isOn ? ' switch--on' : '') }),
          );
        }),
        h(
          'p',
          { class: 'hint', style: 'margin:10px 0 0' },
          t(
            'Tingulli dhe mënyra si shfaqet secili lloj ndryshohen te cilësimet e njoftimeve të telefonit.',
          ),
        ),
        h(
          'div',
          { class: 'btn-row' },
          h(
            'button',
            { class: 'btn', id: 'settings-test', onclick: () => call('testNotification') },
            icon('bell'),
            t('Dërgo një njoftim provë'),
          ),
          h(
            'button',
            { class: 'btn', onclick: () => call('openSettings', { page: 'notifications' }) },
            t('Hap cilësimet e njoftimeve'),
          ),
        ),
      ),

      h(
        'section',
        { class: 'card' },
        h('h2', { class: 'card__title' }, t('Gjuha')),
        h(
          'div',
          { class: 'seg' },
          h(
            'button',
            {
              class: lang === 'sq' ? 'on' : '',
              id: 'lang-sq',
              onclick: () => setOption({ lang: 'sq' }),
            },
            'Shqip',
          ),
          h(
            'button',
            {
              class: lang === 'en' ? 'on' : '',
              id: 'lang-en',
              onclick: () => setOption({ lang: 'en' }),
            },
            'English',
          ),
        ),
      ),

      h(
        'button',
        {
          class: 'btn btn--danger',
          id: 'signout',
          onclick: () => {
            if (Date.now() < signOutArmed) {
              signOutArmed = 0;
              call('signOut').then((r) => {
                if (r.ok) applyState(r.data);
              });
            } else {
              signOutArmed = Date.now() + 4000;
              renderSettings();
              setTimeout(() => {
                if (screen === 'main') renderSettings();
              }, 4100);
            }
          },
        },
        armed ? t('Shtypni përsëri për të dalë') : t('Dil nga llogaria'),
      ),
      h(
        'p',
        { class: 'hint', style: 'text-align:center' },
        t('Pas daljes nuk vjen më asnjë njoftim.'),
      ),
      h('p', { class: 'foot' }, footText()),
    );
    view.scrollTop = keep;
  }

  // ─── Browser preview only: what the phone would show as a system notification ─────────────
  function toast(note) {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = h('div', { class: 'toasts' });
      document.body.appendChild(box);
    }
    const el = h(
      'div',
      { class: 'toast' },
      h('strong', null, note.title),
      note.text ? h('span', null, note.text) : null,
    );
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 6000);
  }
})();
