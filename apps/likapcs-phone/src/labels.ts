/** Albanian labels shared by the phone screens. */

export const METHOD_LABEL: Record<string, string> = {
  cash: 'Para në dorë',
  card: 'Kartelë',
  bank_transfer: 'Transfer',
  other: 'Tjetër',
  wallet: 'Balanca',
  credit: 'Me borxh',
  staff: 'Staf',
};

export const STATION_LABEL: Record<string, string> = {
  available: 'E lirë',
  occupied: 'E zënë',
  paused: 'Në pauzë',
  locked: 'E kyçur',
  maintenance: 'Mirëmbajtje',
  updating: 'Po përditësohet',
  offline: 'Offline',
  error: 'Gabim',
  disabled: 'Joaktive',
};

export const STATION_TONE: Record<string, 'ok' | 'warn' | 'off'> = {
  available: 'ok',
  occupied: 'ok',
  paused: 'warn',
  locked: 'warn',
  maintenance: 'warn',
  updating: 'warn',
  offline: 'off',
  error: 'off',
  disabled: 'off',
};

export const BILLING_LABEL: Record<string, string> = {
  prepaid: 'Me pagesë paraprake',
  postpaid: 'Pas përdorimit',
  endpay: 'Paguhet në fund',
};
