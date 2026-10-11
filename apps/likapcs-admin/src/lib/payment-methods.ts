/**
 * Payment methods the app offers in its forms. `card` appears only when Settings › Printing ›
 * "Accept card payments" (`pos.card_payments`) is on — a cash-only business never sees the word.
 * The server keeps accepting every method, so switching the setting on needs no migration.
 */
import { PAYMENT_METHODS, type PaymentMethod } from '@likapcs/shared';
import { useAppSettings } from '../state/app-settings';

export function offeredPaymentMethods(cardEnabled: boolean): PaymentMethod[] {
  return cardEnabled ? [...PAYMENT_METHODS] : PAYMENT_METHODS.filter((m) => m !== 'card');
}

export function usePaymentMethods(): { cardEnabled: boolean; methods: PaymentMethod[] } {
  const cardEnabled = useAppSettings()['pos.card_payments'];
  return { cardEnabled, methods: offeredPaymentMethods(cardEnabled) };
}
