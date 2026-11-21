/**
 * 0.36.1 — search that does not mind capitals or accents: "cips", "çips" and "ÇIPS" all find
 * "Çips".
 *
 * The database is created with the C locale, where `lower()` and `ILIKE` fold the letters A–Z
 * only. A product named "Çaj" was therefore never found by typing "çaj" — nor by "Çaj", because
 * the server lowered the typed text itself. Here both sides are folded the same way, with nothing
 * that depends on a locale or a collation: `translate()` turns the accented Latin letters into
 * their plain ones and `lower()` does the rest. A letter outside the table behaves as before.
 */
const ACCENTED = 'ÀÁÂÃÄÅàáâãäåÇçĆćČčĐđÈÉÊËèéêëĞğÌÍÎÏİìíîïıÑñÒÓÔÕÖòóôõöŠšŞşÙÚÛÜùúûüÝýÿŽž';
const PLAIN = 'AAAAAAaaaaaaCcCcCcDdEEEEeeeeGgIIIIIiiiiiNnOOOOOoooooSsSsUUUUuuuuYyyZz';

/** The two alphabets, for the test that keeps them the same length (`translate` pairs by position). */
export const FOLD_TABLE = { from: ACCENTED, to: PLAIN } as const;

const PLAIN_OF = new Map<string, string>(
  [...ACCENTED].map((letter, i) => [letter, [...PLAIN][i] ?? letter]),
);

/** Typed text as the database side is folded: accents off, lower case. */
export function foldText(text: string): string {
  let plain = '';
  for (const letter of text.normalize('NFC')) plain += PLAIN_OF.get(letter) ?? letter;
  return plain.toLowerCase();
}

/** The SQL that folds a text expression the way `foldText` folds what was typed. */
export function sqlFold(expression: string): string {
  return `lower(translate(${expression}, '${ACCENTED}', '${PLAIN}'))`;
}
