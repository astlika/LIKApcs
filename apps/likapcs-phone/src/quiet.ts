/** Quiet hours on this phone: in-app sounds and vibration stop until the time runs out. Stored on the device only. */
const KEY = 'likapcs-quiet-until';

export function quietUntil(): number {
  try {
    return Number(localStorage.getItem(KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}

export function isQuiet(): boolean {
  return Date.now() < quietUntil();
}

/** `hours` = 0 turns the quiet time off. */
export function setQuietHours(hours: number): void {
  try {
    if (hours > 0) localStorage.setItem(KEY, String(Date.now() + hours * 3_600_000));
    else localStorage.removeItem(KEY);
  } catch {
    // Private mode: the choice lasts for this visit only.
  }
}
