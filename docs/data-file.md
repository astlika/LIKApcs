# The data file for an AI («Skedar për AI», 0.39.0)

One file that holds the business in full — from every sale down to every cash-in and cash-out —
made to be handed to an AI and asked questions ("which day earned the most", "what does the
evening shift sell", "where does the money go"). It is made on **Admin › Raportet › «Skedar për
AI»**.

It is not a backup: it cannot be loaded back into the program, it has no pictures, and it never
holds a password. For moving or saving the program's data use **Backup file**
([backups.md](backups.md)).

## Who can make it

The permission `reports.export_all` (migration `0064_data_export_permission.sql`). The owner and
the admin role have it; any other role gets it under Employees › Roles. It is separate from
`reports.export` (the CSV of one report) because this file holds far more than any report. Every
file made is written to the action log as `report.data_file` (severity `warning`) with the period,
the parts, the formats, the rows and the size.

## What the owner chooses

| Choice    | Options                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------- |
| Period    | today, yesterday, the last 7 days, this month, last month, **everything** (the whole history), or two dates          |
| Parts     | see the table below; all but the action log are ticked. «Vetëm përmbledhjet» unticks them all (summaries only)       |
| Format    | **JSON**, **TXT**, or both (two files from the same moment)                                                          |
| Customers | «Fshih emrat dhe telefonat e klientëve» — off unless ticked, and asked again every time                              |
| Language  | not asked: the labels and explanations inside the file are in the language the Admin is shown in (Albanian, English) |

The days are days of the business time zone (`locale.timezone`), both ends included — the same
days the Reports page uses.

## What is inside

In this order, in both formats:

1. **Skedari (File)** — the program and its version, the business, the period, when and by whom the
   file was made, the time zone, the currency, whether customers are hidden, the version of the
   layout (`1`).
2. **Si lexohet (How to read it)** — a dozen sentences for the reader: what the business is, how the
   times and amounts are written, what turnover, revenue, gross and net profit mean here, which
   sales count in the totals, how a PC session is tied to its sale, what `+` and `−` mean on a
   drawer or stock movement, why the products can add up to slightly more than the turnover, which
   parts were left out on purpose.
3. **Çfarë ka skedari (What the file holds)** — the number of rows of every table that follows.
4. **Përmbledhje (Summary)** — always there, whatever parts were chosen:
   - the totals of the period: sales, turnover before and after refunds, VAT, revenue, cost of the
     goods sold, gross and net profit with their margins, expenses, stock losses, discounts, the
     average sale, PC sessions and minutes, cash in and out of the drawer, shifts and their counting
     difference, goods received from suppliers, paid to suppliers, owed to suppliers;
   - the same by **day**, by **product**, by **category**, by **staff member**, by **PC**, by
     **payment method**, by **source** (shop, gaming, PC order …) and by **hour of the day**;
   - expenses by category, stock losses by kind, the drawer by kind of movement;
   - **Gjendja tani (As it is now)**: active products, the value of the stock at cost and at selling
     price, products out of stock or under their minimum, customers, customer balances, open debts,
     paid PC minutes not yet used, running sessions, open shifts, the cash that should be in the
     drawer.
5. **The tables**, one row per event of the period, oldest first.
6. **The lists as they are now** (not as they were at the end of the period).

| Part (tick box) | Tables                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sales`         | sales with their lines (item, quantity, price, total, cost, line discount, PC) and how they were paid; refunds with their lines, reason and method                              |
| `gaming`        | PC sessions with their events (time added or given free, pause, move to another PC, discount, correction); paid time bought at the desk; reservations; orders made from the PCs |
| `cash`          | shifts (opened, closed, expected, counted, difference); every drawer movement with its receipt, customer and reason; expenses                                                   |
| `stock`         | every stock movement (goods in, sold, wasted, corrected, counted) with quantity, cost and reason; stock counts                                                                  |
| `purchases`     | purchases from suppliers with their lines, receipts of goods, payments and returns; staff purchases                                                                             |
| `customers`     | customer debts with their payments and instalments; movements of customer balances; invoices issued                                                                             |
| `lists`         | products (price, cost, stock, VAT, category), offers, PC prices, time packages, PCs, customers, suppliers, staff (name, user name, role, active, last sign-in — nothing more)   |
| `audit`         | the action log: who did what and when. Not ticked by default (large). Only amounts, minutes, reasons and document numbers of each action are written                            |

The totals of the summary come from the same code as the Reports page (`services/reports.ts`,
`reports-profit.ts`, `cash.ts`), read at the same moment as the rows — so they are the figures the
owner already knows, and they are exactly the sum of the rows below them. A test holds both.

### What is never inside

Password and PIN hashes, sign-in tokens, device keys, internet access codes, licence or update
keys, pictures and videos, network addresses, the settings. Every column is named in the code one
by one (`services/data-export/sections.ts`); nothing is taken with `SELECT *`, so a column added to
a table later does not appear in the file by itself.

### Hidden customers

With the box ticked a customer appears by code only (`C-000123`), and the file holds no customer
name, phone, e-mail, address or note — not in the customers list, and not where a name was typed by
hand either: the name on a PC session, on a reservation, on paid time ("PC time · 60 min · Arben"
becomes "PC time · 60 min"), on a debt, or inside the reason of a drawer movement. Staff names stay.
The file says at its top that customers are hidden.

## The two formats

Both hold the same rows; the labels are words, not database names.

**JSON** (`.json`, UTF-8) — one object. Each table is an array with **one row per line**; a value
that is empty is left out; amounts are plain numbers in the currency (`12.5`, not cents), quantities
are numbers, times are `YYYY-MM-DD HH:MM` in the business time zone.

```text
{
  "Skedari": { "Programi": "LIKApcs 0.39.0", "Biznesi": "…", "Nga data": "2026-11-12", … },
  "Si lexohet": [ "…", "…" ],
  "Çfarë ka skedari (rreshta për tabelë)": { "Shitjet": 312, "Kthimet": 14, … },
  "Përmbledhje": { "Totalet e periudhës": { "Qarkullimi (me TVSH, pas kthimeve)": 1637.82, … }, … },
  "Shitjet": [
    {"Nr":"R-2026-000001","Koha":"2026-11-12 23:07","Statusi":"Përfunduar","Burimi":"Dyqan","Arkëtari":"Kasjere Test","Totali":5,"Pagesa":"Para në dorë","TVSH":0.77,"Artikujt":[{"Artikulli":"Coca-Cola 0.33l","Sasia":2,"Çmimi":1.5,"Totali":3,"Kosto":0},{"Artikulli":"Çips","Sasia":1,"Çmimi":2,"Totali":2,"Kosto":0}]},
    {"Nr":"R-2026-000002", … }
  ],
  …
}
```

**TXT** (`.txt`, UTF-8 with a byte-order mark so that Notepad shows ë and ç) — readable text, about
a third smaller than the JSON. Every table names its columns once; a row is `a | b | c`, values
that only some rows have follow after `;` with their name, and the lines of a sale (or the events
of a session) are indented under it.

```
--- Shitjet ---
Kolonat: Nr | Koha | Statusi | Burimi | Arkëtari | Totali | Pagesa
    artikull: Artikulli | Sasia | Çmimi | Totali | Kosto
R-2026-000001 | 2026-11-12 23:07 | Përfunduar | Dyqan | Kasjere Test | 5.00 | Para në dorë ; TVSH: 0.77
    artikull: Coca-Cola 0.33l | 2 | 1.50 | 3.00 | 0.00
    artikull: Çips | 1 | 2.00 | 2.00 | 0.00
```

## Size

An AI reads a limited amount of text at once; what does not fit it skips or shortens, and it does
not always say so. The dialog warns from 1 MB on and suggests a shorter period, fewer parts, or
«Vetëm përmbledhjet». Measured in the test set-up (2 processor cores; not on a shop PC):

| Data                                          | Rows    | Made in | JSON    | TXT     |
| --------------------------------------------- | ------- | ------- | ------- | ------- |
| Summaries only, a month of a busy shop        | 0       | 1 s     | 0.04 MB | 0.03 MB |
| One busy day (about 2,000 sales)              | 10,048  | 0.5 s   | 1.9 MB  | 1.2 MB  |
| Three weeks                                   | 163,008 | 3.5 s   | 32.6 MB | 21.4 MB |
| Whole history (60,791 sales, 28,816 sessions) | 254,557 | 6 s     | 52.8 MB | 35.5 MB |
| The same with the action log                  | 393,956 | 6.5 s   | 69.2 MB | 47.4 MB |

The times are from the faster runs: the test machine's speed varied, and at other hours the whole
history took 9 s. While it was written the server answered other requests (the till's top bar, the
product list) in under 0.1 s at the slowest, and the bar never stood still for longer than a second.

## The two waits, each with a bar

1. **Making the file** runs on the server as a job (`202 {jobId}`), followed with a percentage, the
   step in words and "rows done / rows in all". The percentage follows the rows written, weighted
   by how heavy each table is, and never goes back.
2. **Saving each file**: «Ruaj si…» opens the "save as" window where the program has one; the file
   is written there, **read back and compared** with the server's checksum, with its own bar.
   «Shkarko» saves it to the Downloads folder, read piece by piece with a bar (above 1 GB as an
   ordinary link, which the browser shows itself).

«Anulo» under the first bar gives the file up: the job stops within a moment (measured: 0.01–0.2 s
after the request), nothing of it stays on the server, and the choices are back as they were.
Leaving the page while the bar runs does the same. Closing the dialog afterwards deletes the
server's copy.

## How the server makes it

- **One moment.** Everything is read in one read-only `REPEATABLE READ` transaction, the reports of
  the summary included. The shop keeps selling while the file is written; a sale made in that time
  is not in the file, neither in the totals nor in the rows.
- **Nothing missing.** Every table is counted first and then read through a cursor; the two numbers
  must match, or the job fails with `EXPORT_INCOMPLETE` and no file is handed over.
- **Written as it goes.** Rows are streamed to disk, never held in memory as a whole, and the
  server keeps answering in between: while the whole history above was written, a request made
  every 20 ms (the till's "is a shift open", the product list) was answered in 0.06 s at the
  slowest, against 0.02 s with nothing else running. A file gets its real name only when it is
  complete (`.part` until then), with its size and SHA-256.
- **One at a time**: a second request while one runs gets `409 EXPORT_BUSY`.
- **Given up cleanly.** A cancelled or failed job runs no further query: what waits in its queue
  is refused where it stands, the query under way is waited for, the transaction is rolled back,
  and only then does the connection go back to the pool. Half-written files are closed and
  removed before the job reports its end. A folder that cannot be removed at once (Windows keeps
  a file that something still holds open) is tried again every half minute until it is gone.
- **Where the files are**: `<data dir>/ai-file-tmp/<job id>/LIKApcs-AI-<from>_<to>.json|.txt`. They are
  the business in plain text, so they are kept for **one hour** at most, **three exports** at most,
  deleted when the dialog closes and wiped when the server starts. They are not part of a backup.

Code: `apps/likapcs-server/src/services/data-export/` (`service.ts` the job, `sections.ts` the
tables, `summary.ts` the summary, `document.ts` the two writers, `labels.ts` the words) and
`src/routes/data-export.ts`; Admin `components/reports/DataFileDialog.tsx`, `lib/data-file.ts`.
The API is listed in [network-protocol.md](network-protocol.md) under Reports.
