/**
 * 0.41.0 — a backup as ONE JSON document (`*.likapcs-backup.json`).
 *
 * The packed archive (`*.likapcs-backup.tar.gz`) and this file hold the same things: the manifest,
 * every table and every uploaded file. Here they are plain text:
 *
 *   {"format":"likapcs-backup-json","formatVersion":1,
 *   "readme":"…",
 *   "manifest":{…},                       the manifest an archive carries too (sizes, checksums)
 *   "tables":[
 *   {"name":"products","columns":["id","name",…],"rows":[
 *   ["0b6f…","Coca-Cola 0.33l",null,…],    one row per line; a value is the text PostgreSQL
 *   …                                      writes for it, null is an empty (NULL) value
 *   ]},
 *   …
 *   ],
 *   "files":[
 *   {"path":"products/aa11.jpg","bytes":180000,"sha256":"…","base64":[
 *   "…",                                   the bytes of the file, in pieces
 *   …
 *   ]},
 *   …
 *   ],
 *   "end":{"tables":71,"rows":15432,"files":87,"fileBytes":2073000,"manifestSha256":"…"}}
 *
 * The whole file is one valid JSON document. It is written one element per line so that it can be
 * read back piece by piece: a file of several gigabytes never has to fit in memory.
 *
 * Exactness. PostgreSQL dumps a table as CSV (the dump a packed archive holds as it is). The rows
 * here are that CSV taken apart, and `csvLine` puts a row together again exactly the way
 * PostgreSQL writes it. So the tables a restore gets out of this file are, byte for byte, the
 * tables of the dump, and the checksums in the manifest — which are those of the dump — prove it:
 * the finished file is read back that way before it counts as written, and a restore checks it
 * again before anything is changed. A table that would not come back identical (it would take a
 * PostgreSQL that writes CSV in another way) is written as the bytes of its CSV instead
 * (`csvBase64`), which is exact by construction.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import {
  BACKUP_JSON_FORMAT,
  BACKUP_JSON_FORMAT_VERSION,
  type BackupManifest,
} from '@likapcs/shared';

/** The file is not a JSON backup this program wrote, or it was cut off or changed. */
export class JsonArchiveError extends Error {
  constructor(
    message: string,
    /** Line of the file the problem was found on (1-based). */
    readonly line: number | null = null,
  ) {
    super(line === null ? message : `${message} (line ${line})`);
    this.name = 'JsonArchiveError';
  }
}

/** Uploaded files are written in pieces of this many bytes (one line of base64 each). */
const FILE_PIECE_BYTES = 48 * 1024;
/** Output is gathered up to this size before it goes to the disk. */
const FLUSH_BYTES = 1024 * 1024;
/** A longer line is not something this program wrote (a row or a file piece is far shorter). */
const MAX_LINE_BYTES = 256 * 1024 * 1024;
/** How much of a file is read to find its manifest (line 3). */
const MAX_HEAD_BYTES = 256 * 1024 * 1024;

const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HEAD_LINE = /^\{"format":"likapcs-backup-json","formatVersion":(\d{1,6}),$/;
/** The beginning of a JSON backup, also when another program has put spaces into it. */
const HEAD_LOOSE = /^\s*\{\s*"format"\s*:\s*"likapcs-backup-json"/;

/** True when the first bytes of a file are those of a JSON backup. */
export function looksLikeJsonArchive(head: Buffer): boolean {
  let text = head.subarray(0, 256).toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return HEAD_LOOSE.test(text);
}

/** True when `file` begins like a JSON backup (only its first bytes are read). */
export async function isJsonArchiveFile(file: string): Promise<boolean> {
  const handle = await fsp.open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(256), 0, 256, 0);
    return looksLikeJsonArchive(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** A path from the file that stays inside the folder it is joined to. */
function isSafeRelativePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\\') || p.includes('\0')) {
    return false;
  }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

// ─── CSV, the way PostgreSQL writes it ───────────────────────────────────────

/** The CSV is not what `COPY … TO STDOUT (FORMAT csv)` writes. */
export class CsvShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvShapeError';
  }
}

