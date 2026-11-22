/**
 * The writers of «Skedar për AI»: how a value is shown in each file, how a row with its nested
 * rows is laid out, and that the JSON file is valid whatever is written into it.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExportDocument,
  FileSink,
  child,
  jsonValue,
  l,
  renderRow,
  textValue,
  type Column,
  type TableSpec,
} from '../../src/services/data-export/document.js';
import { guide, valueOf } from '../../src/services/data-export/labels.js';
import {
  SECTIONS,
  auditDetail,
  customerLabel,
  lineText,
  paymentText,
  type ExportContext,
} from '../../src/services/data-export/sections.js';
import { serialDb } from '../../src/services/data-export/service.js';
import { DATA_EXPORT_SECTIONS } from '@likapcs/shared';

describe('values', () => {
  it('money, quantities and percentages are numbers in JSON and fixed text in the text file', () => {
    expect(jsonValue('money', 1250)).toBe(12.5);
    expect(textValue('money', 1250, 'sq')).toBe('12.50');
    expect(jsonValue('money', -5)).toBe(-0.05);
    expect(textValue('money', 0, 'sq')).toBe('0.00');
    expect(jsonValue('money', 0)).toBe(0);
    // A price in thousandths keeps its third decimal only when it has one.
    expect(textValue('mills', 1500, 'sq')).toBe('1.50');
    expect(textValue('mills', 333, 'sq')).toBe('0.333');
    expect(jsonValue('mills', 333)).toBe(0.333);
    expect(jsonValue('qty', 1500)).toBe(1.5);
    expect(textValue('qty', 2000, 'sq')).toBe('2');
    expect(textValue('qty', -250, 'sq')).toBe('-0.25');
    expect(jsonValue('percent', 1234)).toBe(12.34);
    expect(textValue('percent', 1234, 'en')).toBe('12.34 %');
    expect(textValue('bool', true, 'sq')).toBe('po');
    expect(textValue('bool', false, 'en')).toBe('no');
    expect(jsonValue('bool', false)).toBe(false);
  });

  it('nothing to show is left out of JSON and empty in text', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(jsonValue('text', empty)).toBeUndefined();
      expect(textValue('money', empty, 'sq')).toBe('');
    }
  });

  it('a typed text cannot break a row: line breaks and the column sign are replaced', () => {
    expect(textValue('text', ' a | b\r\n c\td ', 'sq')).toBe('a / b / c d');
    // JSON keeps the text as it was typed (trimmed).
    expect(jsonValue('text', ' a | b ')).toBe('a | b');
  });
});

describe('rows', () => {
  interface Sale {
    no: string;
    total: number;
    note: string | null;
    discount: number | null;
  }
  const columns: Column<Sale>[] = [
    { label: l('Nr', 'No'), get: (r) => r.no },
    { label: l('Totali', 'Total'), kind: 'money', get: (r) => r.total },
    { label: l('Shënim', 'Note'), get: (r) => r.note },
    { label: l('Zbritja', 'Discount'), kind: 'money', optional: true, get: (r) => r.discount },
  ];

  it('fixed columns always stand in the text row, optional ones only with a value', () => {
    expect(renderRow(columns, { no: 'R-1', total: 350, note: null, discount: null }, 'sq')).toEqual(
      { json: { Nr: 'R-1', Totali: 3.5 }, text: 'R-1 | 3.50 | -' },
    );
    expect(renderRow(columns, { no: 'R-2', total: 100, note: 'x', discount: 20 }, 'en')).toEqual({
      json: { No: 'R-2', Total: 1, Note: 'x', Discount: 0.2 },
      text: 'R-2 | 1.00 | x ; Discount: 0.20',
    });
  });
});

describe('the two files', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-doc-'));
  });
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  interface Line {
    name: string;
    qty: number;
  }
  interface Bill {
    no: string;
    total: number;
    lines: Line[];
  }
  const spec: TableSpec<Bill> = {
    title: l('Shitjet', 'Sales'),
    note: l('Çdo faturë.', 'Every bill.'),
    columns: [
      { label: l('Nr', 'No'), get: (r) => r.no },
      { label: l('Totali', 'Total'), kind: 'money', get: (r) => r.total },
    ],
    children: [
      child<Bill, Line>({
        title: l('Artikujt', 'Lines'),
        tag: l('artikull', 'line'),
        rows: (r) => r.lines,
        columns: [
          { label: l('Artikulli', 'Item'), get: (i) => i.name },
          { label: l('Sasia', 'Qty'), kind: 'qty', get: (i) => i.qty },
        ],
      }),
    ],
  };

  it('hold the same blocks; the JSON is valid and the text is laid out row by row', async () => {
    const json = new FileSink(path.join(dir, 'a.json'));
    const txt = new FileSink(path.join(dir, 'a.txt'));
    const doc = new ExportDocument('sq', json, txt);
    await doc.begin(['Titulli']);
    await doc.facts(l('Skedari', 'File'), [
      { label: l('Biznesi', 'Business'), value: 'Arena "Lika" \\ çë' },
      { label: l('Bosh', 'Empty'), value: null },
      { label: l('Qarkullimi', 'Turnover'), kind: 'money', value: 123_456 },
    ]);
    await doc.note(l('Si lexohet', 'How to read it'), ['Një.', 'Dy.']);
    await doc.beginGroup(l('Përmbledhje', 'Summary'));
    await doc.facts(l('Totalet', 'Totals'), [
      { label: l('Fatura', 'Bills'), kind: 'int', value: 2 },
    ]);
    await doc.table<{ d: string }>(
      {
        title: l('Sipas ditës', 'By day'),
        columns: [{ label: l('Data', 'Date'), get: (r) => r.d }],
      },
      [[{ d: '2026-11-21' }]],
    );
    await doc.endGroup();
    const seen: number[] = [];
    const count = await doc.table(
      spec,
      [
        [
          {
            no: 'R-1',
            total: 350,
            lines: [
              { name: 'Cola', qty: 2000 },
              { name: 'Çips', qty: 500 },
            ],
          },
        ],
        [{ no: 'R-2', total: 100, lines: [] }],
      ],
      (rows) => seen.push(rows),
    );
    expect(count).toBe(2);
    expect(seen).toEqual([1, 1]);
    await doc.table(spec, []);
    await doc.end();
    const jsonDone = await json.close();
    const txtDone = await txt.close();

    const jsonText = await fsp.readFile(json.path, 'utf8');
    expect(Buffer.byteLength(jsonText)).toBe(jsonDone.bytes);
    expect(JSON.parse(jsonText)).toEqual({
      Skedari: { Biznesi: 'Arena "Lika" \\ çë', Qarkullimi: 1234.56 },
      'Si lexohet': ['Një.', 'Dy.'],
      Përmbledhje: { Totalet: { Fatura: 2 }, 'Sipas ditës': [{ Data: '2026-11-21' }] },
      Shitjet: [],
    });
    // The second table of the same name replaces the first in a parsed object; the text of the
    // file itself holds both, one row per line.
    expect(jsonText).toContain(
      '    {"Nr":"R-1","Totali":3.5,"Artikujt":[{"Artikulli":"Cola","Sasia":2},{"Artikulli":"Çips","Sasia":0.5}]},\n' +
        '    {"Nr":"R-2","Totali":1}\n  ]',
    );

    const text = await fsp.readFile(txt.path, 'utf8');
    expect(Buffer.byteLength(text)).toBe(txtDone.bytes);
    expect(text.startsWith('\uFEFFTitulli\n')).toBe(true);
    expect(text).toContain(
      '--- Skedari ---\n  Biznesi: Arena "Lika" \\ çë\n  Qarkullimi: 1234.56\n',
    );
    expect(text).toContain('--- Si lexohet ---\n- Një.\n- Dy.\n');
    expect(text).toMatch(/=+ PËRMBLEDHJE =+\n/);
    expect(text).toContain(
      '--- Shitjet ---\nÇdo faturë.\nKolonat: Nr | Totali\n    artikull: Artikulli | Sasia\n' +
        'R-1 | 3.50\n    artikull: Cola | 2\n    artikull: Çips | 0.5\nR-2 | 1.00\n(Rreshta: 2)\n',
    );
    expect(text).toContain('Kolonat: Nr | Totali\n    artikull: Artikulli | Sasia\n(asnjë)\n');
  });

  it('writes one format alone, and a large table without holding it', async () => {
    const json = new FileSink(path.join(dir, 'big.json'));
    const doc = new ExportDocument('en', json, null);
    await doc.begin(['unused']);
    async function* batches(): AsyncGenerator<Bill[]> {
      for (let b = 0; b < 40; b += 1) {
        yield Array.from({ length: 500 }, (_, i) => ({
          no: `R-${b * 500 + i}`,
          total: i,
          lines: [{ name: 'x'.repeat(40), qty: 1000 }],
        }));
      }
    }
    expect(await doc.table(spec, batches())).toBe(20_000);
    await doc.end();
    const done = await json.close();
    const parsed = JSON.parse(await fsp.readFile(json.path, 'utf8')) as { Sales: unknown[] };
    expect(parsed.Sales).toHaveLength(20_000);
    expect(parsed.Sales[19_999]).toEqual({
      No: 'R-19999',
      Total: 4.99,
      Lines: [{ Item: 'x'.repeat(40), Qty: 1 }],
    });
    expect(done.bytes).toBeGreaterThan(1_500_000);
    expect(done.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('a file given up', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-sink-'));
  });
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('abort() waits until the file is closed, so it can be removed at once', async () => {
    const file = path.join(dir, 'half.json.part');
    const sink = new FileSink(file);
    await sink.write('x'.repeat(200_000));
    await sink.abort();
    // Closed: removing it and its folder cannot be refused any more (Windows), and writing
    // on is an error instead of a file that grows after it was given up.
    await fsp.rm(file, { force: true });
    await expect(fsp.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    // Given up twice, or after it was closed: nothing to wait for.
    await sink.abort();
    const whole = new FileSink(path.join(dir, 'whole.txt'));
    await whole.write('abc');
    const closed = await whole.close();
    expect(closed.bytes).toBe(3);
    await whole.abort();
    expect(await fsp.readFile(path.join(dir, 'whole.txt'), 'utf8')).toBe('abc');
  });

  it('a file that cannot be opened fails the write, and can still be given up', async () => {
    const sink = new FileSink(path.join(dir, 'no-such-folder', 'a.json.part'));
    await expect(
      (async () => {
        for (let i = 0; i < 50; i += 1) await sink.write('y'.repeat(70_000));
        await sink.close();
      })(),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await sink.abort();
  });
});

describe('words and names', () => {
  const ctx = (hideCustomers: boolean) => ({ hideCustomers, lang: 'sq' }) as ExportContext;

  it('a stored code gets the word of the Admin, an unknown one stays as it is', () => {
    expect(valueOf('method', 'cash', 'sq')).toBe('Para në dorë');
    expect(valueOf('method', 'cash', 'en')).toBe('Cash');
    expect(valueOf('saleStatus', 'partially_refunded', 'sq')).toBe('Pjesërisht e rimbursuar');
    expect(valueOf('method', 'crypto_coin', 'sq')).toBe('crypto_coin');
    expect(valueOf('method', null, 'sq')).toBe('');
  });

  it('payment in words: change is taken off the cash, one method is just its name', () => {
    expect(paymentText([{ method: 'cash', amount_cents: 500 }], 200, 'sq')).toBe('Para në dorë');
    expect(
      paymentText(
        [
          { method: 'cash', amount_cents: 500 },
          { method: 'card', amount_cents: 300 },
        ],
        150,
        'sq',
      ),
    ).toBe('Para në dorë 3.50 + Kartë 3.00');
    expect(paymentText([], 0, 'sq')).toBeNull();
  });

  it('a customer is code and name, or the code alone when hidden', () => {
    expect(customerLabel(ctx(false), 'C-000001', 'Arben')).toBe('C-000001 Arben');
    expect(customerLabel(ctx(true), 'C-000001', 'Arben')).toBe('C-000001');
    expect(customerLabel(ctx(true), null, null)).toBeNull();
  });

  it('the name at the end of a desk-time line is cut off only when customers are hidden', () => {
    expect(lineText(ctx(true), 'PC time · 60 min · Arben', 'Arben')).toBe('PC time · 60 min');
    expect(lineText(ctx(false), 'PC time · 60 min · Arben', 'Arben')).toBe(
      'PC time · 60 min · Arben',
    );
    expect(lineText(ctx(true), 'Cola 0.5', null)).toBe('Cola 0.5');
    // A product that merely ends like the name of somebody else is left alone.
    expect(lineText(ctx(true), 'Pizza · Arben', 'Mimoza')).toBe('Pizza · Arben');
    // Desk time whose paid-time row is not there (imported data): the words are known, the
    // name after the minutes goes — but only on a line that is no product.
    expect(lineText(ctx(true), '60 min PC · Mysafir 580', null, true)).toBe('60 min PC');
    expect(lineText(ctx(true), 'PC time · 30 min · Arben B.', null, true)).toBe('PC time · 30 min');
    expect(lineText(ctx(true), 'PC time · 30 min', null, true)).toBe('PC time · 30 min');
    expect(lineText(ctx(true), 'Printim · Arben', null, true)).toBe('Printim · Arben');
    expect(lineText(ctx(true), '60 min PC · Arben', null, false)).toBe('60 min PC · Arben');
    expect(lineText(ctx(false), '60 min PC · Arben', null, true)).toBe('60 min PC · Arben');
  });

  it('of an action only amounts, minutes, reasons and document numbers are shown', () => {
    expect(
      auditDetail(
        {
          receiptNo: 'R-1',
          totalCents: 150,
          discountCents: 0,
          reason: 'provë',
          customerId: 'f3bc6f2e-5106-409d-a543-c0edb92a3048',
          name: 'Arben Krasniqi',
          machineId: 'PC-05-xyz',
          mac: '08:BF:B8:00:00:05',
          targets: ['192.168.1.255'],
          file: 'a.webp',
        },
        'sq',
      ),
    ).toBe('fatura R-1, totali 1.50, arsyeja provë');
    expect(auditDetail({ name: 'Arben' }, 'sq')).toBeNull();
    expect(auditDetail(null, 'sq')).toBeNull();
    expect(auditDetail(['x'], 'sq')).toBeNull();
  });

  it('the guide says what the file is, in the language asked for', () => {
    const base = {
      business: 'Arena',
      from: '2026-11-01',
      to: '2026-11-21',
      wholeHistory: false,
      timeZone: 'Europe/Belgrade',
      currency: 'EUR',
      missingParts: [],
    };
    const sq = guide({ ...base, lang: 'sq', hideCustomers: false });
    expect(sq[0]).toContain('«Arena»');
    expect(sq.join(' ')).toContain('nga 2026-11-01 deri më 2026-11-21');
    expect(sq.join(' ')).not.toContain('lënë jashtë këtij skedari');
    const hidden = guide({ ...base, lang: 'sq', hideCustomers: true, missingParts: ['stock'] });
    expect(hidden.join(' ')).toContain('çdo klient shfaqet me kodin e tij');
    expect(hidden.at(-1)).toBe(
      'Me qëllim janë lënë jashtë këtij skedari: lëvizjet dhe numërimet e stokut.',
    );
    const en = guide({ ...base, lang: 'en', hideCustomers: false, wholeHistory: true });
    expect(en[1]).toBe(
      'It covers the whole history: 2026-11-01 to 2026-11-21, both days included.',
    );
  });

  it('every table the shared list names is defined once, and reads named columns only', () => {
    expect(SECTIONS.map((s) => s.id).sort()).toEqual([...DATA_EXPORT_SECTIONS].sort());
    for (const section of SECTIONS) {
      // `*` would take whatever a table gains later (a hash, a key) into the file.
      expect(section.select, section.id).not.toMatch(/(^|[\s,.(])\*(\s|,|$)/);
      expect(section.source, section.id).toMatch(/WHERE/);
    }
  });
});

describe('the connection of the snapshot', () => {
  /** A stand-in for the database: answers each query after a moment, and keeps what it was asked. */
  function fakeClient(delayMs = 5) {
    const asked: string[] = [];
    let busy = 0;
    let overlap = false;
    return {
      asked,
      overlapped: () => overlap,
      query: async (text: string) => {
        busy += 1;
        if (busy > 1) overlap = true;
        asked.push(text);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        busy -= 1;
        if (text === 'bad') throw new Error('syntax error');
        return { rows: [{ text }], rowCount: 1 };
      },
    };
  }
  type Client = Parameters<typeof serialDb>[0];

  it('asks one query at a time, in the order they were made, and counts each answer', async () => {
    const client = fakeClient();
    let answered = 0;
    const db = serialDb(client as unknown as Client, () => {
      answered += 1;
    });
    const results = await Promise.all([db.query('a'), db.query('b'), db.query('c')]);
    expect(results.map((r) => r.rows[0])).toEqual([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    expect(client.asked).toEqual(['a', 'b', 'c']);
    expect(client.overlapped()).toBe(false);
    expect(answered).toBe(3);
  });

  it('a failed query fails alone: the ones behind it still run', async () => {
    const client = fakeClient();
    const db = serialDb(client as unknown as Client);
    const [a, bad, c] = await Promise.allSettled([db.query('a'), db.query('bad'), db.query('c')]);
    expect(a.status).toBe('fulfilled');
    expect(bad.status).toBe('rejected');
    expect(c.status).toBe('fulfilled');
    expect(client.asked).toEqual(['a', 'bad', 'c']);
  });

  it('once stopped, waiting queries are refused without reaching the database', async () => {
    const client = fakeClient(20);
    const db = serialDb(client as unknown as Client);
    const first = db.query('a'); // under way
    const waiting = [db.query('b'), db.query('c')];
    const settled = Promise.allSettled(waiting);
    await new Promise((resolve) => setTimeout(resolve, 5));
    db.stop(new Error('cancelled'));
    // The one under way ends normally; nothing is cut in the middle.
    await expect(first).resolves.toMatchObject({ rowCount: 1 });
    for (const result of await settled) {
      expect(result.status).toBe('rejected');
      expect((result as PromiseRejectedResult).reason).toMatchObject({ message: 'cancelled' });
    }
    await expect(db.query('d')).rejects.toThrow('cancelled');
    expect(client.asked).toEqual(['a']);
  });

  it('idle() waits for the query under way, so the connection goes back unused', async () => {
    const client = fakeClient(30);
    const db = serialDb(client as unknown as Client);
    let firstEnded = false;
    const first = db.query('a').then(() => {
      firstEnded = true;
    });
    void db.query('b').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5)); // 'a' is under way, 'b' waits
    db.stop(new Error('failed elsewhere'));
    // The first reason stays: a later stop does not replace it.
    db.stop(new Error('second'));
    await db.idle();
    expect(firstEnded).toBe(true);
    expect(client.asked).toEqual(['a']);
    await expect(db.query('c')).rejects.toThrow('failed elsewhere');
    await first;
    // An idle queue answers at once.
    await db.idle();
  });
});
