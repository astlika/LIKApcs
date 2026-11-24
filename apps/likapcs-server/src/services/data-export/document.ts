/**
 * The two files of «Skedar për AI». The same blocks — facts, notes and tables of rows — go into
 * a JSON file and into a text file, written as the data is read: a year of sales never sits in
 * memory, and both files always hold exactly the same figures.
 *
 * JSON: one object; a table is an array with one row per line, a row is an object whose keys are
 * the column names (empty values are left out). Text: the same tables as `a | b | c` lines under
 * a line that names the columns; the rows that belong to a row (the lines of a sale) follow it,
 * indented, each starting with what it is.
 */
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import type { DataExportLanguage } from '@likapcs/shared';

export type Lang = DataExportLanguage;
export interface Label {
  sq: string;
  en: string;
}
export const l = (sq: string, en: string): Label => ({ sq, en });

export type Raw = string | number | boolean | null | undefined;
/**
 * How a value is stored and shown:
 *  • money   — integer cents              → 12.5 / "12.50"
 *  • mills   — thousandths of the currency → 0.333 / "0.333"
 *  • qty     — thousandths of a unit       → 1.5 / "1.5"
 *  • percent — basis points                → 12.34 / "12.34 %"
 *  • int, bool, text as they are
 */
export type Kind = 'text' | 'money' | 'mills' | 'qty' | 'int' | 'percent' | 'bool';

export interface Column<R> {
  label: Label;
  kind?: Kind;
  get: (row: R) => Raw;
  /** Left out of the text row unless it has a value (then appended as "; Name: value"). */
  optional?: boolean;
}

export interface ChildTable<R, C> {
  /** Key of the nested array in JSON ("Artikujt"). */
  title: Label;
  /** What one row is, at the start of its text line ("artikull"). */
  tag: Label;
  rows: (row: R) => readonly C[];
  columns: Column<C>[];
}

/** A child table whose row type is hidden from the parent (a list of them mixes row types). */
export interface AnyChildTable<R> {
  title: Label;
  tag: Label;
  render: (row: R, lang: Lang) => { json: Record<string, unknown>[]; text: string[] } | null;
  header: (lang: Lang) => string;
}

export interface TableSpec<R> {
  title: Label;
  /** One line under the title that says what the rows are. */
  note?: Label;
  columns: Column<R>[];
  children?: AnyChildTable<R>[];
}

export interface Fact {
  label: Label;
  kind?: Kind;
  value: Raw;
}

const WORDS = {
  yes: l('po', 'yes'),
  no: l('jo', 'no'),
  columns: l('Kolonat', 'Columns'),
  rows: l('Rreshta', 'Rows'),
  none: l('(asnjë)', '(none)'),
};

const isEmpty = (v: Raw): v is null | undefined | '' =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

/** Removes the trailing zeros of a fixed-point number: "1.500" → "1.5", "2.000" → "2". */
function trimZeros(fixed: string): string {
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
}

/** The value as it stands in JSON; `undefined` = leave the key out. */
export function jsonValue(kind: Kind, raw: Raw): string | number | boolean | undefined {
  if (isEmpty(raw)) return undefined;
  switch (kind) {
    case 'money':
      return Number((Number(raw) / 100).toFixed(2));
    case 'mills':
      return Number((Number(raw) / 1000).toFixed(3));
    case 'qty':
      return Number((Number(raw) / 1000).toFixed(3));
    case 'percent':
      return Number((Number(raw) / 100).toFixed(2));
    case 'int':
      return Math.round(Number(raw));
    case 'bool':
      return Boolean(raw);
    default:
      return String(raw).trim();
  }
}

/** The value as it stands in the text file; '' = nothing to show. */
export function textValue(kind: Kind, raw: Raw, lang: Lang): string {
  if (isEmpty(raw)) return '';
  switch (kind) {
    case 'money':
      return (Number(raw) / 100).toFixed(2);
    case 'mills': {
      // At least two decimals (a price), the third only when it is there.
      const fixed = (Number(raw) / 1000).toFixed(3);
      return fixed.endsWith('0') ? fixed.slice(0, -1) : fixed;
    }
    case 'qty':
      return trimZeros((Number(raw) / 1000).toFixed(3));
    case 'percent':
      return `${(Number(raw) / 100).toFixed(2)} %`;
    case 'int':
      return String(Math.round(Number(raw)));
    case 'bool':
      return raw ? WORDS.yes[lang] : WORDS.no[lang];
    default:
      // One row is one line, and `|` separates the columns.
      return String(raw)
        .trim()
        .replace(/\s*[\r\n]+\s*/g, ' / ')
        .replace(/\t/g, ' ')
        .replace(/\|/g, '/');
  }
}