/** A table whose CSV could not be taken apart into rows: it has to be written as raw bytes. */
export class JsonTableShapeError extends Error {
  constructor(
    readonly table: string,
    cause: CsvShapeError,
  ) {
    super(`Table "${table}" cannot be written as rows: ${cause.message}`);
    this.name = 'JsonTableShapeError';
  }
}

const QUOTE = 34;
const COMMA = 44;
const LF = 10;
const CR = 13;

/**
 * Takes the CSV of `COPY … TO STDOUT (FORMAT csv)` apart, row by row. An empty value without
 * quotes is NULL (`null`); `""` is the empty text. Text may arrive in pieces of any size.
 */
export class CsvScanner {
  private rest = '';

  constructor(private readonly onRow: (fields: (string | null)[]) => void) {}

  push(text: string): void {
    if (!text) return;
    const data = this.rest ? this.rest + text : text;
    let at = 0;
    for (;;) {
      const next = this.row(data, at);
      if (next < 0) break;
      at = next;
    }
    this.rest = at === 0 ? data : data.slice(at);
  }

  /** Call after the last piece: a row that was never ended is an error. */
  finish(): void {
    if (this.rest.length > 0) throw new CsvShapeError('the last row has no end');
  }

  /** Reads the row that starts at `start`; returns where the next one starts, or -1 for "not all here yet". */
  private row(data: string, start: number): number {
    const n = data.length;
    if (start >= n) return -1;
    const fields: (string | null)[] = [];
    let i = start;
    for (;;) {
      if (i >= n) return -1;
      let value: string | null;
      if (data.charCodeAt(i) === QUOTE) {
        let from = i + 1;
        let out = '';
        for (;;) {
          const q = data.indexOf('"', from);
          // The closing quote, and the character after it, must both be here to tell `""` apart.
          if (q < 0 || q + 1 >= n) return -1;
          if (data.charCodeAt(q + 1) === QUOTE) {
            out += data.slice(from, q + 1);
            from = q + 2;
            continue;
          }
          out += data.slice(from, q);
          i = q + 1;
          break;
        }
        value = out;
      } else {
        let j = i;
        for (; j < n; j += 1) {
          const c = data.charCodeAt(j);
          if (c === COMMA || c === LF || c === CR || c === QUOTE) break;
        }
        if (j >= n) return -1;
        if (data.charCodeAt(j) === QUOTE) {
          throw new CsvShapeError('a quote inside a value that is not quoted');
        }
        value = j === i ? null : data.slice(i, j);
        i = j;
      }
      fields.push(value);
      const c = data.charCodeAt(i);
      if (c === COMMA) {
        i += 1;
        continue;
      }
      if (c === LF) {
        this.onRow(fields);
        return i + 1;
      }
      if (c === CR) {
        if (i + 1 >= n) return -1;
        if (data.charCodeAt(i + 1) !== LF)
          throw new CsvShapeError('a line end that is not a line end');
        this.onRow(fields);
        return i + 2;
      }
      throw new CsvShapeError('text after the closing quote of a value');
    }
  }
}

