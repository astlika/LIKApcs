/**
 * Words of «Skedar për AI» in Albanian and English: the names the program's own values get in
 * the file (a payment method, the status of a sale, the kind of a stock movement) and the guide
 * at the top that tells the reader — an AI — how to read it. The Albanian words are those of the
 * Admin's screens, so the answers use the words the owner sees every day.
 */
import type { DataExportPart } from '@likapcs/shared';
import { l, type Label, type Lang } from './document.js';

/** Values the database stores as codes, by where they are used. An unknown code is shown as it is. */
export const VALUES = {
  saleStatus: {
    suspended: l('Parkuar', 'Parked'),
    completed: l('Përfunduar', 'Completed'),
    partially_refunded: l('Pjesërisht e rimbursuar', 'Partially refunded'),
    refunded: l('Rimbursuar', 'Refunded'),
    void: l('Anuluar', 'Void'),
  },
  saleSource: {
    retail: l('Dyqan', 'Shop'),
    gaming: l('Lojëra', 'Gaming'),
    mixed: l('Përzier', 'Mixed'),
  },
  method: {
    cash: l('Para në dorë', 'Cash'),
    card: l('Kartë', 'Card'),
    bank_transfer: l('Transfertë bankare', 'Bank transfer'),
    wallet: l('Balanca', 'Customer balance'),
    credit: l('Borxh', 'On credit'),
    other: l('Tjetër', 'Other'),
    staff: l('Stafi', 'Staff'),
  },
  refundKind: {
    refund: l('Rimbursim', 'Refund'),
    price_adjustment: l('Ndryshim çmimi', 'Price adjustment'),
  },
  sessionStatus: {
    active: l('Aktive', 'Active'),
    paused: l('Në pauzë', 'Paused'),
    completed: l('Përfunduar', 'Completed'),
    cancelled: l('Anuluar', 'Cancelled'),
    expired: l('Skaduar', 'Expired'),
  },
  billingMode: {
    prepaid: l('Parapagim', 'Prepaid'),
    postpaid: l('Kohë e hapur', 'Open time'),
    endpay: l('Pagesë në fund', 'Pay at the end'),
  },
  endReason: {
    expired: l('Mbaroi koha', 'Time ran out'),
    stopped_by_staff: l('Ndalur nga stafi', 'Stopped by staff'),
    cancelled: l('Anuluar', 'Cancelled'),
    transferred: l('Zhvendosur në PC tjetër', 'Moved to another PC'),
    server_recovery: l('Mbyllur pas rinisjes së serverit', 'Closed after a server restart'),
  },
  sessionEvent: {
    paused: l('Pauzë', 'Paused'),
    resumed: l('Vazhdim', 'Resumed'),
    extended: l('Shtim kohe', 'Time added'),
    discount_applied: l('Zbritje', 'Discount'),
    correction: l('Korrigjim', 'Correction'),
    transferred_out: l('Zhvendosur në PC tjetër', 'Moved to another PC'),
    transferred_in: l('Ardhur nga PC tjetër', 'Came from another PC'),
    cancelled: l('Anulim', 'Cancelled'),
  },
  correctionKind: {
    time_removed: l('kohë e hequr', 'time removed'),
    price_adjusted: l('çmim i ndryshuar', 'price changed'),
    paid_while_running: l('paguar gjatë seancës', 'paid while running'),
    customer_changed: l('klienti u ndryshua', 'customer changed'),
  },
  pausedBy: {
    staff: l('stafi', 'staff'),
    customer: l('klienti', 'customer'),
    grace: l('PC-ja doli nga rrjeti', 'the PC went offline'),
  },
  cashMovement: {
    opening: l('Gjendja fillestare', 'Opening float'),
    sale: l('Shitje', 'Sale'),
    refund: l('Kthim', 'Refund'),
    deposit: l('Hyrje', 'Cash in'),
    withdrawal: l('Dalje', 'Cash out'),
    expense: l('Shpenzim', 'Expense'),
    supplier_payment: l('Pagesë furnitori', 'Supplier payment'),
    wallet_topup: l('Mbushje balance', 'Balance top-up'),
    wallet_refund: l('Kthim nga balanca', 'Balance paid back'),
    customer_payment: l('Pagesë klienti', 'Customer payment'),
    correction: l('Korrigjim', 'Correction'),
  },
  shiftStatus: {
    open: l('I hapur', 'Open'),
    closed: l('I mbyllur', 'Closed'),
  },
  stockMovement: {
    purchase_receipt: l('Blerje', 'Purchase received'),
    purchase_return: l('Kthim blerjeje', 'Purchase return'),
    sale: l('Shitje', 'Sale'),
    sale_return: l('Rimbursim', 'Sale return'),
    adjustment: l('Rregullim', 'Adjustment'),
    stock_count: l('Numërim stoku', 'Stock count'),
    damaged: l('Dëmtuar', 'Damaged'),
    expired: l('Skaduar', 'Expired'),
    missing: l('Mungesë', 'Missing'),
    transfer: l('Transferim', 'Transfer'),
    initial: l('Stoku fillestar', 'Opening stock'),
    staff_out: l('Blerje stafi', 'Staff purchase'),
    codes_loaded: l('Kode interneti të shtuara', 'Internet codes added'),
    codes_removed: l('Kode interneti të hequra', 'Internet codes removed'),
  },
  stockCountStatus: {
    open: l('I hapur', 'Open'),
    completed: l('Përfunduar', 'Completed'),
    cancelled: l('Anuluar', 'Cancelled'),
  },
  purchaseStatus: {
    draft: l('Draft', 'Draft'),
    ordered: l('Porositur', 'Ordered'),
    partially_received: l('Pranuar pjesërisht', 'Partially received'),
    received: l('Pranuar', 'Received'),
    cancelled: l('Anuluar', 'Cancelled'),
  },
  paymentStatus: {
    unpaid: l('Papaguar', 'Unpaid'),
    partial: l('Paguar pjesërisht', 'Partly paid'),
    paid: l('Paguar', 'Paid'),
  },
  returnStatus: {
    completed: l('Përfunduar', 'Completed'),
    cancelled: l('Anuluar', 'Cancelled'),
  },
  debtStatus: {
    open: l('I hapur', 'Open'),
    partial: l('Pjesërisht i paguar', 'Partly paid'),
    paid: l('I paguar', 'Paid'),
    written_off: l('I falur', 'Written off'),
  },
  ledgerEntry: {
    wallet_topup: l('Mbushje balance', 'Balance top-up'),
    wallet_payment: l('Pagesë nga balanca', 'Paid from the balance'),
    wallet_refund: l('Kthim në balancë', 'Refund to the balance'),
    wallet_withdrawal: l('Kthim nga balanca', 'Balance paid back'),
    credit_sale: l('Shitje me borxh', 'Sale on credit'),
    credit_payment: l('Pagesë borxhi', 'Debt payment'),
    points_earned: l('Pikë të fituara', 'Points earned'),
    points_redeemed: l('Pikë të përdorura', 'Points used'),
    adjustment: l('Rregullim', 'Adjustment'),
  },
  customerStatus: {
    active: l('Aktiv', 'Active'),
    blocked: l('I bllokuar', 'Blocked'),
    archived: l('I arkivuar', 'Archived'),
  },
  invoiceKind: {
    receipt: l('Kupon', 'Receipt'),
    invoice: l('Faturë', 'Invoice'),
  },
  invoiceStatus: {
    issued: l('E lëshuar', 'Issued'),
    void: l('E anuluar', 'Void'),
  },
  reservationStatus: {
    scheduled: l('E planifikuar', 'Scheduled'),
    active: l('Pret klientin', 'Waiting for the customer'),
    completed: l('Përfunduar', 'Completed'),
    expired: l('Skaduar', 'Expired'),
    cancelled: l('Anuluar', 'Cancelled'),
  },
  orderStatus: {
    pending: l('Në pritje', 'Pending'),
    accepted: l('Në llogari', 'On the bill'),
    paid: l('Paguar', 'Paid'),
    billed: l('Faturuar', 'Billed'),
    rejected: l('Refuzuar', 'Rejected'),
    cancelled: l('Tërhequr', 'Withdrawn'),
    void: l('Anuluar', 'Void'),
  },
  orderSettlement: {
    pay_now: l('Paguaj tani', 'Pay now'),
    on_bill: l('Në llogari', 'On the bill'),
  },
  productKind: {
    standard: l('Produkt', 'Product'),
    internet_access: l('Kod interneti', 'Internet access code'),
  },
  /** Not stored: worked out from the stock, the minimum and "stock is tracked" (see `stockStatus`). */
  stockStatus: {
    in: l('Ka stok', 'In stock'),
    low: l('Stok i ulët', 'Low stock'),
    out: l('Pa stok', 'Out of stock'),
    untracked: l('Stoku nuk ndiqet', 'Stock not tracked'),
  },
  severity: {
    info: l('info', 'info'),
    warning: l('kujdes', 'warning'),
    critical: l('kritike', 'critical'),
  },
  role: {
    owner: l('Pronar', 'Owner'),
    admin: l('Administrator', 'Administrator'),
    manager: l('Menaxher', 'Manager'),
    cashier: l('Arkëtar', 'Cashier'),
    inventory: l('Magazinier', 'Inventory'),
    accountant: l('Kontabilist', 'Accountant'),
  },
  weekday: {
    '1': l('Hën', 'Mon'),
    '2': l('Mar', 'Tue'),
    '3': l('Mër', 'Wed'),
    '4': l('Enj', 'Thu'),
    '5': l('Pre', 'Fri'),
    '6': l('Sht', 'Sat'),
    '7': l('Die', 'Sun'),
    '0': l('Die', 'Sun'),
  },
} as const satisfies Record<string, Record<string, Label>>;