/** Builds the JSON object and the text line of one row from its columns. */
export function renderRow<R>(
  columns: readonly Column<R>[],
  row: R,
  lang: Lang,
): { json: Record<string, unknown>; text: string } {
  const json: Record<string, unknown> = {};
  const fixed: string[] = [];
  const extra: string[] = [];
  for (const column of columns) {
    const kind = column.kind ?? 'text';
    const raw = column.get(row);
    const name = column.label[lang];
    const value = jsonValue(kind, raw);
    if (value !== undefined) json[name] = value;
    const text = textValue(kind, raw, lang);
    if (column.optional) {
      if (text !== '') extra.push(`${name}: ${text}`);
    } else {
      fixed.push(text === '' ? '-' : text);
    }
  }
  return { json, text: [fixed.join(' | '), ...extra].join(' ; ') };
}

const headerOf = <R>(columns: readonly Column<R>[], lang: Lang): string =>
  columns
    .filter((c) => !c.optional)
    .map((c) => c.label[lang])
    .join(' | ');

/** Wraps a typed child table so that tables of different row types fit in one list. */
export function child<R, C>(spec: ChildTable<R, C>): AnyChildTable<R> {
  return {
    title: spec.title,
    tag: spec.tag,
    header: (lang) => headerOf(spec.columns, lang),
    render: (row, lang) => {
      const rows = spec.rows(row);
      if (rows.length === 0) return null;
      const json: Record<string, unknown>[] = [];
      const text: string[] = [];
      for (const item of rows) {
        const rendered = renderRow(spec.columns, item, lang);
        json.push(rendered.json);
        text.push(rendered.text);
      }
      return { json, text };
    },
  };
}

/**
 * One output file: text is gathered into pieces of about 64 kB, written with back-pressure, and
 * hashed on the way, so the size and the checksum are known the moment it is closed.
 */
export class FileSink {
  private readonly stream: fs.WriteStream;
  private readonly hash = crypto.createHash('sha256');
  private parts: string[] = [];
  private pending = 0;
  private failure: Error | null = null;
  bytes = 0;

  constructor(readonly path: string) {
    this.stream = fs.createWriteStream(path, { flags: 'w' });
    this.stream.on('error', (err) => {
      this.failure = err;
    });
  }

  async write(text: string): Promise<void> {
    this.parts.push(text);
    this.pending += text.length;
    if (this.pending >= 64 * 1024) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.pending === 0) return;
    const chunk = Buffer.from(this.parts.join(''), 'utf8');
    this.parts = [];
    this.pending = 0;
    this.hash.update(chunk);
    this.bytes += chunk.length;
    if (!this.stream.write(chunk)) await once(this.stream, 'drain');
    if (this.failure) throw this.failure;
  }

  async close(): Promise<{ bytes: number; sha256: string }> {
    await this.flush();
    // Wait until the file itself is closed, not only until the last piece went out: it is
    // renamed right after, and Windows may refuse to rename a file that is still open.
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.once('close', () => resolve());
      this.stream.end();
    });
    if (this.failure) throw this.failure;
    return { bytes: this.bytes, sha256: this.hash.digest('hex') };
  }

  /**
   * Stops writing after a failure or a cancel and waits until the file is closed: only then
   * can the half-written file be removed everywhere (Windows keeps an open file in its folder).
   */
  async abort(): Promise<void> {
    if (this.stream.closed) return;
    await new Promise<void>((resolve) => {
      this.stream.once('close', () => resolve());
      this.stream.destroy();
    });
  }
}

/** The document both files are made from. Blocks are written in the order they are called. */
export class ExportDocument {
  /** Per open JSON object: has it got a member yet (the next one needs a comma). */
  private readonly members: boolean[] = [false];

  constructor(
    readonly lang: Lang,
    private readonly json: FileSink | null,
    private readonly txt: FileSink | null,
  ) {}

  private get indent(): string {
    return '  '.repeat(this.members.length);
  }

  /** Starts a member of the open JSON object: comma, new line, indent, `"key": `. */
  private async key(name: string): Promise<void> {
    if (!this.json) return;
    const at = this.members.length - 1;
    const comma = this.members[at] ? ',' : '';
    this.members[at] = true;
    await this.json.write(`${comma}\n${this.indent}${JSON.stringify(name)}: `);
  }

  private async pretty(name: string, value: unknown): Promise<void> {
    if (!this.json) return;
    await this.key(name);
    const text = JSON.stringify(value, null, 2).replace(/\n/g, `\n${this.indent}`);
    await this.json.write(text);
  }

