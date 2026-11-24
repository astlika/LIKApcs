/**
 * «Skedar për AI» (0.39.0): one small business day with every kind of row — sales paid in cash
 * (with change), by card (with a discount on the bill) and on credit, a refund, a debt payment,
 * expenses, cash in and out, a purchase from a supplier, a damaged bottle, a PC session with a
 * gift and a typed name, PC time sold at the desk for a named person, a balance top-up and an
 * internet code. The file must
 *  • state the totals of the reports, and those totals must be the sum of its own rows;
 *  • hold every row it counted, in both formats;
 *  • never hold a password hash, a PIN, an internet access code or a device key;
 *  • name no customer once «hide customers» is on;
 *  • be made only by an account that holds `reports.export_all`.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  CustomerSummary,
  DataExportJobStarted,
  DataExportJobStatus,
  DataExportResult,
  DataExportTicket,
  LoginResponse,
  ProductSummary,
  ProfitReport,
  PurchaseDetail,
  SaleDetail,
  SalesReport,
  SessionMutationResponse,
  StationSummary,
  SupplierSummary,
} from '@likapcs/shared';
import { SETTING_DEFAULTS } from '@likapcs/shared';
import { DATA_EXPORT_FOLDER, DataExportService } from '../../src/services/data-export/service.js';
import {
  authHeader,
  createTestContext,
  login,
  runSetup,
  sleep,
  type TestContext,
} from '../helpers.js';

const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: SETTING_DEFAULTS['locale.timezone'] }).format(
    new Date(),
  );
const dayBefore = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

type Row = Record<string, unknown>;
type Json = Record<string, unknown>;
const cents = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const sumOf = (rows: Row[], key: string) => rows.reduce((a, r) => a + cents(r[key]), 0);

describe('data file for an AI', () => {
  let ctx: TestContext;
  let dataDir: string;
  let owner: LoginResponse;
  let cashier: LoginResponse;
  let cola: ProductSummary;
  let chips: ProductSummary;
  let arben: CustomerSummary;
  let pc1: StationSummary;
  let saleA: SaleDetail;
  let saleB: SaleDetail;
  let saleC: SaleDetail;
  const CODES = ['TOPSECRET-AAA-001', 'TOPSECRET-AAA-002', 'TOPSECRET-AAA-003'];

  const call = <T>(
    token: string | null,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    ctx.app
      .inject({
        method,
        url: `/api/v1${url}`,
        headers: token ? authHeader(token) : {},
        payload,
      })
      .then((r) => ({
        status: r.statusCode,
        body: (String(r.headers['content-type']).includes('json') && r.body ? r.json() : null) as T,
        raw: r.rawPayload,
        headers: r.headers,
      }));

  /** Starts an export, follows it to the end and returns the result with both files' text. */
  const exportFile = async (
    body: Record<string, unknown>,
    token = owner.token,
  ): Promise<{
    result: DataExportResult;
    json: Json | null;
    jsonText: string;
    text: string;
    percents: number[];
  }> => {
    const started = await call<DataExportJobStarted>(token, 'POST', '/reports/data-file', body);
    expect(started.status).toBe(202);
    const percents: number[] = [];
    let status: DataExportJobStatus;
    for (;;) {
      status = (
        await call<DataExportJobStatus>(
          token,
          'GET',
          `/reports/data-file/jobs/${started.body.jobId}`,
        )
      ).body;
      percents.push(status.percent);
      if (status.state !== 'running') break;
      await sleep(10);
    }
    expect(status.error).toBeNull();
    expect(status.state).toBe('succeeded');
    expect(status.percent).toBe(100);
    const result = status.result!;
    let jsonText = '';
    let text = '';
    for (const file of result.files) {
      const res = await call(
        token,
        'GET',
        `/reports/data-file/${result.id}/${file.format}/download`,
      );
      expect(res.status).toBe(200);
      expect(res.raw.length).toBe(file.sizeBytes);
      expect(crypto.createHash('sha256').update(res.raw).digest('hex')).toBe(file.sha256);
      if (file.format === 'json') jsonText = res.raw.toString('utf8');
      else text = res.raw.toString('utf8');
    }
    return {
      result,
      json: jsonText ? (JSON.parse(jsonText) as Json) : null,
      jsonText,
      text,
      percents,
    };
  };

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'likapcs-export-'));
    ctx = await createTestContext({ dataDir });
    owner = await runSetup(ctx.app, 'Arena Mitrovica');
    const created = await call(owner.token, 'POST', '/users', {
      username: 'kasa',
      fullName: 'Kasa Cashier',
      password: 'Cashier123',
      roles: ['cashier'],
      mustChangePassword: false,
    });
    expect(created.status).toBe(201);
    cashier = await login(ctx.app, 'kasa', 'Cashier123');

    cola = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Cola 0.5',
        sellingPriceCents: 150,
        purchaseCostCents: 90,
        initialStockMilli: 50_000,
      })
    ).body;
    chips = (
      await call<ProductSummary>(owner.token, 'POST', '/products', {
        name: 'Chips',
        sellingPriceCents: 200,
        purchaseCostCents: 120,
        initialStockMilli: 20_000,
      })
    ).body;
    const internet = await call<{ package: { product: ProductSummary } }>(
      owner.token,
      'POST',
      '/internet-access/load',
      { package: { name: 'Internet 1h', sellingPriceCents: 100 }, codes: CODES },
    );
    expect(internet.status).toBe(201);

    arben = (
      await call<CustomerSummary>(owner.token, 'POST', '/customers', {
        name: 'Arben Krasniqi',
        phone: '+383 44 111 222',
        creditLimitCents: 1000,
      })
    ).body;
    pc1 = (
      await call<StationSummary>(owner.token, 'POST', '/stations', { number: 1, name: 'PC 1' })
    ).body;
    expect((await call(owner.token, 'POST', '/stations', { number: 2, name: 'PC 2' })).status).toBe(
      201,
    );
    expect(
      (
        await call(owner.token, 'POST', '/pricing/rules', {
          name: 'Standard',
          rateCentsPerHour: 150,
          billingIncrementMinutes: 1,
        })
      ).status,
    ).toBe(201);
    expect(
      (await call(owner.token, 'POST', '/cash/shifts/open', { openingCents: 5000 })).status,
    ).toBe(201);

    // A: two bottles, 5.00 handed over, 2.00 change.
    const a = await call<SaleDetail>(cashier.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 2000 }],
      payments: [{ method: 'cash', amountCents: 500 }],
    });
    expect(a.status).toBe(201);
    saleA = a.body;
    expect(saleA.totalCents).toBe(300);
    // B: a bottle and chips, 0.50 off the bill, by card.
    const b = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [
        { productId: cola.id, quantityMilli: 1000 },
        { productId: chips.id, quantityMilli: 1000 },
      ],
      discountCents: 50,
      payments: [{ method: 'card', amountCents: 300 }],
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    saleB = b.body;
    expect(saleB.totalCents).toBe(300);
    // C: chips on credit for Arben; he pays 1.50 of it back.
    const c = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [{ productId: chips.id, quantityMilli: 1000 }],
      customerId: arben.id,
      payments: [{ method: 'credit', amountCents: 200 }],
    });
    expect(c.status).toBe(201);
    saleC = c.body;
    const debts = await ctx.pool.query<{ id: string }>(
      'SELECT id::text FROM customer_debts WHERE sale_id = $1',
      [saleC.id],
    );
    expect(
      (
        await call(owner.token, 'POST', `/debts/${debts.rows[0]!.id}/pay`, {
          amountCents: 150,
          method: 'cash',
          tenderedCents: 150,
        })
      ).status,
    ).toBe(200);

    // One bottle of A comes back and goes on the shelf again.
    const itemsA = await ctx.pool.query<{ id: string }>(
      'SELECT id::text FROM sale_items WHERE sale_id = $1',
      [saleA.id],
    );
    expect(
      (
        await call(owner.token, 'POST', `/sales/${saleA.id}/refund`, {
          items: [{ saleItemId: Number(itemsA.rows[0]!.id), quantityMilli: 1000 }],
          reason: 'Shishja ishte e ngrohtë',
          restock: true,
          method: 'cash',
        })
      ).status,
    ).toBe(200);

    for (const expense of [
      {
        categoryCode: 'cleaning',
        amountCents: 1000,
        paymentMethod: 'cash',
        description: 'Detergjent',
      },
      {
        categoryCode: 'rent',
        amountCents: 30_000,
        paymentMethod: 'bank_transfer',
        description: 'Qiraja e nëntorit',
      },
    ]) {
      const res = await call(owner.token, 'POST', '/expenses', {
        expenseDate: today(),
        ...expense,
      });
      expect(res.status).toBe(201);
    }
    for (const move of [
      { type: 'deposit', amountCents: 2000, reason: 'Kusur për arkën' },
      { type: 'withdrawal', amountCents: 3000, reason: 'Në kasafortë' },
    ]) {
      expect((await call(owner.token, 'POST', '/cash/movements', move)).status).toBe(201);
    }

    const supplier = await call<SupplierSummary>(owner.token, 'POST', '/suppliers', {
      name: 'Pepsi Kosova',
    });
    const purchase = await call<PurchaseDetail>(owner.token, 'POST', '/purchases', {
      supplierId: supplier.body.id,
      items: [{ productId: cola.id, quantityMilli: 10_000, unitCostCents: 90 }],
      receiveNow: true,
    });
    expect(purchase.status).toBe(201);
    expect(
      (
        await call(owner.token, 'POST', `/purchases/${purchase.body.id}/payments`, {
          method: 'bank_transfer',
          amountCents: 500,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call(owner.token, 'POST', `/products/${cola.id}/stock`, {
          type: 'damaged',
          quantityMilliDelta: -1000,
          reason: 'U thye shishja',
        })
      ).status,
    ).toBe(200);

    // A paid session for a typed name, five free minutes, stopped by the staff.
    const session = await call<SessionMutationResponse>(owner.token, 'POST', '/sessions', {
      stationId: pc1.id,
      billingMode: 'prepaid',
      minutes: 30,
      customerName: 'Driton',
      paymentMethod: 'cash',
      clientRequestId: 'export-session-01',
    });
    expect(session.status).toBe(201);
    expect(
      (
        await call(owner.token, 'POST', `/sessions/${session.body.session.id}/gift`, {
          minutes: 5,
          reason: 'Na vjen keq për pritjen',
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(owner.token, 'POST', `/sessions/${session.body.session.id}/end`, {})).status,
    ).toBe(200);

    // An hour of PC time sold at the desk for Mimoza; ten euros on Arben's balance; one code.
    const time = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [{ minutes: 60, holderName: 'Mimoza' }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(time.status).toBe(201);
    expect(
      (
        await call(owner.token, 'POST', `/customers/${arben.id}/wallet/topup`, {
          amountCents: 1000,
          tenderedCents: 1000,
        })
      ).status,
    ).toBe(201);
    const code = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [{ productId: internet.body.package.product.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 100 }],
      accessCodes: true,
    });
    expect(code.status, JSON.stringify(code.body)).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await ctx.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
  });

  it('the totals are those of the reports and the sum of the rows of the file', async () => {
    const { result, json, percents } = await exportFile({ formats: ['json', 'txt'] });
    const d = json!;
    expect(result.wholeHistory).toBe(true);
    expect(result.to).toBe(today());
    expect(result.files.map((f) => f.fileName)).toEqual([
      `LIKApcs-AI-${result.from}_${result.to}.json`,
      `LIKApcs-AI-${result.from}_${result.to}.txt`,
    ]);
    // The bar never goes back and ends at 100.
    expect(percents.every((p, i) => i === 0 || p >= percents[i - 1]!)).toBe(true);

    const range = `from=${result.from}&to=${result.to}`;
    const sales = (await call<SalesReport>(owner.token, 'GET', `/reports/sales?${range}`)).body;
    const profit = (await call<ProfitReport>(owner.token, 'GET', `/reports/profit?${range}`)).body;
    const summary = d['Përmbledhje'] as Json;
    const totals = summary['Totalet e periudhës'] as Row;
    expect(totals['Fatura (numri i shitjeve)']).toBe(sales.sales.count);
    expect(cents(totals['Qarkullimi para kthimeve (me TVSH)'])).toBe(sales.sales.grossCents);
    expect(cents(totals['Kthime (shuma)'])).toBe(sales.sales.refundedCents);
    expect(cents(totals['Qarkullimi (me TVSH, pas kthimeve)'])).toBe(profit.revenue.netSalesCents);
    expect(cents(totals['TVSH brenda qarkullimit'])).toBe(profit.revenue.vatCents);
    expect(cents(totals['Kosto e mallit të shitur'])).toBe(profit.costOfSalesCents);
    expect(cents(totals['Fitimi bruto'])).toBe(profit.grossProfitCents);
    expect(cents(totals['Shpenzimet operative'])).toBe(profit.operatingExpensesCents);
    expect(cents(totals['Humbjet e stokut'])).toBe(profit.stockLossCents);
    expect(cents(totals['Fitimi neto'])).toBe(profit.netProfitCents);
    expect(cents(totals['Zbritje të dhëna mbi fatura'])).toBe(sales.sales.discountCents);
    expect(cents(totals['Të ardhura nga koha në PC (seancat)'])).toBe(sales.gaming.amountCents);
    expect(cents(totals['Paguar furnitorëve'])).toBe(500);
    // By hand: 6 bills; A 3.00 − 1.50 back, B 3.00, C 2.00, session 0.75, time 1.50, code 1.00.
    expect(sales.sales.count).toBe(6);
    expect(profit.revenue.netSalesCents).toBe(300 - 150 + 300 + 200 + 75 + 150 + 100);
    expect(profit.operatingExpensesCents).toBe(31_000);
    expect(profit.stockLossCents).toBe(90);

    // The rows under the totals add up to them.
    const rows = d['Shitjet'] as Row[];
    expect(rows).toHaveLength(6);
    expect(sumOf(rows, 'Totali')).toBe(sales.sales.grossCents);
    expect(sumOf(rows, 'Totali') - sumOf(rows, 'Kthyer')).toBe(profit.revenue.netSalesCents);
    expect(sumOf(rows, 'Zbritja')).toBe(50);
    const lines = rows.flatMap((r) => (r['Artikujt'] as Row[] | undefined) ?? []);
    expect(sumOf(lines, 'Totali') - sumOf(rows, 'Zbritja')).toBe(sales.sales.grossCents);

    const days = summary['Sipas ditës'] as Row[];
    expect(sumOf(days, 'Qarkullimi')).toBe(profit.revenue.netSalesCents);
    expect(sumOf(days, 'Kosto')).toBe(profit.costOfSalesCents);
    expect(sumOf(days, 'Shpenzime')).toBe(profit.operatingExpensesCents);
    expect(sumOf(days, 'Humbje stoku')).toBe(profit.stockLossCents);
    expect(sumOf(days, 'Fitimi neto')).toBe(profit.netProfitCents);
    const products = summary['Sipas produktit'] as Row[];
    expect(sumOf(products, 'Qarkullimi') - 50).toBe(profit.revenue.netSalesCents);
    expect(sumOf(products, 'Kosto')).toBe(profit.costOfSalesCents);
    const colaRow = products.find((p) => p['Produkti'] === 'Cola 0.5')!;
    // Three bottles sold, one came back: 2 × 1.50; cost 2 × 0.90.
    expect(colaRow).toMatchObject({ Sasia: 2, Qarkullimi: 3, Kosto: 1.8 });
    expect(products.map((p) => p['Produkti'])).toEqual(
      expect.arrayContaining(['Kohë në PC (seanca)', 'Kohë PC e shitur në banak', 'Internet 1h']),
    );
    for (const key of ['Sipas punonjësit', 'Sipas burimit', 'Sipas orës së ditës']) {
      expect(sumOf(summary[key] as Row[], 'Qarkullimi')).toBe(profit.revenue.netSalesCents);
    }
    const methods = summary['Sipas mënyrës së pagesës'] as Row[];
    expect(Object.fromEntries(methods.map((m) => [m['Mënyra'], cents(m['Shuma'])]))).toEqual({
      'Para në dorë': 300 - 150 + 75 + 150 + 100,
      Kartë: 300,
      Borxh: 200,
    });

    // The till: the shift's cash in and out are the sum of its movements.
    const shifts = d['Turnet e arkës'] as Row[];
    const moves = (d['Lëvizjet e arkës (hyrjet dhe daljet)'] as Row[]).filter(
      (m) => m['Lloji'] !== 'Gjendja fillestare',
    );
    expect(shifts).toHaveLength(1);
    const cashIn = moves.filter((m) => Number(m['Shuma']) > 0);
    const cashOut = moves.filter((m) => Number(m['Shuma']) < 0);
    expect(cents(shifts[0]!['Para të hyra'])).toBe(sumOf(cashIn, 'Shuma'));
    expect(cents(shifts[0]!['Para të dala'])).toBe(-sumOf(cashOut, 'Shuma'));
    expect(cents(shifts[0]!['Pritej'])).toBe(
      5000 + sumOf(cashIn, 'Shuma') + sumOf(cashOut, 'Shuma'),
    );
    expect(cents(totals['Hyrje në arkë (para në dorë)'])).toBe(sumOf(cashIn, 'Shuma'));
    // Cash in: A 3.00, debt 1.50, deposit 20.00, session 0.75, time 1.50, top-up 10.00, code 1.00.
    expect(sumOf(cashIn, 'Shuma')).toBe(300 + 150 + 2000 + 75 + 150 + 1000 + 100);
    // Cash out: refund 1.50, cleaning 10.00, to the safe 30.00.
    expect(-sumOf(cashOut, 'Shuma')).toBe(150 + 1000 + 3000);

    // Every table holds the rows it announced.
    const contents = d['Çfarë ka skedari (rreshta për tabelë)'] as Record<string, number>;
    for (const [name, count] of Object.entries(contents)) {
      expect((d[name] as Row[]).length, name).toBe(count);
    }
    expect(result.totalRows).toBe(Object.values(contents).reduce((a, b) => a + b, 0));
    expect(result.counts).toMatchObject({
      sales: 6,
      refunds: 1,
      sessions: 1,
      timeCredits: 1,
      shifts: 1,
      expenses: 2,
      purchases: 1,
      debts: 1,
      products: 3,
      stations: 2,
      customers: 1,
      suppliers: 1,
      users: 2,
    });
    expect(result.counts.audit).toBeUndefined();

    // The audit log remembers who took the data out.
    const audit = await ctx.pool.query<{ details: Json; severity: string }>(
      `SELECT details, severity FROM audit_logs WHERE action = 'report.data_file'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]!.severity).toBe('warning');
    expect(audit.rows[0]!.details).toMatchObject({ wholeHistory: true, hideCustomers: false });
  });

  it('shows a sale, a session, a debt and a product the way a person names them', async () => {
    const { json, text } = await exportFile({ formats: ['json', 'txt'] });
    const d = json!;
    const a = (d['Shitjet'] as Row[]).find((r) => r['Nr'] === saleA.receiptNo)!;
    expect(a).toMatchObject({
      Statusi: 'Pjesërisht e rimbursuar',
      Burimi: 'Dyqan',
      Arkëtari: 'Kasa Cashier',
      Totali: 3,
      Pagesa: 'Para në dorë',
      Kthyer: 1.5,
    });
    expect(a['Artikujt']).toEqual([
      {
        Artikulli: 'Cola 0.5',
        Sasia: 2,
        Çmimi: 1.5,
        Totali: 3,
        Kosto: 1.8,
        'Sasia e kthyer': 1,
      },
    ]);
    const b = (d['Shitjet'] as Row[]).find((r) => r['Nr'] === saleB.receiptNo)!;
    expect(b).toMatchObject({ Arkëtari: 'Shop Owner', Pagesa: 'Kartë', Zbritja: 0.5, Totali: 3 });
    const c = (d['Shitjet'] as Row[]).find((r) => r['Nr'] === saleC.receiptNo)!;
    expect(c).toMatchObject({ Pagesa: 'Borxh', Klienti: `${arben.code} Arben Krasniqi` });

    const refund = (d['Kthimet'] as Row[])[0]!;
    expect(refund).toMatchObject({
      Fatura: saleA.receiptNo,
      Lloji: 'Rimbursim',
      Shuma: 1.5,
      Arsyeja: 'Shishja ishte e ngrohtë',
      'Malli u kthye në stok': true,
    });

    const session = (d['Seancat e PC-ve'] as Row[])[0]!;
    expect(session).toMatchObject({
      PC: pc1.code,
      Mënyra: 'Parapagim',
      Çmimi: 0.75,
      Klienti: 'Driton',
      'Si mbaroi': 'Ndalur nga stafi',
    });
    expect(session['Ngjarjet']).toEqual([
      expect.objectContaining({
        Ngjarja: 'Shtim kohe',
        Minuta: 5,
        Falas: true,
        Hollësi: 'Na vjen keq për pritjen',
      }),
    ]);

    const debt = (d['Borxhet e klientëve'] as Row[])[0]!;
    expect(debt).toMatchObject({ Shuma: 2, Paguar: 1.5, Mbetja: 0.5, Fatura: saleC.receiptNo });
    expect(debt['Pagesat']).toEqual([
      expect.objectContaining({ Shuma: 1.5, Mënyra: 'Para në dorë' }),
    ]);

    const product = (d['Produktet (gjendja tani)'] as Row[]).find(
      (p) => p['Produkti'] === 'Cola 0.5',
    )!;
    // 50 − 2 − 1 + 1 back + 10 received − 1 broken.
    expect(product).toMatchObject({ Çmimi: 1.5, 'Kosto mesatare': 0.9, Stoku: 57 });
    const internet = (d['Produktet (gjendja tani)'] as Row[]).find(
      (p) => p['Produkti'] === 'Internet 1h',
    )!;
    expect(internet).toMatchObject({ 'Kode të lira': 2, 'Kode të shitura': 1 });
    const customer = (d['Klientët (gjendja tani)'] as Row[])[0]!;
    expect(customer).toMatchObject({
      Kodi: arben.code,
      Emri: 'Arben Krasniqi',
      Telefoni: '+383 44 111 222',
      Balanca: 10,
      Borxhi: 0.5,
    });
    const now = (d['Përmbledhje'] as Json)['Gjendja tani'] as Row;
    expect(now).toMatchObject({
      'Borxhe të hapura të klientëve (shuma)': 0.5,
      'Para të klientëve në balancë (ua kemi borxh)': 10,
      'Minuta PC të paguara e ende të papërdorura': 60,
    });

    // The text file: the same rows, one per line, readable; a byte-order mark for Notepad.
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('LIKApcs — të dhënat e biznesit «Arena Mitrovica»');
    expect(text).toContain(
      `${saleA.receiptNo} | ${String(a['Koha'])} | Pjesërisht e rimbursuar | Dyqan | Kasa Cashier | 3.00 | Para në dorë`,
    );
    expect(text).toContain('    artikull: Cola 0.5 | 2 | 1.50 | 3.00 | 1.80 ; Sasia e kthyer: 1');
    const contents = d['Çfarë ka skedari (rreshta për tabelë)'] as Record<string, number>;
    for (const [name, count] of Object.entries(contents)) {
      const at = text.indexOf(`--- ${name} ---`);
      expect(at, name).toBeGreaterThan(-1);
      const rest = text.slice(at + name.length + 8);
      const end = rest.indexOf('\n--- ');
      const block = end === -1 ? rest : rest.slice(0, end);
      expect(block, name).toContain(count === 0 ? '(asnjë)' : `(Rreshta: ${count})`);
    }
  });

  it('never holds a password hash, a PIN, an internet code or a key — in any choice of parts', async () => {
    const secrets = await ctx.pool.query<{ v: string }>(
      `SELECT password_hash AS v FROM users
       UNION ALL SELECT token_hash FROM user_sessions
       UNION ALL SELECT pin_hash FROM time_credits WHERE pin_hash IS NOT NULL`,
    );
    expect(secrets.rows.length).toBeGreaterThan(3);
    const { jsonText, text, result } = await exportFile({
      formats: ['json', 'txt'],
      parts: ['sales', 'gaming', 'cash', 'stock', 'purchases', 'customers', 'lists', 'audit'],
    });
    expect(result.counts.audit).toBeGreaterThan(10);
    for (const out of [jsonText, text]) {
      for (const { v } of secrets.rows) expect(out).not.toContain(v);
      for (const code of CODES) expect(out).not.toContain(code);
      expect(out).not.toMatch(/argon2|\$2[aby]\$|scrypt/i);
      expect(out.toLowerCase()).not.toContain('password');
    }
    // The action log names the action and its figures, not what else the program wrote down.
    const audit = (JSON.parse(jsonText) as Json)['Regjistri i veprimeve'] as Row[];
    const refund = audit.find((r) => r['Veprimi'] === 'sale.refunded')!;
    expect(refund).toMatchObject({ Kush: 'Shop Owner', Rëndësia: 'kujdes' });
    expect(String(refund['Hollësi'])).toContain(`fatura ${saleA.receiptNo}`);
    expect(String(refund['Hollësi'])).toContain('totali 1.50');
    const created = audit.find((r) => r['Veprimi'] === 'customer.create')!;
    expect(created['Hollësi']).toBeUndefined();
  });

  it('names no customer when customers are hidden', async () => {
    const { jsonText, text, json } = await exportFile({
      formats: ['json', 'txt'],
      hideCustomers: true,
      parts: ['sales', 'gaming', 'cash', 'stock', 'purchases', 'customers', 'lists', 'audit'],
    });
    for (const out of [jsonText, text]) {
      for (const name of ['Arben', 'Krasniqi', '+383', '111 222', 'Driton', 'Mimoza']) {
        expect(out, name).not.toContain(name);
      }
      expect(out).toContain(arben.code);
    }
    const d = json!;
    expect((d['Skedari'] as Row)['Klientët e fshehur']).toBe(true);
    const c = (d['Shitjet'] as Row[]).find((r) => r['Nr'] === saleC.receiptNo)!;
    expect(c['Klienti']).toBe(arben.code);
    const customer = (d['Klientët (gjendja tani)'] as Row[])[0]!;
    expect(customer).toEqual({
      Kodi: arben.code,
      Balanca: 10,
      Borxhi: 0.5,
      Statusi: 'Aktiv',
      'Regjistruar më': expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    });
    // PC time sold at the desk keeps what was sold, without the name it was sold for.
    const lines = (d['Shitjet'] as Row[]).flatMap((r) => (r['Artikujt'] as Row[]) ?? []);
    expect(lines.map((l) => l['Artikulli'])).toContain('PC time · 60 min');
    // The staff are still named: the owner asks about them.
    expect(jsonText).toContain('Kasa Cashier');
  });

  it('covers the days asked for, leaves parts out, and speaks English when asked', async () => {
    // Yesterday and the day before: nothing happened, and the file says so with zeros.
    const empty = await exportFile({
      formats: ['json'],
      from: dayBefore(today(), 2),
      to: dayBefore(today(), 1),
    });
    expect(empty.result).toMatchObject({ wholeHistory: false, from: dayBefore(today(), 2) });
    expect(empty.result.counts).toMatchObject({ sales: 0, sessions: 0, expenses: 0, shifts: 0 });
    // Lists and open debts are "as they are now", whatever the period.
    expect(empty.result.counts).toMatchObject({ products: 3, debts: 1, timeCredits: 1 });
    const totals = (empty.json!['Përmbledhje'] as Json)['Totalet e periudhës'] as Row;
    expect(totals['Fatura (numri i shitjeve)']).toBe(0);
    expect(totals['Qarkullimi (me TVSH, pas kthimeve)']).toBe(0);
    expect(empty.text).toBe('');

    // Today only, summary alone: no table of rows at all.
    const summary = await exportFile({ formats: ['txt'], from: today(), to: today(), parts: [] });
    expect(summary.result.totalRows).toBe(0);
    expect(summary.jsonText).toBe('');
    expect(summary.text).toContain('PËRMBLEDHJE');
    expect(summary.text).toContain('--- Sipas produktit ---');
    expect(summary.text).not.toContain('--- Shitjet ---');
    expect(summary.text).toContain('Me qëllim janë lënë jashtë këtij skedari:');

    const english = await exportFile({ formats: ['json'], language: 'en', parts: ['sales'] });
    const sales = english.json!['Sales'] as Row[];
    expect(sales).toHaveLength(6);
    expect(sales.find((r) => r['No'] === saleA.receiptNo)).toMatchObject({
      Status: 'Partially refunded',
      Payment: 'Cash',
      Total: 3,
    });
    expect(english.json!['Summary']).toBeDefined();
    expect(english.json!['PC sessions']).toBeUndefined();
  });

  it('every product has its sales, its profit and its stock — also with the summaries alone', async () => {
    // Six more products, none of them sold: nothing left, a little left, not counted, two
    // archived (one with goods still on the shelf). And the chips, sold above, are archived.
    const make = async (payload: Record<string, unknown>): Promise<ProductSummary> => {
      const res = await call<ProductSummary>(owner.token, 'POST', '/products', payload);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return res.body;
    };
    const setActive = async (product: ProductSummary, isActive: boolean) => {
      const res = await call(owner.token, 'PATCH', `/products/${product.id}`, { isActive });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    await make({ name: 'Fanta 0.5', sellingPriceCents: 150, purchaseCostCents: 80 });
    await make({
      name: 'Sprite 0.5',
      sellingPriceCents: 150,
      purchaseCostCents: 80,
      initialStockMilli: 4000,
      minStockMilli: 10_000,
    });
    await make({ name: 'Kafe', sellingPriceCents: 100, trackStock: false });
    const old = await make({
      name: 'Çokollatë e vjetër',
      sellingPriceCents: 200,
      purchaseCostCents: 50,
      initialStockMilli: 3000,
    });
    const gone = await make({ name: 'Akullore e hequr', sellingPriceCents: 100 });
    await setActive(old, false);
    await setActive(gone, false);
    await setActive(chips, false);
    // The bottles get a category; the chips and the internet codes have none.
    const drinks = await call<{ id: string }>(owner.token, 'POST', '/catalog/categories', {
      name: 'Pije',
    });
    expect(drinks.status, JSON.stringify(drinks.body)).toBe(201);
    const setCategory = async (categoryId: string | null) => {
      const res = await call(owner.token, 'PATCH', `/products/${cola.id}`, { categoryId });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    await setCategory(drinks.body.id);

    try {
      const { json, text } = await exportFile({ formats: ['json', 'txt'], parts: [] });
      const summary = json!['Përmbledhje'] as Json;
      // Summaries alone: no list of products at the end, and still every product is there.
      expect(json!['Produktet (gjendja tani)']).toBeUndefined();
      const byProduct = summary['Sipas produktit'] as Row[];
      const stock = summary['Stoku tani sipas produktit'] as Row[];
      const totals = summary['Totalet e periudhës'] as Row;
      const now = summary['Gjendja tani'] as Row;
      const named = (rows: Row[], name: string) => rows.find((r) => r['Produkti'] === name);

      // 1. Sales and profit of every product. The ones sold first, most turnover first; then
      //    every active product that did not sell, with zeros, by name.
      expect(byProduct.map((r) => r['Produkti'])).toEqual([
        'Chips',
        'Cola 0.5',
        'Kohë PC e shitur në banak',
        'Internet 1h',
        'Kohë në PC (seanca)',
        'Fanta 0.5',
        'Kafe',
        'Sprite 0.5',
      ]);
      // Three bottles on two bills, one came back: 2 × 1.50, cost 2 × 0.90, 57 on the shelf.
      const colaRow = named(byProduct, 'Cola 0.5')!;
      expect(colaRow).toMatchObject({
        Sasia: 2,
        Fatura: 2,
        Qarkullimi: 3,
        Kosto: 1.8,
        'Sasia e kthyer': 1,
        'Stoku tani': 57,
        'Gjendja e stokut': 'Ka stok',
      });
      for (const row of byProduct) {
        const profit = cents(row['Qarkullimi']) - cents(row['TVSH']) - cents(row['Kosto']);
        expect(cents(row['Fitimi bruto']), String(row['Produkti'])).toBe(profit);
        const revenue = cents(row['Qarkullimi']) - cents(row['TVSH']);
        // The margin is the profit's share of the revenue without VAT; none where nothing sold.
        if (revenue > 0) {
          expect(row['Marzhi bruto'], String(row['Produkti'])).toBe(
            Math.round((profit * 10_000) / revenue) / 100,
          );
        } else {
          expect(row['Marzhi bruto']).toBeUndefined();
        }
      }
      expect(cents(colaRow['Fitimi për njësi'])).toBe(
        Math.round(cents(colaRow['Fitimi bruto']) / 2),
      );
      // Sold and archived since: its sales stay, and it says that it is not sold any more.
      expect(named(byProduct, 'Chips')).toMatchObject({
        Sasia: 2,
        'Stoku tani': 18,
        Joaktiv: true,
      });
      // Not sold: there with zeros and its stock, so "what does not sell?" has an answer.
      expect(named(byProduct, 'Fanta 0.5')).toMatchObject({
        Sasia: 0,
        Fatura: 0,
        Qarkullimi: 0,
        'Fitimi bruto': 0,
        'Stoku tani': 0,
        'Gjendja e stokut': 'Pa stok',
      });
      expect(named(byProduct, 'Sprite 0.5')).toMatchObject({
        Sasia: 0,
        'Stoku tani': 4,
        'Gjendja e stokut': 'Stok i ulët',
      });
      const kafe = named(byProduct, 'Kafe')!;
      expect(kafe).toMatchObject({ Sasia: 0, 'Gjendja e stokut': 'Stoku nuk ndiqet' });
      expect(kafe['Stoku tani']).toBeUndefined();
      // PC time is not goods: no stock, no state, no profit "per unit".
      const pcTime = named(byProduct, 'Kohë në PC (seanca)')!;
      expect(pcTime['Gjendja e stokut']).toBeUndefined();
      expect(pcTime['Fitimi për njësi']).toBeUndefined();
      // Archived and never sold: not here.
      expect(named(byProduct, 'Çokollatë e vjetër')).toBeUndefined();
      expect(named(byProduct, 'Akullore e hequr')).toBeUndefined();
      // The rows with zeros change no total: the products still add up to the turnover (the
      // 0.50 taken off a whole bill is not on any line) and to the cost of the goods sold.
      expect(sumOf(byProduct, 'Qarkullimi') - 50).toBe(
        cents(totals['Qarkullimi (me TVSH, pas kthimeve)']),
      );
      expect(sumOf(byProduct, 'Kosto')).toBe(cents(totals['Kosto e mallit të shitur']));
      // A bill with two products counts for both, so the column adds up to the bills or more.
      expect(byProduct.reduce((n, r) => n + Number(r['Fatura']), 0)).toBeGreaterThanOrEqual(
        Number(totals['Fatura (numri i shitjeve)']),
      );

      // By category: what the products of each category sold, cost and earned — to the cent
      // the sum of their rows above. PC time has no category and is in neither row.
      const byCategory = summary['Sipas kategorisë'] as Row[];
      expect(byCategory.map((r) => r['Kategoria']).sort()).toEqual(['(pa kategori)', 'Pije']);
      const goods = byProduct.filter((r) => r['SKU'] !== undefined);
      for (const row of byCategory) {
        const name = row['Kategoria'] === 'Pije' ? 'Pije' : undefined;
        const members = goods.filter((r) => r['Kategoria'] === name);
        for (const key of ['Qarkullimi', 'TVSH', 'Kosto', 'Fitimi bruto']) {
          expect(cents(row[key]), `${String(row['Kategoria'])} ${key}`).toBe(sumOf(members, key));
        }
      }
      expect(named(byProduct, 'Cola 0.5')).toMatchObject({ Kategoria: 'Pije' });
      expect(byCategory.find((r) => r['Kategoria'] === 'Pije')).toMatchObject({
        'Rreshta shitjesh': 2,
        Qarkullimi: 3,
        Kosto: 1.8,
        'Marzhi bruto': colaRow['Marzhi bruto'],
      });

      // 2. The stock now: nothing left first, then low, then in stock, last the uncounted;
      //    by name inside each («Ç» after «C», as a person looks for it).
      expect(stock.map((r) => [r['Produkti'], r['Gjendja e stokut']])).toEqual([
        ['Fanta 0.5', 'Pa stok'],
        ['Internet 1h', 'Stok i ulët'],
        ['Sprite 0.5', 'Stok i ulët'],
        ['Chips', 'Ka stok'],
        ['Cola 0.5', 'Ka stok'],
        ['Çokollatë e vjetër', 'Ka stok'],
        ['Kafe', 'Stoku nuk ndiqet'],
      ]);
      expect(named(stock, 'Sprite 0.5')).toEqual({
        Produkti: 'Sprite 0.5',
        'Gjendja e stokut': 'Stok i ulët',
        Stoku: 4,
        'Stoku minimal': 10,
        'Shitur në periudhë': 0,
        'Kosto mesatare': 0.8,
        'Vlera e stokut me kosto': 3.2,
        Çmimi: 1.5,
        'Vlera e stokut me çmim shitjeje': 6,
        SKU: expect.any(String),
      });
      expect(named(stock, 'Cola 0.5')).toMatchObject({
        Stoku: 57,
        'Shitur në periudhë': 2,
        'Vlera e stokut me kosto': 51.3,
        'Vlera e stokut me çmim shitjeje': 85.5,
      });
      // Two codes left of three, and the package warns at ten: low.
      expect(named(stock, 'Internet 1h')).toMatchObject({ Stoku: 2, 'Shitur në periudhë': 1 });
      // Archived with goods still on the shelf: listed, marked, and counted in the value.
      expect(named(stock, 'Çokollatë e vjetër')).toMatchObject({
        Stoku: 3,
        'Vlera e stokut me kosto': 1.5,
        Joaktiv: true,
      });
      expect(named(stock, 'Chips')).toMatchObject({ Stoku: 18, Joaktiv: true });
      const kafeStock = named(stock, 'Kafe')!;
      expect(kafeStock['Stoku']).toBeUndefined();
      expect(kafeStock['Vlera e stokut me kosto']).toBeUndefined();
      expect(named(stock, 'Akullore e hequr')).toBeUndefined();

      // 3. «Gjendja tani» counts the same rows: the states add up to the active products, and
      //    the values are the sums of the table.
      expect(now).toMatchObject({
        'Produkte aktive': 5,
        'Aktive me stok (bashkë me ato me stok të ulët)': 3,
        'Aktive me stok të ulët': 2,
        'Aktive pa stok': 1,
        'Aktive ku stoku nuk ndiqet': 1,
        'Joaktive që kanë ende stok': 2,
      });
      expect(stock).toHaveLength(5 + 2);
      expect(cents(now['Vlera e stokut me kosto'])).toBe(sumOf(stock, 'Vlera e stokut me kosto'));
      expect(cents(now['Vlera e stokut me kosto'])).toBe(320 + 2160 + 5130 + 150);
      expect(cents(now['Vlera e stokut me çmim shitjeje'])).toBe(
        sumOf(stock, 'Vlera e stokut me çmim shitjeje'),
      );

      // 4. The text file says the same, a product a line, with the state in words.
      expect(text).toContain('--- Stoku tani sipas produktit ---');
      expect(text).toContain(
        'Kolonat: Produkti | Kategoria | Gjendja e stokut | Stoku | Stoku minimal | Shitur në periudhë | Kosto mesatare | Vlera e stokut me kosto | Çmimi | Vlera e stokut me çmim shitjeje',
      );
      expect(text).toContain(
        'Fanta 0.5 | - | Pa stok | 0 | 0 | 0 | 0.80 | 0.00 | 1.50 | 0.00 ; SKU: ',
      );
      expect(text).toContain(
        'Sprite 0.5 | - | Stok i ulët | 4 | 10 | 0 | 0.80 | 3.20 | 1.50 | 6.00 ; SKU: ',
      );
      expect(text).toContain(
        'Kafe | - | Stoku nuk ndiqet | - | - | 0 | 0.00 | - | 1.00 | - ; SKU: ',
      );
      expect(text).toContain(
        'Kolonat: Produkti | Kategoria | Sasia | Fatura | Qarkullimi | TVSH | Kosto | Fitimi bruto | Marzhi bruto | Stoku tani',
      );
      expect(text).toContain(
        'Fanta 0.5 | - | 0 | 0 | 0.00 | 0.00 | 0.00 | 0.00 | - | 0 ; Gjendja e stokut: Pa stok ; SKU: ',
      );
      expect(text).toMatch(
        /\nCola 0\.5 \| Pije \| 2 \| 2 \| 3\.00 \| \d+\.\d\d \| 1\.80 \| \d+\.\d\d \| \d+\.\d\d % \| 57 ; Gjendja e stokut: Ka stok ; Fitimi për njësi: \d+\.\d\d ; Sasia e kthyer: 1 ; /,
      );
      // The guide at the top tells the reader where the products are.
      expect(text).toContain(
        'tabela «Stoku tani sipas produktit» tregon për çdo produkt a ka stok',
      );
      expect(text).toContain('Versioni i formatit: 3');

      // 5. With the lists: the list of products names the state too.
      const full = await exportFile({ formats: ['json'], parts: ['lists'] });
      const list = full.json!['Produktet (gjendja tani)'] as Row[];
      expect(named(list, 'Fanta 0.5')).toMatchObject({ Stoku: 0, 'Gjendja e stokut': 'Pa stok' });
      expect(named(list, 'Sprite 0.5')).toMatchObject({
        Stoku: 4,
        'Stoku minimal': 10,
        'Gjendja e stokut': 'Stok i ulët',
      });
      expect(named(list, 'Kafe')).toMatchObject({ 'Gjendja e stokut': 'Stoku nuk ndiqet' });
      expect(named(list, 'Akullore e hequr')).toMatchObject({ Joaktiv: true });

      // 6. In English, and for two days on which nothing was sold: every product with zeros,
      //    the stock as it is now.
      const quiet = await exportFile({
        formats: ['json'],
        language: 'en',
        parts: [],
        from: dayBefore(today(), 2),
        to: dayBefore(today(), 1),
      });
      const quietSummary = quiet.json!['Summary'] as Json;
      const quietProducts = quietSummary['By product'] as Row[];
      expect(quietProducts.map((r) => r['Product'])).toEqual([
        'Cola 0.5',
        'Fanta 0.5',
        'Internet 1h',
        'Kafe',
        'Sprite 0.5',
      ]);
      expect(quietProducts.every((r) => r['Qty'] === 0 && r['Turnover'] === 0)).toBe(true);
      expect(quietProducts[0]).toMatchObject({ 'Stock now': 57, 'Stock state': 'In stock' });
      const quietStock = quietSummary['Stock now by product'] as Row[];
      expect(
        quietStock.map((r) => [r['Product'], r['Stock state'], r['Sold in the period']]),
      ).toEqual([
        ['Fanta 0.5', 'Out of stock', 0],
        ['Internet 1h', 'Low stock', 0],
        ['Sprite 0.5', 'Low stock', 0],
        ['Chips', 'In stock', 0],
        // In English «Ç» is a C: "Çok…" comes before "Col…" (in Albanian it follows every C).
        ['Çokollatë e vjetër', 'In stock', 0],
        ['Cola 0.5', 'In stock', 0],
        ['Kafe', 'Stock not tracked', 0],
      ]);
      expect(quietSummary['Now']).toMatchObject({
        'Active products': 5,
        'Active, out of stock': 1,
        'Active, low on stock': 2,
      });
    } finally {
      await setActive(chips, true);
      await setCategory(null);
    }
  });

  it('is refused without the permission, and the files open only with the sign-in or a ticket', async () => {
    const body = { formats: ['json'] };
    expect((await call(null, 'POST', '/reports/data-file', body)).status).toBe(401);
    // A cashier has no such permission; an accountant may export reports, but not this.
    expect((await call(cashier.token, 'POST', '/reports/data-file', body)).status).toBe(403);
    const { rows } = await ctx.pool.query<{ code: string }>(
      `SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
        WHERE rp.permission_code = 'reports.export_all' ORDER BY r.code`,
    );
    expect(rows.map((r) => r.code)).toEqual(['admin', 'owner']);

    expect((await call(owner.token, 'POST', '/reports/data-file', { formats: [] })).status).toBe(
      400,
    );
    expect(
      (await call(owner.token, 'POST', '/reports/data-file', { formats: ['json'], from: today() }))
        .status,
    ).toBe(400);
    expect(
      (
        await call(owner.token, 'POST', '/reports/data-file', {
          formats: ['json'],
          from: today(),
          to: dayBefore(today(), 1),
        })
      ).status,
    ).toBe(400);

    const { result } = await exportFile({ formats: ['json'] });
    const url = `/reports/data-file/${result.id}/json/download`;
    expect((await call(null, 'GET', url)).status).toBe(401);
    expect((await call(cashier.token, 'GET', url)).status).toBe(403);
    expect((await call(null, 'GET', `${url}?ticket=nope`)).status).toBe(403);
    const ticket = await call<DataExportTicket>(owner.token, 'POST', `${url}-ticket`, {});
    expect(ticket.status).toBe(200);
    const byTicket = await call(null, 'GET', `${url}?ticket=${ticket.body.ticket}`);
    expect(byTicket.status).toBe(200);
    expect(byTicket.headers['content-disposition']).toBe(
      `attachment; filename="${result.files[0]!.fileName}"`,
    );
    // The ticket of one file does not open the other format.
    expect(
      (
        await call(
          null,
          'GET',
          `/reports/data-file/${result.id}/txt/download?ticket=${ticket.body.ticket}`,
        )
      ).status,
    ).toBe(403);
    // A format that was not asked for is not there.
    expect(
      (await call(owner.token, 'GET', `/reports/data-file/${result.id}/txt/download`)).status,
    ).toBe(404);

    // Deleted on request: the file is gone from the disk and from the API.
    const dir = path.join(dataDir, DATA_EXPORT_FOLDER, result.id);
    expect((await fsp.readdir(dir)).sort()).toEqual([result.files[0]!.fileName]);
    expect((await call(owner.token, 'DELETE', `/reports/data-file/${result.id}`)).status).toBe(204);
    expect((await call(owner.token, 'GET', url)).status).toBe(404);
    await expect(fsp.stat(dir)).rejects.toThrow();
  });

  it('sees one moment: a sale made while the file is written is not half in it', async () => {
    const before = await exportFile({ formats: ['json'], parts: ['sales', 'cash'] });
    const billsBefore = (before.json!['Shitjet'] as Row[]).length;
    const dir = path.join(dataDir, 'exports-snapshot');
    let soldMeanwhile: SaleDetail | null = null;
    const service = new DataExportService(ctx.pool, ctx.app.services.settings, {
      dir,
      version: 'test',
      keepMs: 400,
      // The rows are counted and the summary is not written yet: sell two bottles right now.
      onSnapshot: async () => {
        const sold = await call<SaleDetail>(owner.token, 'POST', '/sales', {
          items: [{ productId: cola.id, quantityMilli: 2000 }],
          payments: [{ method: 'cash', amountCents: 300 }],
        });
        expect(sold.status).toBe(201);
        soldMeanwhile = sold.body;
      },
    });
    const started = service.start(
      { formats: ['json'], parts: ['sales', 'cash'], hideCustomers: false, language: 'sq' },
      { userId: owner.user.id, label: 'owner', name: 'Shop Owner' },
    );
    for (;;) {
      if (service.job(started.id).state !== 'running') break;
      await sleep(10);
    }
    const job = service.job(started.id);
    expect(job.error).toBeNull();
    expect(soldMeanwhile).not.toBeNull();
    const file = service.file(started.id, 'json');
    const d = JSON.parse(await fsp.readFile(file.path, 'utf8')) as Json;
    const rows = d['Shitjet'] as Row[];
    const totals = (d['Përmbledhje'] as Json)['Totalet e periudhës'] as Row;
    // Neither the list nor the totals nor the drawer know the new sale: one moment, all of it.
    expect(rows).toHaveLength(billsBefore);
    expect(rows.map((r) => r['Nr'])).not.toContain(soldMeanwhile!.receiptNo);
    expect(totals['Fatura (numri i shitjeve)']).toBe(billsBefore);
    expect(sumOf(rows, 'Totali') - sumOf(rows, 'Kthyer')).toBe(
      cents(totals['Qarkullimi (me TVSH, pas kthimeve)']),
    );
    const moves = d['Lëvizjet e arkës (hyrjet dhe daljet)'] as Row[];
    expect(moves.map((m) => m['Fatura'])).not.toContain(soldMeanwhile!.receiptNo);
    expect(cents(totals['Hyrje në arkë (para në dorë)'])).toBe(
      sumOf(
        moves.filter((m) => m['Lloji'] !== 'Gjendja fillestare' && Number(m['Shuma']) > 0),
        'Shuma',
      ),
    );
    // Kept for a moment only (an hour in the program): the file is gone by itself.
    expect((await fsp.readdir(dir)).length).toBe(1);
    await sleep(700);
    expect(await fsp.readdir(dir)).toEqual([]);
    expect(() => service.job(started.id)).toThrow(/not found/);
    await fsp.rm(dir, { recursive: true, force: true });
    // The next file has it.
    const after = await exportFile({ formats: ['json'], parts: ['sales'] });
    expect((after.json!['Shitjet'] as Row[]).map((r) => r['Nr'])).toContain(
      soldMeanwhile!.receiptNo,
    );
  });

  it('can be given up while it is made: nothing is left, and the next one starts at once', async () => {
    const dir = path.join(dataDir, 'exports-cancel');
    const actor = { userId: owner.user.id, label: 'owner', name: 'Shop Owner' };
    const input = {
      formats: ['json' as const, 'txt' as const],
      hideCustomers: false,
      language: 'sq' as const,
    };
    const auditRows = async () =>
      (
        await ctx.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM audit_logs WHERE action = 'report.data_file'`,
        )
      ).rows[0]!.n;
    const auditBefore = await auditRows();
    const untilEnded = async (service: DataExportService, id: string) => {
      for (;;) {
        const job = service.job(id);
        if (job.state !== 'running') return job;
        await sleep(10);
      }
    };

    // 1. Given up right after the rows were counted, before a row is written.
    let cancelNow: (() => Promise<void>) | null = null;
    const service = new DataExportService(ctx.pool, ctx.app.services.settings, {
      dir,
      version: 'test',
      onSnapshot: async () => {
        await cancelNow?.();
      },
    });
    const first = service.start(input, actor);
    cancelNow = () => service.delete(first.id);
    const ended = await untilEnded(service, first.id);
    expect(ended.state).toBe('failed');
    expect(ended.error?.code).toBe('EXPORT_CANCELLED');
    expect(ended.result).toBeNull();
    expect(ended.percent).toBeLessThan(100);
    expect(await fsp.readdir(dir)).toEqual([]);
    expect(() => service.file(first.id, 'json')).toThrow(/not found/);
    expect(await auditRows()).toBe(auditBefore);

    // 2. Given up while the rows are being read: the hook is over, the tables are under way.
    cancelNow = null;
    const second = service.start(input, actor);
    for (;;) {
      const job = service.job(second.id);
      if (job.state !== 'running' || job.phase !== 'starting') break;
      await sleep(1);
    }
    await service.delete(second.id);
    const endedSecond = await untilEnded(service, second.id);
    // On data this small the job may be done before the cancel lands: both ends are clean.
    if (endedSecond.state === 'failed') {
      expect(endedSecond.error?.code).toBe('EXPORT_CANCELLED');
      expect(await fsp.readdir(dir)).toEqual([]);
    } else {
      expect(endedSecond.state).toBe('succeeded');
      await service.delete(second.id);
      expect(await fsp.readdir(dir)).toEqual([]);
    }

    // 3. The connection went back clean and the service is free: the next file is whole.
    const third = service.start(input, actor);
    const endedThird = await untilEnded(service, third.id);
    expect(endedThird.error).toBeNull();
    expect(endedThird.state).toBe('succeeded');
    const file = service.file(third.id, 'json');
    const d = JSON.parse(await fsp.readFile(file.path, 'utf8')) as Json;
    expect((d['Shitjet'] as Row[]).length).toBeGreaterThan(0);
    await service.delete(third.id);
    expect(await fsp.readdir(dir)).toEqual([]);
    // No connection went back to the pool still inside the read-only transaction of a job that
    // was given up: the next sale on it would be refused.
    const open = await ctx.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state LIKE 'idle in transaction%'`,
    );
    expect(open.rows[0]!.n).toBe('0');
    const sold = await call<SaleDetail>(owner.token, 'POST', '/sales', {
      items: [{ productId: cola.id, quantityMilli: 1000 }],
      payments: [{ method: 'cash', amountCents: 150 }],
    });
    expect(sold.status).toBe(201);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('given up in the very last step, it still ends as cancelled with nothing left', async () => {
    const dir = path.join(dataDir, 'exports-late-cancel');
    const actor = { userId: owner.user.id, label: 'owner', name: 'Shop Owner' };
    let jobId: string | null = null;
    let cancelledAtAudit = false;
    // The last thing a job does is write its line in the action log: cancel exactly then.
    // (The files are complete and named at that moment.)
    const pool = {
      connect: () => ctx.pool.connect(),
      query: async (text: string, values?: unknown[]) => {
        if (jobId && text.includes('INSERT INTO audit_logs')) {
          expect((await fsp.readdir(path.join(dir, jobId))).sort()).toEqual(
            ['json', 'txt'].map((ext) => expect.stringMatching(new RegExp(`\\.${ext}$`))),
          );
          await service.delete(jobId);
          cancelledAtAudit = true;
        }
        return ctx.pool.query(text, values);
      },
    } as unknown as typeof ctx.pool;
    const service: DataExportService = new DataExportService(pool, ctx.app.services.settings, {
      dir,
      version: 'test',
    });
    const started = service.start(
      { formats: ['json', 'txt'], hideCustomers: false, language: 'sq' },
      actor,
    );
    jobId = started.id;
    for (;;) {
      if (service.job(started.id).state !== 'running') break;
      await sleep(10);
    }
    expect(cancelledAtAudit).toBe(true);
    const ended = service.job(started.id);
    expect(ended.state).toBe('failed');
    expect(ended.error?.code).toBe('EXPORT_CANCELLED');
    expect(ended.result).toBeNull();
    expect(() => service.file(started.id, 'json')).toThrow(/not found/);
    expect(await fsp.readdir(dir)).toEqual([]);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('a folder that cannot be removed now is tried again until it is gone', async () => {
    const dir = path.join(dataDir, 'exports-stuck');
    const actor = { userId: owner.user.id, label: 'owner', name: 'Shop Owner' };
    const service = new DataExportService(ctx.pool, ctx.app.services.settings, {
      dir,
      version: 'test',
      retryRemoveMs: 40,
    });
    const started = service.start(
      { formats: ['txt'], parts: [], hideCustomers: false, language: 'sq' },
      actor,
    );
    for (;;) {
      if (service.job(started.id).state !== 'running') break;
      await sleep(10);
    }
    expect(service.job(started.id).state).toBe('succeeded');
    const jobDir = path.join(dir, started.id);
    // Stands in for Windows holding the file open: nothing can be removed from the folder.
    await fsp.chmod(jobDir, 0o555);
    const blocked = process.getuid?.() !== 0;
    try {
      // The delete itself never fails and does not wait for the folder.
      await expect(service.delete(started.id)).resolves.toBeUndefined();
      expect(() => service.job(started.id)).toThrow(/not found/);
      if (blocked) expect(await fsp.readdir(jobDir)).toHaveLength(1);
      await sleep(150);
      if (blocked) expect(await fsp.readdir(jobDir)).toHaveLength(1);
    } finally {
      await fsp.chmod(jobDir, 0o755).catch(() => undefined);
    }
    // Free again: the next try removes it, nobody has to ask.
    for (let i = 0; i < 100 && (await fsp.readdir(dir)).length > 0; i += 1) await sleep(20);
    expect(await fsp.readdir(dir)).toEqual([]);
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('is cancelled through the API as well', async () => {
    const started = await call<{ jobId: string }>(owner.token, 'POST', '/reports/data-file', {
      formats: ['json'],
    });
    expect(started.status).toBe(202);
    // Still running or just done: either way the answer is 204 and nothing stays on the disk.
    const cancelled = await call(owner.token, 'DELETE', `/reports/data-file/${started.body.jobId}`);
    expect(cancelled.status).toBe(204);
    for (;;) {
      const job = await call<{ state: string; error: { code: string } | null }>(
        owner.token,
        'GET',
        `/reports/data-file/jobs/${started.body.jobId}`,
      );
      if (job.status === 404) break; // it had finished: the delete removed it
      expect(job.status).toBe(200);
      if (job.body.state === 'running') {
        await sleep(10);
        continue;
      }
      expect(job.body.state).toBe('failed');
      expect(job.body.error?.code).toBe('EXPORT_CANCELLED');
      break;
    }
    expect(
      (
        await fsp.readdir(path.join(dataDir, DATA_EXPORT_FOLDER)).catch((): string[] => [])
      ).includes(started.body.jobId),
    ).toBe(false);
    // And the service takes the next one.
    const next = await exportFile({ formats: ['txt'] });
    expect(next.result.totalRows).toBeGreaterThan(0);
  });

  it('at the start of the server, deletes the files of the run before and nothing else', async () => {
    const dir = path.join(dataDir, 'exports-leftovers');
    const jobDir = path.join(dir, '3f2b8c1e-7a4d-4e0b-9c55-0a1b2c3d4e5f');
    const otherDir = path.join(dir, 'my-own-folder');
    await fsp.mkdir(jobDir, { recursive: true });
    await fsp.mkdir(otherDir, { recursive: true });
    await fsp.writeFile(path.join(jobDir, 'LIKApcs-AI-2026-01-01_2026-01-31.json'), '{}');
    await fsp.writeFile(path.join(jobDir, 'LIKApcs-AI-2026-01-01_2026-01-31.txt.part'), 'half');
    await fsp.writeFile(path.join(otherDir, 'notes.txt'), 'mine');
    await fsp.writeFile(path.join(dir, 'loose-file.txt'), 'mine too');
    // A file that only looks like a job's folder is not a folder: it stays.
    await fsp.writeFile(path.join(dir, '11111111-2222-4333-8444-555555555555'), 'a file');
    const service = new DataExportService(ctx.pool, ctx.app.services.settings, {
      dir,
      version: 'test',
    });
    await service.clearLeftovers();
    expect((await fsp.readdir(dir)).sort()).toEqual(
      ['11111111-2222-4333-8444-555555555555', 'loose-file.txt', 'my-own-folder'].sort(),
    );
    expect(await fsp.readFile(path.join(otherDir, 'notes.txt'), 'utf8')).toBe('mine');
    // A folder that is not there yet is no error (a fresh installation).
    const fresh = new DataExportService(ctx.pool, ctx.app.services.settings, {
      dir: path.join(dataDir, 'exports-never-made'),
      version: 'test',
    });
    await expect(fresh.clearLeftovers()).resolves.toBeUndefined();
    await fsp.rm(dir, { recursive: true, force: true });
    // The program's own folder has a name of its own under the data folder.
    expect(DATA_EXPORT_FOLDER).toBe('ai-file-tmp');
  });

  it('makes one file at a time and keeps at most three', async () => {
    const service = ctx.app.services.dataExport;
    const actor = { userId: owner.user.id, label: 'owner', name: 'Shop Owner' };
    const first = service.start({ formats: ['json'], hideCustomers: false, language: 'sq' }, actor);
    expect(() =>
      service.start({ formats: ['json'], hideCustomers: false, language: 'sq' }, actor),
    ).toThrow(/already being made/);
    for (;;) {
      if (service.job(first.id).state !== 'running') break;
      await sleep(10);
    }
    expect(service.job(first.id).state).toBe('succeeded');
    const made: string[] = [first.id];
    for (let i = 0; i < 4; i += 1) {
      made.push((await exportFile({ formats: ['txt'] })).result.id);
    }
    const kept = (await fsp.readdir(path.join(dataDir, DATA_EXPORT_FOLDER))).sort();
    expect(kept).toEqual(made.slice(-3).sort());
    expect(() => service.job(made[0]!)).toThrow(/not found/);
  });
});
