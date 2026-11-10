/**
 * A PIN for the phone itself. The PIN is kept on this phone only, as a salted SHA-256 hash.
 * The app locks after a minute in the background or five minutes without a touch. Five wrong PINs
 * sign the account out; the staff then sign in with the password.
 */
import { useEffect, useRef, useState } from 'react';
import { Btn, Notice, Sheet, cx } from './components/ui';
import { useNotify } from './notify';
import { useT } from './i18n';

const KEY = 'likapcs-phone-pin';
const IDLE_MS = 5 * 60_000;
const AWAY_MS = 60_000;
const MAX_TRIES = 5;
const enc = new TextEncoder();

interface StoredPin {
  salt: string;
  hash: string;
}

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** PIN support needs the Web Crypto API: the APK and HTTPS have it, plain http on the LAN may not. */
export const pinSupported = (): boolean => typeof crypto !== 'undefined' && !!crypto.subtle;

async function hashPin(pin: string, salt: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${salt}:${pin}`))));
}

export const hasPin = (): boolean => localStorage.getItem(KEY) !== null;

export async function setPin(pin: string): Promise<void> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const stored: StoredPin = { salt, hash: await hashPin(pin, salt) };
  localStorage.setItem(KEY, JSON.stringify(stored));
}

export const clearPin = (): void => localStorage.removeItem(KEY);

export async function checkPin(pin: string): Promise<boolean> {
  const raw = localStorage.getItem(KEY);
  if (!raw) return false;
  const stored = JSON.parse(raw) as StoredPin;
  return (await hashPin(pin, stored.salt)) === stored.hash;
}

/** The lock screen: mounted once while signed in; it shows only when a PIN is set and the app was away. */
export function PinGate({ onSignOut }: { onSignOut: () => void }) {
  const t = useT();
  const [locked, setLocked] = useState(false);
  const [digits, setDigits] = useState('');
  const [wrong, setWrong] = useState(0);
  const [shake, setShake] = useState(false);
  const lastTouch = useRef(Date.now());
  const hiddenAt = useRef<number | null>(null);
  const lockedRef = useRef(false);
  lockedRef.current = locked;

  useEffect(() => {
    const touch = () => {
      lastTouch.current = Date.now();
    };
    const lockIfSet = () => {
      if (hasPin() && !lockedRef.current) setLocked(true);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      if (hiddenAt.current !== null && Date.now() - hiddenAt.current > AWAY_MS) lockIfSet();
      hiddenAt.current = null;
      touch();
    };
    const idle = window.setInterval(() => {
      if (Date.now() - lastTouch.current > IDLE_MS) lockIfSet();
    }, 15_000);
    window.addEventListener('pointerdown', touch);
    window.addEventListener('keydown', touch);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(idle);
      window.removeEventListener('pointerdown', touch);
      window.removeEventListener('keydown', touch);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  if (!locked) return null;

  const press = async (key: string) => {
    if (key === '⌫') {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    if (digits.length >= 4) return;
    const next = digits + key;
    setDigits(next);
    if (next.length < 4) return;
    if (await checkPin(next)) {
      setLocked(false);
      setDigits('');
      setWrong(0);
      lastTouch.current = Date.now();
      return;
    }
    const tries = wrong + 1;
    setWrong(tries);
    setDigits('');
    setShake(true);
    window.setTimeout(() => setShake(false), 400);
    if (tries >= MAX_TRIES) onSignOut();
  };

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  return (
    <div className="pin-lock" role="dialog" aria-modal="true" aria-label={t('Shkyçja me PIN')}>
      <div className="pin-lock__card">
        <span className="brand-mark brand-mark--sm">LK</span>
        <strong>{t('Shkyçja me PIN')}</strong>
        <div
          className={cx('pin-dots', shake && 'pin-dots--shake')}
          aria-label={`${digits.length}/4`}
        >
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={cx('pin-dot', i < digits.length && 'pin-dot--on')} />
          ))}
        </div>
        {wrong > 0 && (
          <Notice tone="danger">
            {t('PIN i gabuar')} · {t('{n} tentativa të mbetura', { n: MAX_TRIES - wrong })}
          </Notice>
        )}
        <div className="pin-keys">
          {keys.map((k, i) =>
            k === '' ? (
              <span key={i} />
            ) : (
              <button
                key={i}
                type="button"
                className="pin-key"
                onClick={() => void press(k)}
                aria-label={k === '⌫' ? t('Fshi') : k}
              >
                {k}
              </button>
            ),
          )}
        </div>
        <button type="button" className="ghost small-btn" onClick={onSignOut}>
          {t('Dil nga llogaria')}
        </button>
      </div>
    </div>
  );
}

/** Settings: set, change or remove the phone's PIN. */
export function PinSettings() {
  const t = useT();
  const notify = useNotify();
  const [enabled, setEnabled] = useState(hasPin());
  const [open, setOpen] = useState(false);
  const [pin, setPinText] = useState('');
  const [again, setAgain] = useState('');
  const valid = /^\d{4}$/.test(pin) && pin === again;

  return (
    <div className="card">
      <div className="kv">
        <span>{t('PIN i telefonit')}</span>
        <strong>{enabled ? t('Aktiv') : t('Jo')}</strong>
      </div>
      {!pinSupported() && (
        <Notice tone="warn">{t('PIN nuk mbështetet në këtë lidhje (duhet HTTPS ose APK).')}</Notice>
      )}
      {pinSupported() && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Btn onClick={() => setOpen(true)}>{enabled ? t('Ndrysho PIN') : t('Vendos PIN')}</Btn>
          {enabled && (
            <Btn
              variant="danger"
              onClick={() => {
                clearPin();
                setEnabled(false);
                notify(t('PIN-i u hoq.'));
              }}
            >
              {t('Hiq PIN')}
            </Btn>
          )}
        </div>
      )}
      {open && (
        <Sheet
          title={t('Vendos PIN')}
          onClose={() => setOpen(false)}
          footer={
            <Btn
              block
              disabled={!valid}
              onClick={async () => {
                await setPin(pin);
                setEnabled(true);
                setOpen(false);
                setPinText('');
                setAgain('');
                notify(t('PIN-i u vendos.'));
              }}
            >
              {t('Ruaj')}
            </Btn>
          }
        >
          <label className="field">
            <span>{t('PIN (4 shifra)')}</span>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              value={pin}
              onChange={(e) => setPinText(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          <label className="field">
            <span>{t('Konfirmo PIN-in')}</span>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              value={again}
              onChange={(e) => setAgain(e.target.value.replace(/\D/g, ''))}
            />
          </label>
          {again.length === 4 && pin !== again && (
            <Notice tone="danger">{t('PIN-i nuk përputhet')}</Notice>
          )}
        </Sheet>
      )}
    </div>
  );
}