const NEEDS_QUOTES = /[",\n\r]/;

/**
 * One row as `COPY … TO STDOUT (FORMAT csv)` writes it, line end included: NULL is nothing, the
 * empty text is `""`, a value with a comma, a quote or a line break is quoted (quotes doubled),
 * and so is `\.` when it is the only value of the row.
 */
export function csvLine(fields: readonly (string | null)[]): string {
  const single = fields.length === 1;
  let out = '';
  for (let i = 0; i < fields.length; i += 1) {
    if (i > 0) out += ',';
    const value = fields[i]!;
    if (value === null) continue;
    if (value === '' || NEEDS_QUOTES.test(value) || (single && value === '\\.')) {
      out += `"${value.replace(/"/g, '""')}"`;
    } else {
      out += value;
    }
  }
  return `${out}\n`;
}

// ─── Writing ─────────────────────────────────────────────────────────────────

/** Gathers text and writes it to a file in large pieces; an error surfaces at the next call. */
class TextFile {
  private parts: string[] = [];
  private size = 0;

  private constructor(private readonly handle: fsp.FileHandle) {}

  static async create(file: string): Promise<TextFile> {
    return new TextFile(await fsp.open(file, 'w'));
  }

  async write(text: string): Promise<void> {
    this.parts.push(text);
    this.size += text.length;
    if (this.size >= FLUSH_BYTES) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.size === 0) return;
    const data = Buffer.from(this.parts.join(''), 'utf8');
    this.parts = [];
    this.size = 0;
    await this.handle.writeFile(data);
  }

  async close(): Promise<void> {
    try {
      await this.flush();
      // On the disk before the file counts as written (a USB stick pulled out early).
      await this.handle.sync().catch(() => undefined);
    } finally {
      await this.handle.close();
    }
  }

  async abandon(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

export interface WriteJsonArchiveInput {
  /** Staging folder: `tables/<name>.csv` as PostgreSQL wrote them, `uploads/` with the files. */
  dir: string;
  /** The manifest of what is in `dir` (table and file checksums included). */
  manifest: BackupManifest;
  /** The JSON file to write. */
  file: string;
  /** A sentence or two for a person who opens the file. */
  readme: string;
  /** Tables written as the bytes of their CSV instead of rows. */
  rawTables?: ReadonlySet<string>;
  /** Share of the work done, by the bytes of tables and files that have gone in. */
  onProgress?: (fraction: number) => void;
}

/** Writes the JSON document from a staging folder. Leaves no file behind when it fails. */
export async function writeJsonArchive(input: WriteJsonArchiveInput): Promise<void> {
  const { dir, manifest } = input;
  const total =
    manifest.tables.reduce((n, t) => n + t.bytes, 0) + (manifest.uploads?.bytes ?? 0) || 1;
  let done = 0;
  const advance = (bytes: number) => {
    done += bytes;
    input.onProgress?.(Math.min(1, done / total));
  };
  const manifestText = JSON.stringify(manifest);
  const out = await TextFile.create(input.file);
  try {
    await out.write(
      `{"format":${JSON.stringify(BACKUP_JSON_FORMAT)},"formatVersion":${BACKUP_JSON_FORMAT_VERSION},\n` +
        `"readme":${JSON.stringify(input.readme)},\n` +
        `"manifest":${manifestText},\n` +
        `"tables":[\n`,
    );
    let rows = 0;
    let first = true;
    for (const table of manifest.tables) {
      if (!TABLE_NAME.test(table.name)) throw new Error(`Unexpected table name "${table.name}"`);
      if (!first) await out.write(',\n');
      first = false;
      const file = path.join(dir, 'tables', `${table.name}.csv`);
      if (input.rawTables?.has(table.name)) {
        await out.write(`{"name":${JSON.stringify(table.name)},"csvBase64":[\n`);
        await writeBase64(out, file, advance);
        await out.write(']}');
      } else {
        try {
          rows += await writeRows(out, table.name, file, advance);
        } catch (err) {
          if (err instanceof CsvShapeError) throw new JsonTableShapeError(table.name, err);
          throw err;
        }
      }
    }
    await out.write(`${first ? '' : '\n'}],\n"files":[\n`);
    first = true;
    let fileBytes = 0;
    for (const item of manifest.files ?? []) {
      if (!isSafeRelativePath(item.path)) throw new Error(`Unexpected file path "${item.path}"`);
      if (!first) await out.write(',\n');
      first = false;
      await out.write(
        `{"path":${JSON.stringify(item.path)},"bytes":${item.bytes},"sha256":${JSON.stringify(item.sha256)},"base64":[\n`,
      );
      fileBytes += await writeBase64(
        out,
        path.join(dir, 'uploads', ...item.path.split('/')),
        advance,
      );
      await out.write(']}');
    }
    const end = {
      tables: manifest.tables.length,
      rows,
      files: manifest.files?.length ?? 0,
      fileBytes,
      manifestSha256: crypto.createHash('sha256').update(manifestText, 'utf8').digest('hex'),
    };
    await out.write(`${first ? '' : '\n'}],\n"end":${JSON.stringify(end)}}\n`);
    await out.close();
  } catch (err) {
    await out.abandon();
    await fsp.rm(input.file, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** One table as rows; returns how many. A CSV this cannot take apart is an error (see `rawTables`). */
async function writeRows(
  out: TextFile,
  name: string,
  csvFile: string,
  advance: (bytes: number) => void,
): Promise<number> {
  const decoder = new StringDecoder('utf8');
  let columns: number | null = null;
  let rows = 0;
  let pending: string[] = [];
  const scanner = new CsvScanner((fields) => {
    if (columns === null) {
      if (fields.some((f) => f === null)) throw new CsvShapeError('a column without a name');
      columns = fields.length;
      pending.push(
        `{"name":${JSON.stringify(name)},"columns":${JSON.stringify(fields)},"rows":[\n`,
      );
      return;
    }
    if (fields.length !== columns) {
      throw new CsvShapeError(`a row of ${fields.length} values under ${columns} columns`);
    }
    pending.push(rows === 0 ? JSON.stringify(fields) : `,\n${JSON.stringify(fields)}`);
    rows += 1;
  });
  const flush = async () => {
    if (pending.length === 0) return;
    const text = pending.join('');
    pending = [];
    await out.write(text);
  };
  for await (const chunk of fs.createReadStream(csvFile, { highWaterMark: FLUSH_BYTES })) {
    scanner.push(decoder.write(chunk as Buffer));
    await flush();
    advance((chunk as Buffer).length);
  }
  scanner.push(decoder.end());
  scanner.finish();
  // A table whose CSV is empty has no header line (it cannot happen; it is written as it is).
  if (columns === null) pending.push(`{"name":${JSON.stringify(name)},"columns":[],"rows":[\n`);
  pending.push(`${rows > 0 ? '\n' : ''}]}`);
  await flush();
  return rows;
}

/** The bytes of a file as lines of base64 (no line after the last one); returns the bytes read. */
async function writeBase64(
  out: TextFile,
  file: string,
  advance: (bytes: number) => void,
): Promise<number> {
  let bytes = 0;
  let first = true;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: FILE_PIECE_BYTES })) {
    const piece = chunk as Buffer;
    await out.write(`${first ? '' : ',\n'}"${piece.toString('base64')}"`);
    first = false;
    bytes += piece.length;
    advance(piece.length);
  }
  if (!first) await out.write('\n');
  return bytes;
}

// ─── Reading ─────────────────────────────────────────────────────────────────

/** What was found in a JSON backup: every table and file with the size and checksum it came out as. */
export interface JsonArchiveContents {
  /** The manifest, as the text that is in the file. */
  manifestText: string;
  tables: { name: string; rows: number | null; bytes: number; sha256: string; raw: boolean }[];
  files: { path: string; bytes: number; sha256: string }[];
}

/** Splits a stream into lines (without their line end). */
async function* linesOf(
  source: AsyncIterable<Buffer>,
  onBytes?: (bytes: number) => void,
): AsyncGenerator<Buffer> {
  let carry: Buffer[] = [];
  let carried = 0;
  for await (const chunk of source) {
    onBytes?.(chunk.length);
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(LF, start);
      if (nl < 0) break;
      let line = chunk.subarray(start, nl);
      if (carried > 0) {
        carry.push(line);
        line = Buffer.concat(carry);
        carry = [];
        carried = 0;
      }
      yield line;
      start = nl + 1;
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      carry.push(tail);
      carried += tail.length;
      if (carried > MAX_LINE_BYTES) {
        throw new JsonArchiveError('The file is not a LIKApcs JSON backup (a line without end)');
      }
    }
  }
  if (carried > 0) yield Buffer.concat(carry);
}

/** A line without the spaces and the carriage return another program may have put at its end. */
function trimEnd(line: Buffer): Buffer {
  let end = line.length;
  while (end > 0) {
    const c = line[end - 1]!;
    if (c === CR || c === 32 || c === 9) end -= 1;
    else break;
  }
  return end === line.length ? line : line.subarray(0, end);
}

function stripBom(line: Buffer): Buffer {
  return line.length >= 3 && line[0] === 0xef && line[1] === 0xbb && line[2] === 0xbf
    ? line.subarray(3)
    : line;
}

/** Writes one file of the staging folder, hashing what goes in; with no path it only hashes. */
class Sink {
  private readonly hash = crypto.createHash('sha256');
  private parts: Buffer[] = [];
  private size = 0;
  bytes = 0;

  private constructor(private readonly handle: fsp.FileHandle | null) {}

  static async open(file: string | null): Promise<Sink> {
    if (file === null) return new Sink(null);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // `wx`: a name that is in the file twice must not overwrite what was just written.
    return new Sink(await fsp.open(file, 'wx'));
  }

  async write(data: Buffer): Promise<void> {
    this.hash.update(data);
    this.bytes += data.length;
    if (!this.handle) return;
    this.parts.push(data);
    this.size += data.length;
    if (this.size >= FLUSH_BYTES) await this.flush();
  }

  private async flush(): Promise<void> {
    if (!this.handle || this.size === 0) return;
    const data = this.parts.length === 1 ? this.parts[0]! : Buffer.concat(this.parts);
    this.parts = [];
    this.size = 0;
    await this.handle.writeFile(data);
  }

  async close(): Promise<string> {
    try {
      await this.flush();
    } finally {
      await this.handle?.close();
    }
    return this.hash.digest('hex');
  }

  async abandon(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
  }
}

const CHANGED =
  'The JSON backup is not as this program wrote it: it was cut off, or another program has changed it';

/**
 * Reads a JSON backup from its first line to its last. With `outDir` the staging folder of a
 * restore is written — `manifest.json`, `tables/<name>.csv`, `uploads/…` — exactly what unpacking
 * an archive leaves there. Without it nothing is written and only the sizes and checksums are
 * worked out (the check of a file that was just made).
 *
 * Throws `JsonArchiveError` for a file that is cut off, was changed, or is not a JSON backup.
 * Whether the contents match the manifest is for the caller to decide from what is returned.
 */
export async function readJsonArchive(
  file: string,
  outDir: string | null,
  onProgress?: (fraction: number) => void,
): Promise<JsonArchiveContents> {
  const size = (await fsp.stat(file)).size || 1;
  let read = 0;
  const source = fs.createReadStream(file, { highWaterMark: FLUSH_BYTES });
  const tables: JsonArchiveContents['tables'] = [];
  const files: JsonArchiveContents['files'] = [];
  const seenTables = new Set<string>();
  const seenFiles = new Set<string>();
  let manifestText = '';
  let manifestHash = '';
  let listedTables = new Set<string>();
  let listedFiles = new Map<string, { bytes: number; sha256: string }>();
  let hasUploads = false;

  type State =
    | 'head'
    | 'readme'
    | 'manifest'
    | 'tables'
    | 'table'
    | 'rows'
    | 'raw'
    | 'files-open'
    | 'file'
    | 'pieces'
    | 'end'
    | 'done';
  let state: State = 'head';
  let lineNo = 0;
  let sink: Sink | null = null;
  // The table or file being read.
  let name = '';
  let columns = 0;
  let rows = 0;
  let item: { path: string; bytes: number; sha256: string } | null = null;
  let pending: string[] = [];
  let pendingSize = 0;

  const fail = (what: string): never => {
    throw new JsonArchiveError(`${CHANGED}: ${what}`, lineNo);
  };
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return fail('a line that is not JSON');
    }
  };
  const flushRows = async () => {
    if (pendingSize === 0) return;
    const data = Buffer.from(pending.join(''), 'utf8');
    pending = [];
    pendingSize = 0;
    await sink!.write(data);
  };
  /** `]}` or `]},`: the end of a table or of a file. */
  const isClose = (line: Buffer) =>
    line.length >= 2 &&
    line[0] === 93 &&
    line[1] === 125 &&
    (line.length === 2 || (line.length === 3 && line[2] === COMMA));
  /** `],`: the end of the list of tables or of files. */
  const isListEnd = (line: Buffer) => line.length === 2 && line[0] === 93 && line[1] === COMMA;
  /** The base64 between the quotes of `"…"` or `"…",`. */
  const base64Of = (line: Buffer): Buffer => {
    const end = line[line.length - 1] === COMMA ? line.length - 2 : line.length - 1;
    if (line.length < 2 || line[0] !== QUOTE || line[end] !== QUOTE || end < 1) {
      fail('a piece of a file that is not base64');
    }
    const text = line.toString('latin1', 1, end);
    const data = Buffer.from(text, 'base64');
    // Node skips what is not base64 instead of refusing it: the length tells.
    const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
    if (text.length % 4 !== 0 || data.length !== (text.length / 4) * 3 - padding) {
      fail('a piece of a file that is not base64');
    }
    return data;
  };

  try {
    for await (const rawLine of linesOf(source, (n) => {
      read += n;
      onProgress?.(Math.min(1, read / size));
    })) {
      lineNo += 1;
      let line = trimEnd(rawLine);
      if (lineNo === 1) line = stripBom(line);
      if (line.length === 0) continue;
      switch (state) {
        case 'head': {
          const match = HEAD_LINE.exec(line.toString('utf8'));
          if (!match) {
            // A backup another program has laid out differently still begins like one.
            const began = looksLikeJsonArchive(line) || (await isJsonArchiveFile(file));
            throw new JsonArchiveError(
              began ? `${CHANGED}: the first line` : 'The file is not a LIKApcs JSON backup',
              lineNo,
            );
          }
          if (Number(match[1]) > BACKUP_JSON_FORMAT_VERSION) {
            throw new JsonArchiveError(
              `JSON backup format v${match[1]} is newer than this server understands`,
            );
          }
          state = 'readme';
          break;
        }
        case 'readme': {
          const text = line.toString('utf8');
          if (!text.startsWith('"readme":') || !text.endsWith(',')) fail('the note at the top');
          parse(`{${text.slice(0, -1)}}`);
          state = 'manifest';
          break;
        }
        case 'manifest': {
          const text = line.toString('utf8');
          if (!text.startsWith('"manifest":') || !text.endsWith(',')) fail('the manifest');
          manifestText = text.slice('"manifest":'.length, -1);
          manifestHash = crypto.createHash('sha256').update(manifestText, 'utf8').digest('hex');
          const manifest = parse(manifestText) as Partial<BackupManifest> | null;
          if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.tables)) {
            fail('the manifest');
          }
          listedTables = new Set(manifest!.tables!.map((t) => t.name));
          listedFiles = new Map((manifest!.files ?? []).map((f) => [f.path, f]));
          hasUploads = manifest!.uploads != null;
          if (outDir !== null) {
            await fsp.mkdir(path.join(outDir, 'tables'), { recursive: true });
            // The folder is there whenever the backup had one, also with nothing in it: a
            // restore then replaces the uploads with "no files", as it does for an archive.
            if (hasUploads) await fsp.mkdir(path.join(outDir, 'uploads'), { recursive: true });
            await fsp.writeFile(path.join(outDir, 'manifest.json'), manifestText);
          }
          state = 'tables';
          break;
        }
        case 'tables': {
          if (line.toString('latin1') !== '"tables":[') fail('the start of the tables');
          state = 'table';
          break;
        }
        case 'table': {
          if (isListEnd(line)) {
            state = 'files-open';
            break;
          }
          const text = line.toString('utf8');
          if (!text.startsWith('{"name":')) fail('the start of a table');
          const head = parse(`${text}]}`) as {
            name?: unknown;
            columns?: unknown;
            rows?: unknown;
            csvBase64?: unknown;
          };
          if (typeof head.name !== 'string' || !TABLE_NAME.test(head.name)) fail('a table name');
          name = head.name as string;
          if (seenTables.has(name)) fail(`table "${name}" is in the file twice`);
          if (!listedTables.has(name)) fail(`table "${name}" is not in the manifest`);
          seenTables.add(name);
          sink = await Sink.open(
            outDir === null ? null : path.join(outDir, 'tables', `${name}.csv`),
          );
          rows = 0;
          if (Array.isArray(head.csvBase64)) {
            state = 'raw';
            break;
          }
          if (
            !Array.isArray(head.columns) ||
            !Array.isArray(head.rows) ||
            !head.columns.every((c) => typeof c === 'string')
          ) {
            fail(`the columns of table "${name}"`);
          }
          columns = (head.columns as string[]).length;
          if (columns > 0) {
            const header = csvLine(head.columns as string[]);
            pending.push(header);
            pendingSize += header.length;
          }
          state = 'rows';
          break;
        }
        case 'rows': {
          if (isClose(line)) {
            await flushRows();
            const done = sink!;
            sink = null;
            tables.push({ name, rows, bytes: done.bytes, sha256: await done.close(), raw: false });
            state = 'table';
            break;
          }
          if (line[0] !== 91) fail(`a row of table "${name}"`);
          const end = line[line.length - 1] === COMMA ? line.length - 1 : line.length;
          const fields = parse(line.toString('utf8', 0, end)) as unknown;
          if (!Array.isArray(fields) || fields.length !== columns) {
            fail(`a row of table "${name}" that does not have ${columns} values`);
          }
          for (const value of fields as unknown[]) {
            if (value !== null && typeof value !== 'string') {
              fail(`a value of table "${name}" that is neither text nor null`);
            }
          }
          const text = csvLine(fields as (string | null)[]);
          pending.push(text);
          pendingSize += text.length;
          rows += 1;
          if (pendingSize >= FLUSH_BYTES) await flushRows();
          break;
        }
        case 'raw': {
          if (isClose(line)) {
            const done = sink!;
            sink = null;
            tables.push({
              name,
              rows: null,
              bytes: done.bytes,
              sha256: await done.close(),
              raw: true,
            });
            state = 'table';
            break;
          }
          await sink!.write(base64Of(line));
          break;
        }
        case 'files-open': {
          if (line.toString('latin1') !== '"files":[') fail('the start of the files');
          state = 'file';
          break;
        }
        case 'file': {
          if (isListEnd(line)) {
            state = 'end';
            break;
          }
          const text = line.toString('utf8');
          if (!text.startsWith('{"path":')) fail('the start of a file');
          const head = parse(`${text}]}`) as {
            path?: unknown;
            bytes?: unknown;
            sha256?: unknown;
            base64?: unknown;
          };
          if (!isSafeRelativePath(head.path)) fail('a file name');
          if (
            typeof head.bytes !== 'number' ||
            !Number.isSafeInteger(head.bytes) ||
            head.bytes < 0 ||
            typeof head.sha256 !== 'string' ||
            !SHA256.test(head.sha256) ||
            !Array.isArray(head.base64)
          ) {
            fail(`the size or checksum of file "${String(head.path)}"`);
          }
          item = {
            path: head.path as string,
            bytes: head.bytes as number,
            sha256: head.sha256 as string,
          };
          if (seenFiles.has(item.path)) fail(`file "${item.path}" is in the file twice`);
          if (!listedFiles.has(item.path)) fail(`file "${item.path}" is not in the manifest`);
          seenFiles.add(item.path);
          sink = await Sink.open(
            outDir === null ? null : path.join(outDir, 'uploads', ...item.path.split('/')),
          );
          state = 'pieces';
          break;
        }
        case 'pieces': {
          if (isClose(line)) {
            const done = sink!;
            sink = null;
            const bytes = done.bytes;
            const sha256 = await done.close();
            if (bytes !== item!.bytes || sha256 !== item!.sha256) {
              fail(`file "${item!.path}" does not have the size or checksum written next to it`);
            }
            files.push({ path: item!.path, bytes, sha256 });
            state = 'file';
            break;
          }
          await sink!.write(base64Of(line));
          break;
        }
        case 'end': {
          const text = line.toString('utf8');
          if (!text.startsWith('"end":') || !text.endsWith('}}')) fail('the last line');
          const end = parse(`{${text}`) as {
            end?: {
              tables?: unknown;
              rows?: unknown;
              files?: unknown;
              fileBytes?: unknown;
              manifestSha256?: unknown;
            };
          };
          const counted = tables.reduce((n, t) => n + (t.rows ?? 0), 0);
          const fileBytes = files.reduce((n, f) => n + f.bytes, 0);
          // (The rows of a table written as raw bytes are counted on neither side.)
          if (
            end.end?.tables !== tables.length ||
            end.end?.files !== files.length ||
            end.end?.fileBytes !== fileBytes ||
            end.end?.rows !== counted
          ) {
            fail('the totals on the last line are not what the file holds');
          }
          if (end.end?.manifestSha256 !== manifestHash) fail('the manifest was changed');
          state = 'done';
          break;
        }
        case 'done':
          fail('text after the end of the backup');
      }
    }
    if (state !== 'done') {
      throw new JsonArchiveError(
        lineNo === 0
          ? 'The file is empty'
          : `${CHANGED}: the file ends before the backup does (it was not copied whole)`,
        lineNo,
      );
    }
    return { manifestText, tables, files };
  } catch (err) {
    source.destroy();
    await sink?.abandon();
    throw err;
  }
}

