/**
 * Internet access codes (0.34.0): Wi-Fi vouchers sold at the till as products. The codes come from
 * the shop's own hotspot system and are loaded by pasting them, one per line. This is the one
 * place that decides what a code is, so the Admin's preview and the server agree on every paste.
 */

/** The shortest and the longest code. Shorter pieces of a paste are list numbers, not codes. */
export const ACCESS_CODE_MIN_LENGTH = 4;
export const ACCESS_CODE_MAX_LENGTH = 64;
/** How many codes one paste may hold. */
export const ACCESS_CODES_MAX_PER_LOAD = 5000;

/** One code: 4–64 visible characters, without spaces, commas or semicolons. Case matters. */
export const ACCESS_CODE_PATTERN = /^[^\s,;\p{Cc}\p{Cf}]{4,64}$/u;

export const isAccessCode = (value: string): boolean => ACCESS_CODE_PATTERN.test(value);

export interface ParsedAccessCodes {
  /** The codes to load, in the order they were pasted, each one once. */
  codes: string[];
  /** Codes that appeared more than once in the paste (each listed once); the copies are dropped. */
  repeated: string[];
  /** Pieces that are not a code (too short, too long); they are left out. */
  invalid: string[];
  /** How many pieces the paste held (codes, repeats and invalid ones). */
  pieces: number;
}

const LIST_NUMBER = /^\d+[.):]$/;

// Characters that travel with text copied from a document and cannot be seen: zero-width
// spaces and joiners, the byte-order mark, the soft hyphen.
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;

/**
 * Reads a paste: one code per line is the usual form, but several on one line — separated by
 * spaces, tabs, commas or semicolons, as a spreadsheet copies them — are read the same way.
 * Quotes around a code (a CSV export) are dropped, and the numbers of a numbered list ("12.")
 * are left out. Nothing is changed inside a code.
 */
export function parseAccessCodes(text: string): ParsedAccessCodes {
  const seen = new Set<string>();
  const repeatedSeen = new Set<string>();
  const invalidSeen = new Set<string>();
  const codes: string[] = [];
  let pieces = 0;
  for (const raw of text.replace(INVISIBLE, '').split(/[\s,;]+/u)) {
    const piece = raw.replace(/^["'`]+|["'`]+$/g, '');
    if (!piece) continue;
    pieces += 1;
    // "12." / "12)" / "12:" in front of a code is the number of a list, not a code.
    if (LIST_NUMBER.test(piece) || !isAccessCode(piece)) {
      invalidSeen.add(piece.length > 80 ? `${piece.slice(0, 77)}…` : piece);
      continue;
    }
    if (seen.has(piece)) {
      repeatedSeen.add(piece);
      continue;
    }
    seen.add(piece);
    codes.push(piece);
  }
  return { codes, repeated: [...repeatedSeen], invalid: [...invalidSeen], pieces };
}

/**
 * A package name from what the owner typed as its length: "1h" → "Internet 1h". A text that
 * already names the internet is kept as it is.
 */
export function internetPackageName(label: string): string {
  const text = label.trim().replace(/\s+/g, ' ');
  if (!text) return '';
  return /internet|wi-?fi/i.test(text) ? text : `Internet ${text}`;
}

/** 0.36.0: how many internet packages the quick bar shows — the view stays simple. */
export const INTERNET_BAR_MAX = 4;

/**
 * 0.36.0: which packages are on the quick bar (POS and Stations). The owner's choice
 * (`pos.internet_bar`, in that order) when it names packages that can be sold; otherwise the
 * first ones of the list, so the bar works before anyone set it up. Never more than
 * `INTERNET_BAR_MAX`, and only packages that are active.
 */
export function internetBarIds(
  packages: readonly { id: string; isActive: boolean }[],
  chosen: readonly string[],
): string[] {
  const active = packages.filter((p) => p.isActive);
  const picked = chosen.filter((id) => active.some((p) => p.id === id));
  const ids = picked.length > 0 ? picked : active.map((p) => p.id);
  return [...new Set(ids)].slice(0, INTERNET_BAR_MAX);
}
