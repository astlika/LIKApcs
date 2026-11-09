import { useSyncExternalStore } from 'react';

/**
 * Phone language. The keys are the Albanian texts themselves, so a missing English entry simply
 * shows Albanian (never a blank or a raw key). The language follows the account's saved setting
 * (see prefs.ts → applyPrefs).
 */
export type Lang = 'sq' | 'en';

let current: Lang = 'sq';
const listeners = new Set<() => void>();

export function setLanguage(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = (): Lang => current;

/** Re-renders the component when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export const localeOf = (lang: Lang = current): string => (lang === 'en' ? 'en-GB' : 'sq-AL');

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

export function translate(key: string, vars?: Record<string, string | number>, lang: Lang = current): string {
  let text = lang === 'en' ? (EN[key] ?? key) : key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
  }
  return text;
}

/** Use inside components: `const t = useT(); t('Shitje e re')`. */
export function useT(): TFunc {
  const lang = useLang();
  return (key, vars) => translate(key, vars, lang);
}

const EN: Record<string, string> = {
  // Start page: cash drawer (0.29.8)
  'Në arkë tani': 'In the drawer now',
  'Shitje me para': 'Cash sales',
  'Hapur, {name}': 'Open, {name}',
  '{count} shitje': '{count} sales',

  // Payment, start page, cart (0.29.8)
  'Pagesa': 'Payment',
  'Shuma me para': 'Cash amounts',
  'Sakto': 'Exact',
  'Shto pagesë': 'Add payment',
  'Mbetet': 'Remaining',
  'Kthimi': 'Change',
  'Pagesat jo-kesh janë më të mëdha se totali.': 'Non-cash payments are larger than the total.',
  'Përfundo · {amount}': 'Complete · {amount}',
  'Shporta': 'Cart',
  'Për pagesë me borxh zgjidhni klientin.': 'For payment on debt, choose the customer.',
  'Shuma {amount} shtohet te borxhi i {name}.': 'The amount {amount} is added to the debt of {name}.',
  'Nëntotali': 'Subtotal',
  'Zbritja': 'Discount',
  'Shitjet sot': 'Today\'s sales',
  'Mesatarja': 'Average',
  'Borxhe të vonuara': 'Overdue debts',
  'Afati': 'Due',
  'Thirr': 'Call',
  'Pa telefon': 'No phone',
  'Pagesë': 'Pay',
  'Duke regjistruar…': 'Saving…',

  // Shell and menu
  Kryefaqja: 'Home',
  'PC-të': 'PCs',
  Shitje: 'Sales',
  Borxhet: 'Debts',
  Raportet: 'Reports',
  Cilësimet: 'Settings',
  Arka: 'Cash drawer',
  Shpenzimet: 'Expenses',
  Stoku: 'Stock',
  Menyja: 'Menu',
  Menu: 'Menu',
  Kryesore: 'Main',
  'Më shumë': 'More',
  Lidhur: 'Connected',
  'Pa lidhje': 'Offline',
  'Duke hapur…': 'Opening…',
  'Nuk u lexuan llogaria. Provoni përsëri.': 'The account could not be loaded. Try again.',
  'Sesioni skadoi. Hyni përsëri.': 'Your session expired. Sign in again.',
  'Pa lidhje me serverin. Veprimet me para janë të bllokuara.': 'No connection to the server. Money actions are blocked.',
  'Shitjet, arka, fitimi': 'Sales, cash, profit',
  'Tema, teksti, llogaria': 'Theme, text, account',
  'Dil nga llogaria': 'Sign out',
  'Hapja, mbyllja, depozita': 'Open, close, deposits',
  'Regjistro dhe anulo': 'Record and void',
  'Stoku i ulët, kontroll barkodi': 'Low stock, barcode check',
  'Ruhen për llogarinë «{user}»': 'Saved for the account “{user}”',

  // Settings
  'Cilësimet u ruajtën.': 'Settings saved.',
  'Cilësimet nuk u ngarkuan.': 'Settings could not be loaded.',
  Pamja: 'Appearance',
  Tema: 'Theme',
  Errët: 'Dark',
  Ndritshëm: 'Light',
  'Sipas telefonit': 'Follow phone',
  'Madhësia e tekstit': 'Text size',
  Normale: 'Normal',
  'Të mëdha': 'Large',
  Gjuha: 'Language',
  Shqip: 'Albanian',
  English: 'English',
  'Pa lidhje me serverin. Ndryshimet ruhen kur të lidheni.': 'No connection to the server. Changes are saved when you reconnect.',
  Llogaria: 'Account',
  Emri: 'Name',
  Përdoruesi: 'Username',
  Roli: 'Role',

  // Home
  'Përshëndetje, {name}': 'Hello, {name}',
  'Në punë': 'In use',
  'Në pauzë': 'Paused',
  'Të lira': 'Free',
  Gjithsej: 'Total',
  '{count} fatura': '{count} invoices',
  'Të vonuara': 'Overdue',
  Sot: 'Today',
  'Veprime të shpejta': 'Quick actions',
  'Shitje e re': 'New sale',
  'Produkte dhe pagesë': 'Products and payment',
  'Nis / ndal PC': 'Start / stop PC',
  'Kontrollo kohën': 'Check the time',
  'Arkëto borxh': 'Collect a debt',
  'Pagesë e plotë ose pjesë': 'Full or partial payment',

  // Login
  'Adresa e serverit nuk është e saktë. Shembull: http://100.x.y.z:4700': 'The server address is not valid. Example: http://100.x.y.z:4700',
  'Llogaria është e kyçur përkohësisht. Provoni më vonë.': 'The account is temporarily locked. Try again later.',
  'Shumë përpjekje. Prisni një minutë.': 'Too many attempts. Wait one minute.',
  'Hyrja dështoi.': 'Sign-in failed.',
  'Serveri LIKApcs': 'LIKApcs server',
  'E-mail': 'Email',
  Fjalëkalimi: 'Password',
  'Duke hyrë…': 'Signing in…',
  Hyr: 'Sign in',

  // Shared components
  'Duke ngarkuar…': 'Loading…',
  'Klienti (opsional)': 'Customer (optional)',
  Klienti: 'Customer',
  Hiq: 'Remove',
  'Kërko klientin me emër ose telefon': 'Search for a customer by name or phone',
  'Asnjë klient.': 'No customer.',
  '+ Klient i ri': '+ New customer',
  'Telefoni (opsional)': 'Phone (optional)',
  Anulo: 'Cancel',
  'Duke ruajtur…': 'Saving…',
  'Ruaj klientin': 'Save customer',
  'Klienti u shtua: {name}': 'Customer added: {name}',

  // Labels (payment methods, PC states, billing)
  'Para në dorë': 'Cash',
  Kartelë: 'Card',
  Transfer: 'Bank transfer',
  Tjetër: 'Other',
  Balanca: 'Wallet',
  'Me borxh': 'On account',
  Staf: 'Staff',
  'E lirë': 'Free',
  'E zënë': 'In use',
  'E kyçur': 'Locked',
  Mirëmbajtje: 'Maintenance',
  'Po përditësohet': 'Updating',
  Gabim: 'Error',
  Joaktive: 'Inactive',
  'Me pagesë paraprake': 'Prepaid',
  'Pas përdorimit': 'Pay after use',
  'Paguhet në fund': 'Pay at the end',

  // Alerts
  '{name} u shkëput (offline).': '{name} went offline.',
  '{name}: mbeten 5 min.': '{name}: 5 minutes left.',

  // Cash drawer
  'Pa arkë aktive': 'No active drawer',
  'Arka nuk u ngarkua.': 'The drawer could not be loaded.',
  'Depozitë / Tërheqje': 'Deposit / Withdrawal',
  'Mbyll turnin': 'Close shift',
  'Nuk keni leje për lëvizje parash.': 'You do not have permission for cash movements.',
  'Lëvizjet e sotme': "Today's movements",
  'Ende nuk ka lëvizje.': 'No movements yet.',
  Depozitë: 'Deposit',
  Tërheqje: 'Withdrawal',
  'Turni u hap {date} · {name}': 'Shift opened {date} · {name}',
  'I hapur': 'Open',
  Hapja: 'Opening',
  Depozita: 'Deposits',
  'Shitje në para': 'Cash sales',
  'Borxhe të mbledhura': 'Debts collected',
  Shpenzime: 'Expenses',
  'Nuk ka turn të hapur': 'No open shift',
  'Hapni turnin me shumën që keni në arkë.': 'Open the shift with the amount you have in the drawer.',
  'Para në fillim': 'Starting cash',
  'Nuk keni leje për të hapur turnin.': 'You do not have permission to open a shift.',
  'Hap turnin': 'Open shift',
  'Turni u hap.': 'Shift opened.',
  'Lëvizje parash': 'Cash movement',
  Lloji: 'Type',
  Shuma: 'Amount',
  Arsyeja: 'Reason',
  'p.sh. kthim i drekës': 'e.g. lunch change',
  Regjistro: 'Record',
  'Depozita u regjistrua.': 'Deposit recorded.',
  'Tërheqja u regjistrua.': 'Withdrawal recorded.',
  'Turni u mbyll.': 'Shift closed.',
  'Para të numëruara në arkë': 'Counted cash in the drawer',
  'Shënime (opsionale)': 'Notes (optional)',
  Vazhdo: 'Continue',
  'Po, mbyll turnin': 'Yes, close shift',
  'Duke mbyllur…': 'Closing…',
  'Pasi të mbyllet, turni nuk hapet më. Kontrolloni shumën para se të vazhdoni.':
    'Once closed, the shift cannot be reopened. Check the amount before you continue.',

  // Expenses
  '+ Shpenzim': '+ Expense',
  Periudha: 'Period',
  '7 ditë': '7 days',
  '30 ditë': '30 days',
  'Shpenzimet nuk u ngarkuan.': 'Expenses could not be loaded.',
  Totali: 'Total',
  Numri: 'Count',
  'Nuk ka shpenzime në këtë periudhë.': 'No expenses in this period.',
  'E anuluar': 'Voided',
  'Shpenzim i ri': 'New expense',
  Kategoria: 'Category',
  'Mënyra e pagesës': 'Payment method',
  'Shuma merret nga arka e hapur.': 'The amount is taken from the open drawer.',
  Përshkrimi: 'Description',
  'p.sh. faturë e energjisë': 'e.g. electricity bill',
  'Ruaj shpenzimin': 'Save expense',
  'Shpenzimi u regjistrua.': 'Expense recorded.',
  'Anulo shpenzimin': 'Void expense',
  'Arsyeja e anulimit': 'Reason for voiding',
  'Po, anulo': 'Yes, void',
  'Shpenzimi u anulua.': 'Expense voided.',

  // Stock
  'Kontrollo barkodin ose kodin': 'Check a barcode or code',
  'Shkruani ose skanoni': 'Type or scan',
  Kontrollo: 'Check',
  'Stoku: {qty}': 'Stock: {qty}',
  'Stoku i ulët': 'Low stock',
  'Lista e stokut nuk u ngarkua.': 'The stock list could not be loaded.',
  'Nuk ka produkte me stok të ulët.': 'No products with low stock.',
  'Minimumi: {qty}': 'Minimum: {qty}',

  // PC commands and bulk actions
  'Komandat e PC-së': 'PC commands',
  Zhbllokoje: 'Unlock',
  Kyçe: 'Lock',
  'Dërgo mesazh': 'Send message',
  Rinis: 'Restart',
  Fik: 'Shut down',
  'u kyç.': 'locked.',
  'u zhbllokua.': 'unlocked.',
  'mesazhi u dërgua.': 'message sent.',
  'po rinisët.': 'restarting.',
  'po fiket.': 'shutting down.',
  'Fiket {name}? Përdoruesi humbet punën e pa ruajtur.': 'Shut down {name}? The user will lose unsaved work.',
  'Rinisët {name}? Përdoruesi humbet punën e pa ruajtur.': 'Restart {name}? The user will lose unsaved work.',
  'Po, fike': 'Yes, shut down',
  'Po, rinis': 'Yes, restart',
  'Mesazh · {name}': 'Message · {name}',
  Teksti: 'Text',
  'Sa sekonda shfaqet': 'How long to show it',
  Dërgo: 'Send',
  '10 s': '10 s',
  '20 s': '20 s',
  '1 min': '1 min',
  'Hiq kohë': 'Remove time',
  'U hoqën te {n}; dështuan {m}.': 'Removed on {n}; {m} failed.',
  'U hoqën {min} min te {n} PC.': 'Removed {min} min on {n} PC.',
  'Duke hequr…': 'Removing…',
  'Hiq {min} min nga {n} PC': 'Remove {min} min from {n} PC',
  Minuta: 'Minutes',
  'Minutat hiqen nga koha e mbetur. Nuk kthehen para.': 'Minutes come off the remaining time. No money is refunded.',
  'U ndaluan {n}; dështuan {m}.': 'Stopped {n}; {m} failed.',
  'U ndaluan {n} PC.': 'Stopped {n} PC.',
  'Po, ndalo': 'Yes, stop',
  'Ndalo ({n})': 'Stop ({n})',
  // Shared bits
  Mbyll: 'Close',
  'Provo përsëri': 'Try again',
  'Pa lidhje me serverin.': 'No connection to the server.',
};