/**
 * The manifest of a JSON backup, as text, from the first lines of `source` (which is stopped).
 * Only the beginning of the file is read. For a source that begins like a JSON backup
 * (`looksLikeJsonArchive`): anything else in its first lines means the file was changed.
 */
export async function peekJsonManifestText(source: Readable): Promise<string> {
  let read = 0;
  let lineNo = 0;
  let seen = 0;
  try {
    for await (const rawLine of linesOf(source as AsyncIterable<Buffer>, (n) => {
      read += n;
    })) {
      lineNo += 1;
      let line = trimEnd(rawLine);
      if (lineNo === 1) line = stripBom(line);
      if (line.length === 0) continue;
      seen += 1;
      if (seen === 1) {
        const match = HEAD_LINE.exec(line.toString('utf8'));
        if (!match) throw new JsonArchiveError(`${CHANGED}: the first line`, lineNo);
        if (Number(match[1]) > BACKUP_JSON_FORMAT_VERSION) {
          throw new JsonArchiveError(
            `JSON backup format v${match[1]} is newer than this server understands`,
          );
        }
      } else if (seen === 3) {
        const text = line.toString('utf8');
        if (!text.startsWith('"manifest":') || !text.endsWith(',')) {
          throw new JsonArchiveError(`${CHANGED}: the manifest`, lineNo);
        }
        return text.slice('"manifest":'.length, -1);
      }
      if (read > MAX_HEAD_BYTES) break;
    }
    throw new JsonArchiveError(`${CHANGED}: the manifest is missing`, lineNo);
  } finally {
    source.destroy();
  }
}