export type ValueDomain = keyof typeof VALUES;

/** The file's word for a stored code; the code itself when the program has a newer one. */
export function valueOf(domain: ValueDomain, code: string | null | undefined, lang: Lang): string {
  if (code === null || code === undefined || code === '') return '';
  const table: Record<string, Label> = VALUES[domain];
  return table[code]?.[lang] ?? code;
}

/** Names of the parts the owner can leave out (shown in the guide when one is missing). */
export const PART_NAMES: Record<DataExportPart, Label> = {
  sales: l('shitjet dhe kthimet', 'sales and refunds'),
  gaming: l(
    'seancat e PC-ve, koha e paguar, rezervimet dhe porositë nga PC-të',
    'PC sessions, paid time, reservations and orders from the PCs',
  ),
  cash: l(
    'arka (turnet, hyrjet dhe daljet) dhe shpenzimet',
    'the till (shifts, cash in and out) and expenses',
  ),
  stock: l('lëvizjet dhe numërimet e stokut', 'stock movements and stock counts'),
  purchases: l(
    'blerjet nga furnitorët dhe blerjet e stafit',
    'purchases from suppliers and staff purchases',
  ),
  customers: l('borxhet, lëvizjet e balancës dhe faturat', 'debts, balance movements and invoices'),
  lists: l(
    'listat (produktet, ofertat, çmimet, PC-të, klientët, furnitorët, punonjësit)',
    'the lists (products, offers, prices, PCs, customers, suppliers, staff)',
  ),
  audit: l('regjistri i veprimeve', 'the action log'),
};