  async begin(textTitle: string[]): Promise<void> {
    if (this.json) await this.json.write('{');
    // A byte-order mark: Notepad on an older Windows shows ë and ç right only with it.
    if (this.txt) await this.txt.write(`\uFEFF${textTitle.join('\n')}\n`);
  }

  /** A part with blocks of its own (the summary). JSON: a nested object. */
  async beginGroup(title: Label): Promise<void> {
    const name = title[this.lang];
    if (this.json) {
      await this.key(name);
      await this.json.write('{');
      this.members.push(false);
    }
    if (this.txt) {
      const bar = '='.repeat(Math.max(8, 30 - Math.floor(name.length / 2)));
      await this.txt.write(`\n\n${bar} ${name.toUpperCase()} ${bar}\n`);
    }
  }

  async endGroup(): Promise<void> {
    if (this.json) {
      const had = this.members.pop();
      await this.json.write(had ? `\n${this.indent}}` : '}');
    }
  }

  /** Named figures: `"Qarkullimi": 1234.5` / `Qarkullimi: 1234.50`. Empty ones are left out. */
  async facts(title: Label, facts: readonly Fact[]): Promise<void> {
    const name = title[this.lang];
    const json: Record<string, unknown> = {};
    const lines: string[] = [];
    for (const fact of facts) {
      const kind = fact.kind ?? 'text';
      const value = jsonValue(kind, fact.value);
      if (value === undefined) continue;
      json[fact.label[this.lang]] = value;
      lines.push(`  ${fact.label[this.lang]}: ${textValue(kind, fact.value, this.lang)}`);
    }
    await this.pretty(name, json);
    if (this.txt) await this.txt.write(`\n--- ${name} ---\n${lines.join('\n')}\n`);
  }

  /** Sentences for the reader (the guide). JSON: an array of strings. */
  async note(title: Label, lines: readonly string[]): Promise<void> {
    const name = title[this.lang];
    await this.pretty(name, lines);
    if (this.txt) {
      await this.txt.write(`\n--- ${name} ---\n${lines.map((line) => `- ${line}`).join('\n')}\n`);
    }
  }

  /**
   * A table of rows, written batch by batch. `onRows` is told after every batch how many rows
   * went out (the loading bar). Returns the number of rows.
   */
  async table<R>(
    spec: TableSpec<R>,
    batches: AsyncIterable<readonly R[]> | Iterable<readonly R[]>,
    onRows?: (rows: number) => void,
  ): Promise<number> {
    const lang = this.lang;
    const name = spec.title[lang];
    const children = spec.children ?? [];
    if (this.json) {
      await this.key(name);
      await this.json.write('[');
    }
    if (this.txt) {
      const head = [`\n--- ${name} ---`];
      if (spec.note) head.push(spec.note[lang]);
      head.push(`${WORDS.columns[lang]}: ${headerOf(spec.columns, lang)}`);
      for (const c of children) head.push(`    ${c.tag[lang]}: ${c.header(lang)}`);
      await this.txt.write(`${head.join('\n')}\n`);
    }
    const rowIndent = `${this.indent}  `;
    let count = 0;
    for await (const batch of batches) {
      let jsonOut = '';
      let textOut = '';
      for (const row of batch) {
        const rendered = renderRow(spec.columns, row, lang);
        const nested: string[] = [];
        for (const c of children) {
          const part = c.render(row, lang);
          if (!part) continue;
          rendered.json[c.title[lang]] = part.json;
          for (const line of part.text) nested.push(`    ${c.tag[lang]}: ${line}`);
        }
        if (this.json) {
          jsonOut += `${count === 0 ? '' : ','}\n${rowIndent}${JSON.stringify(rendered.json)}`;
        }
        if (this.txt) {
          textOut += `${rendered.text}\n`;
          if (nested.length > 0) textOut += `${nested.join('\n')}\n`;
        }
        count += 1;
      }
      if (this.json && jsonOut) await this.json.write(jsonOut);
      if (this.txt && textOut) await this.txt.write(textOut);
      onRows?.(batch.length);
    }
    if (this.json) await this.json.write(count === 0 ? ']' : `\n${this.indent}]`);
    if (this.txt) {
      await this.txt.write(
        count === 0 ? `${WORDS.none[lang]}\n` : `(${WORDS.rows[lang]}: ${count})\n`,
      );
    }
    return count;
  }

  async end(): Promise<void> {
    if (this.json) await this.json.write('\n}\n');
  }
}