/** The manifest text of a JSON backup file (only its beginning is read). */
export function readJsonManifestText(file: string): Promise<string> {
  return peekJsonManifestText(fs.createReadStream(file, { highWaterMark: 64 * 1024 }));
}

/**
 * Reads a finished JSON backup back and compares what comes out of it with the manifest: every
 * table and every uploaded file must be there with the listed size and checksum. Returns the
 * tables that did NOT come back identical (the caller writes those as raw bytes and tries again);
 * anything else that is wrong throws.
 */
export async function verifyJsonArchive(
  file: string,
  manifest: BackupManifest,
  onProgress?: (fraction: number) => void,
): Promise<string[]> {
  const fail = (what: string): never => {
    throw new Error(`Backup verification failed: ${what}. The file was not kept.`);
  };
  const found = await readJsonArchive(file, null, onProgress);
  if (found.manifestText !== JSON.stringify(manifest)) fail('the manifest is not the one written');
  const tables = new Map(found.tables.map((t) => [t.name, t]));
  const differing: string[] = [];
  for (const table of manifest.tables) {
    const got = tables.get(table.name);
    if (!got) return fail(`table ${table.name} is missing`);
    if (
      got.bytes !== table.bytes ||
      (table.sha256 !== undefined && got.sha256 !== table.sha256) ||
      (got.rows !== null && got.rows !== table.rows)
    ) {
      differing.push(table.name);
    }
  }
  if (found.tables.length !== manifest.tables.length) fail('a table that is not in the manifest');
  const files = new Map(found.files.map((f) => [f.path, f]));
  for (const item of manifest.files ?? []) {
    const got = files.get(item.path);
    if (!got) return fail(`file ${item.path} is missing`);
    if (got.bytes !== item.bytes || got.sha256 !== item.sha256) {
      fail(`file ${item.path} does not match what was written`);
    }
  }
  if (found.files.length !== (manifest.files?.length ?? 0))
    fail('a file that is not in the manifest');
  return differing;
}
