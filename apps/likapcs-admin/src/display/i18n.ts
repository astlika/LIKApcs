/**
 * Texts of the customer display. Deliberately tiny and separate from the Admin dictionary: the
 * screen speaks the *business* language (`locale.default_language`), not the cashier's UI language.
 */
export type DisplayLanguage = 'en' | 'sq';

const en = {
  welcome: 'Welcome',
  items: 'Items',
  subtotal: 'Subtotal',
  discount: 'Discount',
  total: 'Total',
  toPay: 'To pay',
  paid: 'Paid',
  change: 'Change',
  remaining: 'Remaining',
  onTab: 'On your tab',
  fromBalance: 'From your balance',
  cash: 'Cash',
  customer: 'Customer',
  debt: 'Open debt',
  balance: 'Balance',
  thankYou: 'Thank you!',
  seeYou: 'See you soon',
  receipt: 'Receipt',
  endsIn: 'Ends in',
  waiting: 'Waiting for the register…',
} as const;

const sq: Record<keyof typeof en, string> = {
  welcome: 'Mirë se vini',
  items: 'Artikuj',
  subtotal: 'Nëntotali',
  discount: 'Zbritje',
  total: 'Totali',
  toPay: 'Për të paguar',
  paid: 'Paguar',
  change: 'Kusuri',
  remaining: 'Mbetet',
  onTab: 'Në borxh',
  fromBalance: 'Nga balanca',
  cash: 'Kesh',
  customer: 'Klienti',
  debt: 'Borxh i hapur',
  balance: 'Balanca',
  thankYou: 'Faleminderit!',
  seeYou: 'Mirupafshim',
  receipt: 'Kuponi',
  endsIn: 'Mbaron pas',
  waiting: 'Duke pritur arkën…',
};

export type DisplayTextKey = keyof typeof en;

export function displayText(language: DisplayLanguage, key: DisplayTextKey): string {
  return (language === 'sq' ? sq : en)[key];
}
