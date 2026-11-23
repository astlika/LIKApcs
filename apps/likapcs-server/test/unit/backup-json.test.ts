/**
 * 0.41.0 — the backup as one JSON document: the parts that need no database.
 *
 *  - a row is put together again exactly as PostgreSQL writes it (NULL and the empty text stay
 *    apart; commas, quotes and line breaks inside a value survive);
 *  - the CSV is taken apart the same whatever the size of the pieces it arrives in;
 *  - a staging folder written as JSON is ONE valid JSON document, and reading it back leaves the
 *    same folder, byte for byte;
 *  - a file that was cut off, changed or re-formatted by another program is refused.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, type BackupManifest } from '@likapcs/shared';
import {
  CsvScanner,
  CsvShapeError,
  JsonArchiveError,
  JsonTableShapeError,
  csvLine,
  isJsonArchiveFile,
  looksLikeJsonArchive,
  readJsonArchive,
  readJsonManifestText,
  verifyJsonArchive,
  writeJsonArchive,
} from '../../src/services/backup-json.js';

type Row = (string | null)[];

function scan(text: string, pieces: number[] = []): Row[] {
  const rows: Row[] = [];
  const scanner = new CsvScanner((fields) => rows.push(fields));
  let at = 0;
  for (const size of pieces) {
    scanner.push(text.slice(at, at + size));
    at += size;
  }
  scanner.push(text.slice(at));
  scanner.finish();
  return rows;
}

const sha = (data: Buffer | string) => crypto.createHash('sha256').update(data).digest('hex');

describe('CSV the way PostgreSQL writes it', () => {
  it('writes a row as COPY … (FORMAT csv) does', () => {
    expect(csvLine(['a', 'b'])).toBe('a,b\n');
    // NULL is nothing; the empty text is a pair of quotes.
    expect(csvLine([null, '', null])).toBe(',"",\n');
    expect(csvLine(['a,b', 'say "hi"', 'two\nlines', 'cr\rhere'])).toBe(
      '"a,b","say ""hi""","two\nlines","cr\rhere"\n',
    );
    // Spaces, backslashes and other letters need no quotes.
    expect(csvLine([' padded ', 'back\\slash', 'Çokollatë €', '{"k": 1}'])).toBe(
      ' padded ,back\\slash,Çokollatë €,"{""k"": 1}"\n',
    );
    // `\.` alone on a line would end the data, so it is quoted there (and only there).
    expect(csvLine(['\\.'])).toBe('"\\."\n');
    expect(csvLine(['\\.', 'x'])).toBe('\\.,x\n');
    expect(csvLine([null])).toBe('\n');
    expect(csvLine([''])).toBe('""\n');
  });

  it('takes the same text apart again', () => {
    expect(scan('a,b\n,"",\n')).toEqual([
      ['a', 'b'],
      [null, '', null],
    ]);
    expect(scan('"a,b","say ""hi""","two\nlines","cr\rhere"\n')).toEqual([
      ['a,b', 'say "hi"', 'two\nlines', 'cr\rhere'],
    ]);
    // A line of nothing is one NULL value; a file of nothing has no rows.
    expect(scan('\n')).toEqual([[null]]);
    expect(scan('')).toEqual([]);
    // Line ends written by another system are taken too.
    expect(scan('a,b\r\nc,\r\n')).toEqual([
      ['a', 'b'],
      ['c', null],
    ]);
  });

  it('gives the same rows whatever the pieces the text arrives in', () => {
    const rows: Row[] = [
      ['id', 'name', 'note'],
      ['1', 'Coca-Cola 0.33l', null],
      ['2', 'say "hi", twice', ''],
      ['3', 'line\nbreak', 'cr\r\nlf'],
      ['4', '""', '"'],
      ['5', 'Ë ë Ç ç € 😀', ',,,'],
      [null, null, null],
      ['', '', ''],
    ];
    const text = rows.map(csvLine).join('');
    expect(scan(text)).toEqual(rows);
    // Cut at every position, and into single characters.
    for (let cut = 0; cut <= text.length; cut += 1) expect(scan(text, [cut])).toEqual(rows);
    expect(
      scan(
        text,
        Array.from({ length: text.length }, () => 1),
      ),
    ).toEqual(rows);
  });

  it('survives values made of the characters that matter, in random pieces', () => {
    const alphabet = ['"', ',', '\n', '\r', '\\', '.', ' ', 'a', 'ë', '€', '😀', '{', '}'];
    let seed = 20261124;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 200; round += 1) {
      const columns = 1 + Math.floor(random() * 5);
      const rows: Row[] = [];
      for (let r = 0; r < 1 + Math.floor(random() * 6); r += 1) {
        const row: Row = [];
        for (let c = 0; c < columns; c += 1) {
          if (random() < 0.15) row.push(null);
          else {
            let value = '';
            const length = Math.floor(random() * 7);
            for (let k = 0; k < length; k += 1) {
              value += alphabet[Math.floor(random() * alphabet.length)];
            }
            row.push(value);
          }
        }
        rows.push(row);
      }
      const text = rows.map(csvLine).join('');
      const pieces: number[] = [];
      for (let left = text.length; left > 0;) {
        const size = 1 + Math.floor(random() * 9);
        pieces.push(size);
        left -= size;
      }
      expect(scan(text, pieces)).toEqual(rows);
      // And the rows written again are the text that was read: nothing is lost on the way.
      expect(scan(text).map(csvLine).join('')).toBe(text);
    }
  });

  it('refuses text that is not such a CSV', () => {
    expect(() => scan('a"b,c\n')).toThrow(CsvShapeError);
    expect(() => scan('"a"b,c\n')).toThrow(CsvShapeError);
    expect(() => scan('a,b')).toThrow(CsvShapeError);
    expect(() => scan('"never closed\n')).toThrow(CsvShapeError);
    expect(() => scan('a\rb\n')).toThrow(CsvShapeError);
  });
});

describe('a staging folder as one JSON document', () => {
  let root: string;
  let staging: string;
  let manifest: BackupManifest;
  let document: string;
  const tables: Record<string, string> = {
    products:
      'id,name,note,price\n' +
      '1,Coca-Cola 0.33l,,120\n' +
      '2,"say ""hi"", twice","",70\n' +
      '3,"two\nlines",Çokollatë €,0\n',
    empty_table: 'id,name\n',
    single: 'value\n"\\."\n\n""\nplain\n',
  };
  const uploads: Record<string, Buffer> = {
    'products/aa11.jpg': crypto.randomBytes(180_000),
    'products/empty.bin': Buffer.alloc(0),
    'videos/reklama.mp4': crypto.randomBytes(48 * 1024 * 3 + 7),
    'voice/pesë-minuta.mp3': crypto.randomBytes(48 * 1024),
  };

  const tree = async (dir: string): Promise<Record<string, string>> => {
    const out: Record<string, string> = {};
    const walk = async (at: string, prefix: string): Promise<void> => {
      for (const entry of await fsp.readdir(at, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(at, entry.name), rel);
        else out[rel] = sha(await fsp.readFile(path.join(at, entry.name)));
      }
    };
    await walk(dir, '');
    return out;
  };

  beforeAll(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-json-unit-'));
    staging = path.join(root, 'staging');
    await fsp.mkdir(path.join(staging, 'tables'), { recursive: true });
    for (const [name, csv] of Object.entries(tables)) {
      await fsp.writeFile(path.join(staging, 'tables', `${name}.csv`), csv);
    }
    for (const [rel, data] of Object.entries(uploads)) {
      const file = path.join(staging, 'uploads', ...rel.split('/'));
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, data);
    }
    const files = Object.entries(uploads)
      .map(([p, data]) => ({ path: p, bytes: data.length, sha256: sha(data) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: '2026-11-24T10:00:00.000Z',
      serverVersion: '0.41.0',
      schemaVersion: 65,
      businessName: 'Lika "Gaming"\nPrishtinë',
      kind: 'manual',
      tables: Object.entries(tables).map(([name, csv]) => ({
        name,
        rows: name === 'products' ? 3 : name === 'single' ? 4 : 0,
        bytes: Buffer.byteLength(csv),
        sha256: sha(csv),
      })),
      uploads: { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
      files,
      installationId: '0b6f2c1e-5a7d-4f39-9c44-1a2b3c4d5e6f',
    };
    document = path.join(root, 'kopja.likapcs-backup.json');
    await writeJsonArchive({
      dir: staging,
      manifest,
      file: document,
      readme: 'Kopje e plotë.\n"Mos e ndryshoni."',
    });
  });

  afterAll(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it('is one valid JSON document that says what it holds', async () => {
    const text = await fsp.readFile(document, 'utf8');
    const parsed = JSON.parse(text) as {
      format: string;
      formatVersion: number;
      readme: string;
      manifest: BackupManifest;
      tables: { name: string; columns: string[]; rows: Row[] }[];
      files: { path: string; bytes: number; sha256: string; base64: string[] }[];
      end: { tables: number; rows: number; files: number; fileBytes: number };
    };
    expect(parsed.format).toBe('likapcs-backup-json');
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.readme).toContain('Mos e ndryshoni');
    expect(parsed.manifest).toEqual(manifest);
    expect(parsed.tables.map((t) => t.name)).toEqual(['products', 'empty_table', 'single']);
    expect(parsed.tables[0]).toEqual({
      name: 'products',
      columns: ['id', 'name', 'note', 'price'],
      rows: [
        ['1', 'Coca-Cola 0.33l', null, '120'],
        ['2', 'say "hi", twice', '', '70'],
        ['3', 'two\nlines', 'Çokollatë €', '0'],
      ],
    });
    expect(parsed.tables[1]!.rows).toEqual([]);
    expect(parsed.tables[2]!.rows).toEqual([['\\.'], [null], [''], ['plain']]);
    // The files are their bytes, in pieces.
    for (const file of parsed.files) {
      const data = Buffer.concat(file.base64.map((piece) => Buffer.from(piece, 'base64')));
      expect(data.equals(uploads[file.path]!)).toBe(true);
      expect(file.bytes).toBe(data.length);
      expect(file.sha256).toBe(sha(data));
    }
    expect(parsed.files.map((f) => f.path)).toEqual(manifest.files!.map((f) => f.path));
    expect(parsed.end).toMatchObject({
      tables: 3,
      rows: 7,
      files: 4,
      fileBytes: manifest.uploads!.bytes,
    });
    // One element per line: no line is longer than a piece of a file.
    const longest = Math.max(...text.split('\n').map((line) => line.length));
    expect(longest).toBeLessThan(70_000);
    expect(await isJsonArchiveFile(document)).toBe(true);
    expect(JSON.parse(await readJsonManifestText(document))).toEqual(manifest);
  });

  it('reads back into the same folder, byte for byte', async () => {
    const out = path.join(root, 'restored');
    const fractions: number[] = [];
    const found = await readJsonArchive(document, out, (f) => fractions.push(f));
    expect(fractions.at(-1)).toBe(1);
    expect([...fractions].sort((a, b) => a - b)).toEqual(fractions);
    const before = await tree(staging);
    const after = await tree(out);
    expect(JSON.parse(await fsp.readFile(path.join(out, 'manifest.json'), 'utf8'))).toEqual(
      manifest,
    );
    delete after['manifest.json'];
    expect(after).toEqual(before);
    expect(found.tables).toEqual(
      manifest.tables.map((t) => ({ ...t, raw: false, sha256: t.sha256! })),
    );
    expect(found.files).toEqual(manifest.files);
    // The check of a finished file: nothing differs, and nothing was written for it.
    expect(await verifyJsonArchive(document, manifest)).toEqual([]);
  });

  it('a table written as raw bytes comes back the same', async () => {
    const raw = path.join(root, 'raw.likapcs-backup.json');
    await writeJsonArchive({
      dir: staging,
      manifest,
      file: raw,
      readme: 'x',
      rawTables: new Set(['products', 'empty_table']),
    });
    const parsed = JSON.parse(await fsp.readFile(raw, 'utf8')) as {
      tables: { name: string; csvBase64?: string[]; rows?: Row[] }[];
    };
    expect(parsed.tables[0]!.rows).toBeUndefined();
    expect(Buffer.from(parsed.tables[0]!.csvBase64!.join(''), 'base64').toString('utf8')).toBe(
      tables.products,
    );
    expect(parsed.tables[2]!.rows).toHaveLength(4);
    const out = path.join(root, 'restored-raw');
    const found = await readJsonArchive(raw, out);
    expect(found.tables.map((t) => t.raw)).toEqual([true, true, false]);
    const after = await tree(out);
    delete after['manifest.json'];
    expect(after).toEqual(await tree(staging));
    expect(await verifyJsonArchive(raw, manifest)).toEqual([]);
  });

  it('a CSV that cannot be taken apart names its table', async () => {
    const broken = path.join(root, 'staging-broken');
    await fsp.cp(staging, broken, { recursive: true });
    await fsp.writeFile(path.join(broken, 'tables', 'single.csv'), 'value\nnot"valid\n');
    const target = path.join(root, 'broken.likapcs-backup.json');
    const attempt = writeJsonArchive({ dir: broken, manifest, file: target, readme: 'x' });
    await expect(attempt).rejects.toBeInstanceOf(JsonTableShapeError);
    await expect(attempt).rejects.toMatchObject({ table: 'single' });
    // Nothing half-written is left.
    expect(fs.existsSync(target)).toBe(false);
  });

  it('takes a file another program saved with a mark in front and other line ends', async () => {
    const text = await fsp.readFile(document, 'utf8');
    const windows = path.join(root, 'windows.json');
    await fsp.writeFile(windows, `\uFEFF${text.replace(/\n/g, '\r\n')}\r\n\r\n`);
    expect(await isJsonArchiveFile(windows)).toBe(true);
    expect(await verifyJsonArchive(windows, manifest)).toEqual([]);
    const out = path.join(root, 'restored-windows');
    await readJsonArchive(windows, out);
    const after = await tree(out);
    delete after['manifest.json'];
    expect(after).toEqual(await tree(staging));
  });

  it('refuses a file that was cut off, changed or re-formatted', async () => {
    const text = await fsp.readFile(document, 'utf8');
    const variant = async (name: string, content: string | Buffer): Promise<string> => {
      const file = path.join(root, name);
      await fsp.writeFile(file, content);
      return file;
    };
    const read = (file: string) => readJsonArchive(file, null);

    // Cut off: in the middle of a file, in the middle of a table, just before the last line.
    for (const share of [0.9, 0.5, 0.02]) {
      const cut = await variant('cut.json', text.slice(0, Math.floor(text.length * share)));
      await expect(read(cut)).rejects.toBeInstanceOf(JsonArchiveError);
    }
    const noEnd = await variant('no-end.json', text.slice(0, text.lastIndexOf('"end"')));
    await expect(read(noEnd)).rejects.toThrow(/ends before the backup does/);
    await expect(read(await variant('empty.json', ''))).rejects.toThrow(/empty/);

    // Re-formatted by another program: still JSON, no longer what was written.
    const pretty = await variant('pretty.json', JSON.stringify(JSON.parse(text), null, 2));
    expect(await isJsonArchiveFile(pretty)).toBe(true);
    await expect(read(pretty)).rejects.toBeInstanceOf(JsonArchiveError);
    const minified = await variant('minified.json', JSON.stringify(JSON.parse(text)));
    await expect(read(minified)).rejects.toBeInstanceOf(JsonArchiveError);

    // A value changed in a table: the file still reads, the table no longer matches the manifest.
    const edited = await variant(
      'edited.json',
      text.replace('"Coca-Cola 0.33l"', '"Coca-Cola 0.5l"'),
    );
    expect(await verifyJsonArchive(edited, manifest)).toEqual(['products']);
    // A row removed: the totals on the last line catch it.
    const fewer = await variant(
      'fewer.json',
      text.replace('["1","Coca-Cola 0.33l",null,"120"],\n', ''),
    );
    await expect(read(fewer)).rejects.toThrow(/totals/);
    // A piece of a file changed (same length): its checksum catches it.
    const lines = text.split('\n');
    const pieceAt = lines.findIndex((line) => line.startsWith('{"path":"products/aa11.jpg"')) + 1;
    const piece = lines[pieceAt]!;
    lines[pieceAt] = `"${piece[1] === 'A' ? 'B' : 'A'}${piece.slice(2)}`;
    const flipped = await variant('flipped.json', lines.join('\n'));
    await expect(read(flipped)).rejects.toThrow(/products\/aa11\.jpg/);
    // Something that is not base64 in a piece.
    lines[pieceAt] = `"!!!!${piece.slice(5)}`;
    await expect(read(await variant('not-base64.json', lines.join('\n')))).rejects.toThrow(
      /base64/,
    );
    // The manifest edited (a table renamed in it).
    const renamed = await variant(
      'manifest.json',
      text.replace('"name":"single","rows":4', '"name":"other","rows":4'),
    );
    await expect(read(renamed)).rejects.toBeInstanceOf(JsonArchiveError);
    // A file that tries to leave the folder it is written to.
    const escaping = await variant(
      'escape.json',
      text.replaceAll('"path":"products/aa11.jpg"', '"path":"../outside.jpg"'),
    );
    const out = path.join(root, 'restored-escape');
    await expect(readJsonArchive(escaping, out)).rejects.toThrow(/file name/);
    expect(fs.existsSync(path.join(root, 'outside.jpg'))).toBe(false);
    // A newer layout than this program knows.
    const newer = await variant(
      'newer.json',
      text.replace('"formatVersion":1,', '"formatVersion":2,'),
    );
    await expect(read(newer)).rejects.toThrow(/newer/);
    // Not a backup at all.
    const other = await variant('other.json', '{"hello":"world"}\n');
    expect(await isJsonArchiveFile(other)).toBe(false);
    await expect(read(other)).rejects.toThrow(/not a LIKApcs JSON backup/);
    expect(looksLikeJsonArchive(Buffer.from('  { "format" : "likapcs-backup-json", '))).toBe(true);
    expect(looksLikeJsonArchive(Buffer.from([0x1f, 0x8b, 8, 0]))).toBe(false);
  });
});