export interface GuideInput {
  lang: Lang;
  business: string;
  from: string;
  to: string;
  wholeHistory: boolean;
  timeZone: string;
  currency: string;
  hideCustomers: boolean;
  missingParts: DataExportPart[];
}

/** The sentences at the top of the file that tell the reader how to read it. */
export function guide(input: GuideInput): string[] {
  const { lang, business, from, to, timeZone, currency } = input;
  const missing = input.missingParts.map((part) => PART_NAMES[part][lang]).join('; ');
  if (lang === 'en') {
    return [
      `This file holds the business data of "${business}" from the program LIKApcs (a gaming centre: PCs rented by the minute, and a shop at the desk).`,
      input.wholeHistory
        ? `It covers the whole history: ${from} to ${to}, both days included.`
        : `It covers ${from} to ${to}, both days included.`,
      `Times are local (${timeZone}), written YYYY-MM-DD HH:MM. Amounts are in ${currency}; quantities can have decimals.`,
      'The part "Summary" holds totals the program calculated itself, the same figures its Reports page shows. Use them for any question about totals; the detailed tables are for closer questions.',
      'Turnover = what customers were charged, VAT included, after refunds. Revenue = turnover without VAT. Gross profit = revenue − cost of the goods sold. Net profit = gross profit − expenses − stock losses. Stock bought is not a cost on the day it is bought; it becomes one when it is sold.',
      'Sales: only sales with the status Completed, Partially refunded or Refunded count in the totals; a Void sale is listed but not counted. "Discount" on a sale is the discount on the whole bill; a discount on one line is on that line.',
      'PC sessions are paid through sales: the column "Receipt" links a session to its sale. A session without a receipt is not paid yet, cost nothing, or used time that was bought earlier.',
      'A customer who plays can take products that go on the PC\'s bill and are paid later, with the bill. On the line of such a product, "Put on the PC\'s bill" is the time the product was taken; the time of the sale is when the bill was paid.',
      'Cash movements are the notes and coins that went into the drawer (+) and out of it (−). Card and bank payments do not pass through the drawer.',
      'Stock movements: a quantity with + came in, with − went out.',
      'Products: in the Summary, the table "By product" has the sales and the profit of every product in the period (a product that did not sell is there with 0), and the table "Stock now by product" says for every product whether it is in stock, and how much. Stock is always that of the moment the file was made, not of the end of the period.',
      'Turnover by product is before discounts given on a whole bill, so the products can add up to slightly more than the turnover. The daily figures can differ from the totals by a few cents because of rounding.',
      'The lists (products, customers, staff …) and the part "Now" show the state at the moment the file was made, not at the end of the period.',
      input.hideCustomers
        ? 'Customer names, phone numbers and notes were left out: every customer appears by the customer code. Reasons and descriptions the staff typed by hand are as they wrote them.'
        : 'Customers appear by name; the customer code tells two customers with the same name apart.',
      'The file never holds passwords, PIN codes, internet access codes, keys, pictures or network addresses.',
      ...(missing ? [`Left out of this file on purpose: ${missing}.`] : []),
    ];
  }
  return [
    `Ky skedar përmban të dhënat e biznesit «${business}» nga programi LIKApcs (qendër lojërash: PC që jepen me minuta, dhe shitje në banak).`,
    input.wholeHistory
      ? `Mbulon gjithë historinë: nga ${from} deri më ${to}, të dyja ditët përfshihen.`
      : `Mbulon periudhën nga ${from} deri më ${to}, të dyja ditët përfshihen.`,
    `Orët janë lokale (${timeZone}), të shkruara VVVV-MM-DD OO:MM. Shumat janë në ${currency}; sasitë mund të kenë presje dhjetore.`,
    'Pjesa «Përmbledhje» ka totalet që i ka llogaritur vetë programi, të njëjtat shifra që shfaqen te faqja Raportet. Për çdo pyetje mbi totale përdorni ato; tabelat e detajuara janë për pyetje më të hollësishme.',
    'Qarkullimi = sa u është faturuar klientëve, me TVSH, pas kthimeve. Të ardhura = qarkullimi pa TVSH. Fitimi bruto = të ardhurat − kostoja e mallit të shitur. Fitimi neto = fitimi bruto − shpenzimet operative − humbjet e stokut. Malli i blerë nuk është kosto ditën që blihet; bëhet kosto kur shitet.',
    'Shitjet: te totalet numërohen vetëm shitjet me status Përfunduar, Pjesërisht e rimbursuar ose Rimbursuar; një shitje e Anuluar është në listë, por nuk numërohet. «Zbritja» te një shitje është zbritja mbi gjithë faturën; zbritja e një rreshti është te ai rresht.',
    'Seancat e PC-ve paguhen përmes shitjeve: kolona «Fatura» e lidh seancën me shitjen e saj. Një seancë pa faturë ose nuk është paguar ende, ose nuk kushtoi asgjë, ose përdori kohë të blerë më parë.',
    'Klienti që luan mund të marrë produkte që shkojnë te fatura e PC-së dhe paguhen më vonë, bashkë me faturën. Te rreshti i një produkti të tillë, «Shtuar në faturën e PC-së» është ora kur u mor produkti; ora e shitjes është kur u pagua fatura.',
    'Lëvizjet e arkës janë paratë në dorë që hynë në arkë (+) dhe që dolën prej saj (−). Pagesat me kartë dhe me bankë nuk kalojnë nëpër arkë.',
    'Lëvizjet e stokut: sasia me + është hyrje malli, me − është dalje.',
    'Produktet: te Përmbledhja, tabela «Sipas produktit» ka shitjen dhe fitimin e çdo produkti në periudhë (produkti që nuk u shit është aty me 0), dhe tabela «Stoku tani sipas produktit» tregon për çdo produkt a ka stok dhe sa. Stoku është gjithmonë ai i çastit kur u bë skedari, jo i fundit të periudhës.',
    'Qarkullimi sipas produktit është para zbritjeve të dhëna mbi gjithë faturën, prandaj shuma e produkteve mund të dalë pak më e madhe se qarkullimi. Shifrat sipas ditës mund të ndryshojnë nga totalet për disa cent, për shkak të rrumbullakimit.',
    'Listat (produktet, klientët, punonjësit …) dhe pjesa «Gjendja tani» tregojnë gjendjen në çastin kur u bë skedari, jo në fund të periudhës.',
    input.hideCustomers
      ? 'Emrat, telefonat dhe shënimet e klientëve janë lënë jashtë: çdo klient shfaqet me kodin e tij. Arsyet dhe përshkrimet që stafi i ka shkruar me dorë janë siç i kanë shkruar.'
      : 'Klientët shfaqen me emër; kodi i klientit i dallon dy klientë me emër të njëjtë.',
    'Skedari nuk përmban asnjëherë fjalëkalime, kode PIN, kode interneti, çelësa, foto apo adresa rrjeti.',
    ...(missing ? [`Me qëllim janë lënë jashtë këtij skedari: ${missing}.`] : []),
  ];
}
