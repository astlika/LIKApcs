package com.likapcs.live.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** One audit entry in the owner's words. `notify` false: listed in the app, but no notification. */
class Described(val category: Category, val title: String, val text: String, val notify: Boolean)

/**
 * Turns what the server reports into short texts: a sale, and every row of the audit log
 * ("who did what"). Nothing is decided here: amounts and names are the server's.
 * The same texts are used for the phone's notifications and for the activity list in the app.
 */
class Describer(private val lookup: Lookup, private val texts: () -> Texts) {

    // ─── Sales ──────────────────────────────────────────────────────────────────────────────

    /** A completed sale (`LiveSale`): "Arta shiti 5.00 €" · "Coca-Cola ×2, Çips ×1 · fitimi 4.23 €". */
    fun sale(sale: JsonObject): Note? {
        val id = sale.str("saleId") ?: return null
        val x = texts()
        val cashier = sale.str("cashierName") ?: x.t("Dikush", "Someone")
        val total = x.money(sale.long("totalCents") ?: 0)
        val parts = ArrayList<String>()
        val items = sale.arr("items").objects().joinToString(", ") { item ->
            val name = item.str("name") ?: "?"
            if (item.bool("isTime") == true) timeLine(name) else "$name ×${x.qty(item.long("quantityMilli") ?: 1000)}"
        }
        if (items.isNotEmpty()) parts += items
        var profit = x.t("fitimi ", "profit ") + x.money(sale.long("profitCents") ?: 0)
        if (sale.bool("missingCost") == true) profit += x.t(" (pa kosto)", " (no cost)")
        parts += profit
        val customer = sale.str("customerName")
        if (sale.bool("onCredit") == true) {
            parts += x.t("me borxh", "on credit") + (customer?.let { ": $it" } ?: "")
        } else if (customer != null) {
            parts += customer
        }
        return Note(
            key = "sale:$id",
            category = Category.SALES,
            title = x.t("$cashier shiti $total", "$cashier sold $total"),
            text = parts.joinToString(" · "),
            at = Texts.parseTime(sale.str("completedAt")) ?: System.currentTimeMillis(),
            tab = "sales",
        )
    }

    /**
     * The server names PC time lines in English: "PC 01 · 60 min (prepaid)", "PC 01 · +30 min
     * (extension: Paketa 3 orë)". The bracket is dropped; a package name stays.
     */
    private fun timeLine(name: String): String {
        val match = TIME_SUFFIX.find(name) ?: return name
        val pkg = match.groupValues[2]
        return name.substring(0, match.range.first) + if (pkg.isNotEmpty()) " ($pkg)" else ""
    }

    /** A product fell to its minimum stock or below (`StockLowEvent`). */
    fun stockLow(p: JsonObject): Note? {
        val id = p.str("productId") ?: return null
        val x = texts()
        val name = p.str("name") ?: "?"
        val stock = p.long("stockMilli") ?: 0
        val at = Texts.parseTime(p.str("at")) ?: System.currentTimeMillis()
        return if (stock <= 0) {
            Note("stock:$id:$at", Category.STOCK, x.t("Mbaroi stoku: $name", "Out of stock: $name"),
                x.t("Nuk ka më në stok.", "Nothing left in stock."), at)
        } else {
            Note("stock:$id:$at", Category.STOCK, x.t("Stok i ulët: $name", "Low stock: $name"),
                x.t("Mbeten ${x.qty(stock)} (minimumi ${x.qty(p.long("minStockMilli") ?: 0)})",
                    "${x.qty(stock)} left (minimum ${x.qty(p.long("minStockMilli") ?: 0)})"), at)
        }
    }

    // ─── The audit log ──────────────────────────────────────────────────────────────────────

    fun auditNote(entry: JsonObject): Note? {
        val id = entry.long("id") ?: return null
        val d = audit(entry)
        if (!d.notify) return null
        return Note(
            key = "audit:$id",
            category = d.category,
            title = d.title,
            text = d.text,
            at = Texts.parseTime(entry.str("occurredAt")) ?: System.currentTimeMillis(),
            tab = "activity",
        )
    }

    /** Who did it: the staff member's full name, else the sign-in name, else "System". */
    fun actor(entry: JsonObject): String {
        val x = texts()
        lookup.userName(entry.str("actorUserId"))?.let { return it }
        val label = entry.str("actorLabel")
        if (label != null && label != "system") return label
        if (label == null && entry.str("actorDeviceId") != null) return x.t("PC e klientit", "Customer PC")
        return x.t("Sistemi", "System")
    }

    fun audit(entry: JsonObject): Described {
        val x = texts()
        val action = entry.str("action") ?: ""
        val d = entry.obj("details")
        val entityId = entry.str("entityId")
        val warning = entry.str("severity").let { it == "warning" || it == "critical" }
        val who = actor(entry)

        var category = Category.SYSTEM
        var title = ""
        val parts = ArrayList<String>()
        var notify = true
        // The title already names the person (sign-ins): the text does not repeat it.
        var whoInTitle = false

        fun m(key: String): String = x.money(d.long(key))
        fun add(text: String?) {
            if (!text.isNullOrBlank()) parts += text
        }
        fun reason(key: String = "reason") = d.str(key)?.takeIf { it.isNotBlank() }?.let { x.t("arsyeja: $it", "reason: $it") }
        fun items(n: Long?) = n?.let { x.t("$it artikuj", "$it items") }
        fun sessionPc(): String = lookup.sessionPc(entityId) ?: d.str("stationCode") ?: "PC"
        fun stationPc(id: String?): String = lookup.stationCode(id) ?: "PC"

        when (action) {
            // ── Sales ──
            "sale.completed" -> {
                category = Category.SALES
                notify = false // the sale itself is announced with its lines and profit
                title = x.t("Shitje ${m("totalCents")}", "Sale ${m("totalCents")}")
                add(d.str("receiptNo"))
                add(items(d.long("items")))
                d.long("discountCents")?.takeIf { it > 0 }?.let { add(x.t("zbritje ${x.money(it)}", "discount ${x.money(it)}")) }
            }
            "sale.refunded" -> {
                category = Category.ALERTS
                title = x.t("Rimbursim ${m("totalCents")}", "Refund ${m("totalCents")}")
                add(d.str("receiptNo"))
                add(reason())
                if (d.bool("restock") == true) add(x.t("malli u kthye në stok", "goods back in stock"))
            }
            "sale.voided" -> {
                category = Category.ALERTS
                title = x.t("Shitje e anuluar", "Sale voided")
            }
            "sale.suspended" -> {
                category = Category.MONEY
                title = x.t("Shitje e parkuar ${m("totalCents")}", "Sale put on hold ${m("totalCents")}")
                add(items(d.long("items")))
            }
            "sale.receipt.reprinted" -> {
                category = Category.MONEY
                title = x.t("Fatura u shtyp sërish", "Receipt printed again")
                add(d.str("receiptNo"))
            }
            "staff_purchase.create" -> {
                category = Category.MONEY
                title = x.t("Blerje e stafit ${m("totalCostCents")}", "Staff purchase ${m("totalCostCents")}")
                add(items(d.long("items")))
            }
            "invoice.created" -> {
                category = Category.MONEY
                title = x.t("Faturë e re ${d.str("invoiceNo") ?: ""}".trim(), "New invoice ${d.str("invoiceNo") ?: ""}".trim())
                add(d.str("billingName"))
            }
            "invoice.voided" -> {
                category = Category.ALERTS
                title = x.t("Fatura ${d.str("invoiceNo") ?: ""} u anulua", "Invoice ${d.str("invoiceNo") ?: ""} voided")
                add(reason())
            }
            "invoice.reprinted" -> {
                category = Category.MONEY
                notify = false
                title = x.t("Fatura ${d.str("invoiceNo") ?: ""} u shtyp sërish", "Invoice ${d.str("invoiceNo") ?: ""} printed again")
            }

            // ── PC sessions ──
            "session.start" -> {
                category = Category.PCS
                title = x.t("${sessionPc()}: sesion i ri", "${sessionPc()}: session started")
                d.long("minutes")?.takeIf { it > 0 }?.let { add("$it min") }
                d.long("priceCents")?.takeIf { it > 0 }?.let { add(x.money(it)) }
                add(billingMode(d.str("billingMode")))
                if (d.str("requestId") != null) add(x.t("kërkesë nga klienti", "asked by the customer"))
            }
            "session.extend" -> {
                category = Category.PCS
                title = x.t("${sessionPc()}: +${d.long("minutes") ?: 0} min", "${sessionPc()}: +${d.long("minutes") ?: 0} min")
                d.long("priceCents")?.takeIf { it > 0 }?.let { add(x.money(it)) }
                if (d.str("requestId") != null) add(x.t("kërkesë nga klienti", "asked by the customer"))
            }
            "session.end" -> {
                category = Category.PCS
                title = x.t("${sessionPc()}: sesioni mbaroi", "${sessionPc()}: session ended")
                d.long("billableSeconds")?.let { add(x.duration(it)) }
                add(billingMode(d.str("billingMode")))
            }
            "session.collect" -> {
                category = Category.PCS
                title = x.t("${sessionPc()}: u pagua ${m("amountCents")}", "${sessionPc()}: paid ${m("amountCents")}")
                d.long("discountCents")?.takeIf { it > 0 }?.let { add(x.t("zbritje ${x.money(it)}", "discount ${x.money(it)}")) }
                d.long("orders")?.takeIf { it > 0 }?.let { add(x.t("$it porosi", "$it orders")) }
            }
            "session.collect_all" -> {
                category = Category.PCS
                val count = d.long("count") ?: 0
                title = x.t("U paguan $count fatura · ${m("totalCents")}", "$count bills paid · ${m("totalCents")}")
                add(method(d.str("method")))
            }
            "session.cancel" -> {
                category = Category.ALERTS
                title = x.t("${sessionPc()}: sesioni u anulua", "${sessionPc()}: session cancelled")
                add(reason())
            }
            "session.adjust_price" -> {
                category = Category.ALERTS
                title = x.t("${sessionPc()}: çmimi u ndryshua ${m("previousCents")} → ${m("newCents")}",
                    "${sessionPc()}: price changed ${m("previousCents")} → ${m("newCents")}")
                add(reason())
                add(method(d.str("method")))
            }
            "session.gift" -> {
                category = Category.ALERTS
                title = x.t("${sessionPc()}: ${d.long("minutes") ?: 0} min dhuratë", "${sessionPc()}: ${d.long("minutes") ?: 0} min for free")
                add(reason())
            }
            "session.remove_time" -> {
                category = Category.ALERTS
                title = x.t("${sessionPc()}: u hoqën ${d.long("minutes") ?: 0} min", "${sessionPc()}: ${d.long("minutes") ?: 0} min removed")
                d.long("priceCents")?.takeIf { it != 0L }?.let { add(x.money(it)) }
            }
            "session.pc_label" -> {
                category = Category.PCS
                notify = false
                val label = d.str("pcLabel")
                title = if (label != null) x.t("${sessionPc()}: emri «$label»", "${sessionPc()}: named “$label”")
                else x.t("${sessionPc()}: emri u hoq", "${sessionPc()}: name removed")
            }
            "station.bulk_minutes" -> {
                val gift = d.bool("gift") == true
                category = if (gift) Category.ALERTS else Category.PCS
                val applied = d.long("applied") ?: 0
                val minutes = d.long("minutes")?.let { "+$it min" } ?: x.t("paketë", "package")
                title = if (gift) x.t("$applied PC: $minutes dhuratë", "$applied PCs: $minutes for free")
                else x.t("$applied PC: $minutes", "$applied PCs: $minutes")
                d.long("totalCents")?.takeIf { it > 0 }?.let { add(x.money(it)) }
                d.long("skipped")?.takeIf { it > 0 }?.let { add(x.t("$it u anashkaluan", "$it skipped")) }
            }
            "time_credit.cancelled" -> {
                category = Category.ALERTS
                title = x.t("Kohë e parapaguar u anulua: ${d.long("minutes") ?: 0} min", "Prepaid time cancelled: ${d.long("minutes") ?: 0} min")
            }

            // ── Requests and orders from the PCs, reservations ──
            "request.create" -> {
                category = Category.PCS
                val pc = d.str("stationCode") ?: "PC"
                val minutes = d.long("minutes") ?: 0
                title = if (d.str("kind") == "extend") x.t("$pc kërkon edhe $minutes min", "$pc asks for $minutes more min")
                else x.t("$pc kërkon sesion: $minutes min", "$pc asks for a session: $minutes min")
                d.long("priceCents")?.takeIf { it > 0 }?.let { add(x.money(it)) }
            }
            "request.approve" -> {
                category = Category.PCS
                notify = false // the session start or extension that follows is announced
                title = x.t("${stationPc(d.str("stationId"))}: kërkesa u aprovua", "${stationPc(d.str("stationId"))}: request approved")
            }
            "request.reject" -> {
                category = Category.PCS
                title = x.t("${stationPc(d.str("stationId"))}: kërkesa u refuzua", "${stationPc(d.str("stationId"))}: request refused")
                add(reason())
            }
            "request.cancel" -> {
                category = Category.PCS
                notify = false
                title = x.t("Kërkesa nga PC u anulua", "PC request cancelled")
                add(reason())
            }
            "order.create" -> {
                category = Category.PCS
                title = x.t("${stationPc(d.str("stationId"))}: porosi e re ${m("totalCents")}", "${stationPc(d.str("stationId"))}: new order ${m("totalCents")}")
                add(items(d.long("lines")))
            }
            "order.staff_add" -> {
                category = Category.PCS
                title = x.t("Porosi nga stafi ${m("totalCents")}", "Order added by staff ${m("totalCents")}")
                add(lookup.sessionPc(d.str("sessionId")))
                add(items(d.long("lines")))
                add(settlement(d.str("settlement")))
            }
            "order.accept" -> {
                category = Category.PCS
                title = x.t("${orderPc(entityId)}porosia u pranua ${m("totalCents")}", "${orderPc(entityId)}order accepted ${m("totalCents")}")
                add(settlement(d.str("settlement")))
            }
            "order.pay" -> {
                category = Category.PCS
                title = x.t("${orderPc(entityId)}porosia u pagua ${m("totalCents")}", "${orderPc(entityId)}order paid ${m("totalCents")}")
            }
            "order.reject" -> {
                category = Category.PCS
                title = x.t("${orderPc(entityId)}porosia u refuzua", "${orderPc(entityId)}order refused")
                add(reason())
            }
            "order.cancel" -> {
                category = Category.PCS
                title = x.t("${orderPc(entityId)}porosia u anulua nga klienti", "${orderPc(entityId)}order cancelled by the customer")
            }
            "order.void" -> {
                category = Category.ALERTS
                title = x.t("${orderPc(entityId)}porosi e anuluar ${m("totalCents")}", "${orderPc(entityId)}order voided ${m("totalCents")}")
                add(reason())
            }
            "order.bill", "order.prepare" -> {
                category = Category.PCS
                notify = false
                title = if (action == "order.bill") x.t("${orderPc(entityId)}porosia u faturua", "${orderPc(entityId)}order billed")
                else x.t("${orderPc(entityId)}porosia u përgatit", "${orderPc(entityId)}order prepared")
                d.long("short")?.takeIf { it > 0 }?.let { add(x.t("$it artikuj mungojnë", "$it items short")) }
            }
            "reservation.create" -> {
                category = Category.PCS
                title = x.t("Rezervim i ri", "New reservation")
                Texts.parseTime(d.str("startsAt"))?.let { add(x.time(it)) }
                d.long("stations")?.let { add("$it PC") }
            }
            "reservation.cancel" -> {
                category = Category.PCS
                title = x.t("Rezervimi u anulua", "Reservation cancelled")
            }
            "reservation.check_in" -> {
                category = Category.PCS
                title = x.t("Rezervimi: klienti erdhi", "Reservation: the customer arrived")
                d.long("stations")?.let { add("$it PC") }
            }
            "customer.login" -> {
                category = Category.PCS
                notify = false
                val pc = d.str("stationCode") ?: stationPc(d.str("stationId"))
                title = if (d.bool("ok") == true) x.t("$pc: klienti u kyç", "$pc: customer signed in")
                else x.t("$pc: hyrje e dështuar e klientit", "$pc: customer sign-in failed")
            }

            // ── Drawer, expenses, purchases ──
            "cash.shift.open" -> {
                category = Category.MONEY
                title = x.t("Arka u hap", "Drawer opened")
                add(x.t("fillimi ${m("openingCents")}", "float ${m("openingCents")}"))
            }
            "cash.shift.close" -> {
                category = if (warning) Category.ALERTS else Category.MONEY
                val diff = d.long("differenceCents") ?: 0
                title = if (diff == 0L) x.t("Arka u mbyll", "Drawer closed")
                else x.t("Arka u mbyll · diferenca ${x.signedMoney(diff)}", "Drawer closed · difference ${x.signedMoney(diff)}")
                add(x.t("numëruar ${m("countedCents")}", "counted ${m("countedCents")}"))
                add(x.t("pritej ${m("expectedCents")}", "expected ${m("expectedCents")}"))
            }
            "cash.deposit" -> {
                category = Category.MONEY
                title = x.t("Hyrje parash në arkë ${m("amountCents")}", "Cash put in the drawer ${m("amountCents")}")
                add(reason())
            }
            "cash.withdrawal" -> {
                category = Category.MONEY
                title = x.t("Dalje parash nga arka ${m("amountCents")}", "Cash taken from the drawer ${m("amountCents")}")
                add(reason())
            }
            "expense.create" -> {
                category = Category.MONEY
                title = x.t("Shpenzim ${m("amountCents")}", "Expense ${m("amountCents")}")
                add(lookup.expenseCategory(d.str("categoryCode"), x.english))
                add(method(d.str("paymentMethod")))
                if (d.bool("fromDrawer") == true) add(x.t("nga arka", "from the drawer"))
            }
            "expense.void" -> {
                category = Category.ALERTS
                title = x.t("Shpenzim i anuluar ${m("amountCents")}", "Expense voided ${m("amountCents")}")
                add(reason())
            }
            "purchase.create" -> {
                category = Category.MONEY
                title = x.t("Blerje malli ${m("totalCents")}", "Purchase ${m("totalCents")}")
                add(d.str("supplier"))
                add(items(d.long("lines")))
            }
            "purchase.pay" -> {
                category = Category.MONEY
                title = x.t("Pagesë furnitori ${m("amountCents")}", "Supplier paid ${m("amountCents")}")
                add(method(d.str("method")))
            }
            "purchase.receive" -> {
                category = Category.STOCK
                title = x.t("Malli u pranua në stok", "Goods received into stock")
                add(items(d.long("lines")))
            }
            "purchase.cancel" -> {
                category = Category.MONEY
                title = x.t("Blerja u anulua", "Purchase cancelled")
            }

            // ── Debts and wallets ──
            "debt.opened" -> {
                category = Category.MONEY
                title = x.t("Borxh i ri ${m("amountCents")}", "New debt ${m("amountCents")}")
                add(lookup.customerName(d.str("customerId")))
                d.str("dueDate")?.let { add(x.t("afati ${x.date(it)}", "due ${x.date(it)}")) }
            }
            "debt.paid" -> {
                category = Category.MONEY
                title = x.t("Pagesë borxhi ${m("amountCents")}", "Debt payment ${m("amountCents")}")
                add(lookup.debtCustomer(entityId))
                if (d.bool("settled") == true) add(x.t("borxhi u shlye", "debt settled"))
            }
            "debt.rescheduled" -> {
                category = Category.MONEY
                title = x.t("Afati i borxhit u shty", "Debt due date moved")
                add(lookup.debtCustomer(entityId))
                add("${x.date(d.str("from"))} → ${x.date(d.str("to"))}")
            }
            "debt.written_off" -> {
                category = Category.ALERTS
                title = x.t("Borxh i falur ${m("remainingCents")}", "Debt written off ${m("remainingCents")}")
                add(lookup.customerName(d.str("customerId")))
                add(reason())
            }
            "wallet.topup" -> {
                category = Category.MONEY
                title = x.t("Mbushje balance ${m("amountCents")}", "Wallet top-up ${m("amountCents")}")
                add(lookup.customerName(entityId))
                add(x.t("gjendja ${m("balanceAfterCents")}", "balance ${m("balanceAfterCents")}"))
            }
            "wallet.withdrawn" -> {
                category = Category.ALERTS
                title = x.t("Para të kthyera nga balanca ${m("amountCents")}", "Wallet money paid back ${m("amountCents")}")
                add(lookup.customerName(entityId))
                add(reason())
            }

            // ── Stock, products, prices ──
            "inventory.adjusted" -> {
                val delta = d.long("delta") ?: 0
                category = if (delta < 0) Category.ALERTS else Category.STOCK
                val name = lookup.productName(entityId) ?: x.t("produkt", "product")
                title = x.t("Stoku: $name ${x.signedQty(delta)}", "Stock: $name ${x.signedQty(delta)}")
                add(stockType(d.str("type")))
                add(reason())
            }
            "catalog.product.created" -> {
                category = Category.STOCK
                title = x.t("Produkt i ri: ${d.str("name") ?: ""}", "New product: ${d.str("name") ?: ""}")
                d.long("sellingPriceCents")?.let { add(x.money(it)) }
            }
            "catalog.product.updated" -> {
                category = Category.STOCK
                val name = d.str("name") ?: lookup.productName(entityId) ?: x.t("produkt", "product")
                title = x.t("Produkt i ndryshuar: $name", "Product changed: $name")
                d.long("sellingPriceCents")?.let { add(x.t("çmimi ${x.money(it)}", "price ${x.money(it)}")) }
                d.long("purchaseCostCents")?.let { add(x.t("kosto ${x.money(it)}", "cost ${x.money(it)}")) }
                if (d.bool("isActive") == false) add(x.t("u çaktivizua", "switched off"))
                if (parts.isEmpty()) notify = false // a name, a picture or a category: listed, not announced
            }
            "catalog.product.archived", "catalog.product.deleted" -> {
                category = Category.STOCK
                val name = lookup.productName(entityId) ?: x.t("produkt", "product")
                title = if (action.endsWith("archived")) x.t("Produkt i arkivuar: $name", "Product archived: $name")
                else x.t("Produkt i fshirë: $name", "Product deleted: $name")
            }
            "pricing.rule.create", "pricing.rule.update", "pricing.rule.delete" -> {
                category = Category.STOCK
                val name = d.str("name") ?: d.obj("changes").str("name") ?: ""
                title = when (action) {
                    "pricing.rule.create" -> x.t("Çmim i ri i orës: $name", "New hourly price: $name")
                    "pricing.rule.delete" -> x.t("Çmimi i orës u fshi: $name", "Hourly price deleted: $name")
                    else -> x.t("Çmimi i orës u ndryshua $name".trim(), "Hourly price changed $name".trim())
                }
                (d.long("rateCentsPerHour") ?: d.obj("changes").long("rateCentsPerHour"))?.let { add(x.t("${x.money(it)}/orë", "${x.money(it)}/hour")) }
            }
            "pricing.package.create", "pricing.package.update", "pricing.package.delete" -> {
                category = Category.STOCK
                val name = d.str("name") ?: d.obj("changes").str("name") ?: ""
                title = when (action) {
                    "pricing.package.create" -> x.t("Paketë e re: $name", "New package: $name")
                    "pricing.package.delete" -> x.t("Paketa u fshi: $name", "Package deleted: $name")
                    else -> x.t("Paketa u ndryshua $name".trim(), "Package changed $name".trim())
                }
                (d.long("durationMinutes") ?: d.obj("changes").long("durationMinutes"))?.let { add("$it min") }
                (d.long("priceCents") ?: d.obj("changes").long("priceCents"))?.let { add(x.money(it)) }
            }

            // ── Staff and customers ──
            "auth.login" -> {
                category = Category.PEOPLE
                whoInTitle = true
                title = x.t("$who u kyç", "$who signed in")
                when (lookup.loginVia(entry.str("actorUserId"))) {
                    "phone" -> add(x.t("nga telefoni", "from the phone"))
                    "web" -> add(x.t("nga kompjuteri", "from the computer"))
                }
            }
            "auth.logout" -> {
                category = Category.PEOPLE
                whoInTitle = true
                notify = false
                title = x.t("$who doli", "$who signed out")
            }
            "auth.login_failed" -> {
                category = Category.ALERTS
                whoInTitle = true
                val name = entry.str("actorLabel") ?: who
                title = x.t("Hyrje e dështuar: $name", "Failed sign-in: $name")
                add(loginFailure(d.str("reason")))
                add(entry.str("ipAddress"))
            }
            "user.create" -> {
                category = Category.PEOPLE
                title = x.t("Llogari e re: ${d.str("username") ?: ""}", "New account: ${d.str("username") ?: ""}")
                add(d.arr("roles").strings().joinToString(", ").ifEmpty { null })
            }
            "user.update" -> {
                category = if (warning) Category.ALERTS else Category.PEOPLE
                val target = lookup.userName(entityId) ?: ""
                title = x.t("Llogaria u ndryshua: $target".trimEnd(':', ' '), "Account changed: $target".trimEnd(':', ' '))
                val changes = d.obj("changes")
                if (changes.bool("isActive") == false) add(x.t("u çaktivizua", "switched off"))
                if (changes.bool("isActive") == true) add(x.t("u aktivizua", "switched on"))
                changes.arr("roles")?.let { add(x.t("roli: ", "role: ") + it.strings().joinToString(", ")) }
            }
            "user.password_change" -> {
                category = Category.PEOPLE
                whoInTitle = true
                title = x.t("$who ndryshoi fjalëkalimin", "$who changed the password")
            }
            "user.password_reset" -> {
                category = Category.ALERTS
                val target = lookup.userName(entityId) ?: ""
                title = x.t("Fjalëkalimi u rivendos: $target".trimEnd(':', ' '), "Password reset: $target".trimEnd(':', ' '))
            }
            "role.permissions_update" -> {
                category = Category.ALERTS
                title = x.t("Lejet e rolit «${d.str("role") ?: ""}» u ndryshuan", "Permissions of role “${d.str("role") ?: ""}” changed")
                val added = d.arr("added")?.size ?: 0
                val removed = d.arr("removed")?.size ?: 0
                add(x.t("+$added leje, −$removed leje", "+$added, −$removed permissions"))
            }
            "customer.create" -> {
                category = Category.PEOPLE
                title = x.t("Klient i ri: ${d.str("name") ?: ""}", "New customer: ${d.str("name") ?: ""}")
            }
            "customer.update" -> {
                category = Category.PEOPLE
                notify = false
                val name = lookup.customerName(entityId) ?: ""
                title = x.t("Klienti u ndryshua: $name".trimEnd(':', ' '), "Customer changed: $name".trimEnd(':', ' '))
            }

            // ── System ──
            "settings.update" -> {
                category = Category.SYSTEM
                title = x.t("Cilësimet u ndryshuan", "Settings changed")
                val changed = d.obj("changed")
                changed?.entries?.take(3)?.forEach { (key, value) ->
                    val to = (value as? JsonObject)?.get("to")
                    add(if (to is JsonPrimitive && to !is JsonNull && to.content.length <= 24) "$key = ${to.content}" else key)
                }
                changed?.size?.takeIf { it > 3 }?.let { add("+${it - 3}") }
            }
            "backup.create" -> {
                category = Category.SYSTEM
                title = x.t("Kopje rezervë u krijua", "Backup created")
                add(d.str("kind"))
            }
            "backup.restore", "backup.transfer_import" -> {
                category = Category.ALERTS
                title = x.t("Të dhënat u rikthyen nga një kopje rezervë", "Data restored from a backup")
                add(d.str("fileName"))
            }
            "device.register" -> {
                category = Category.SYSTEM
                title = x.t("Një PC kërkon të lidhet: ${d.str("hostname") ?: ""}", "A PC asks to connect: ${d.str("hostname") ?: ""}")
            }
            "device.approve" -> {
                category = Category.ALERTS
                title = x.t("PC u aprovua: ${d.str("hostname") ?: ""}", "PC approved: ${d.str("hostname") ?: ""}")
                add(lookup.stationCode(d.str("stationId")))
            }
            "device.revoke" -> {
                category = Category.ALERTS
                title = x.t("Një PC-je iu hoq lidhja", "A PC was disconnected for good")
                add(lookup.stationCode(d.str("stationId")))
            }
            "station.create" -> {
                category = Category.SYSTEM
                title = x.t("PC e re: ${d.str("name") ?: ""}", "New PC: ${d.str("name") ?: ""}")
            }
            "station.archive", "station.delete", "station.unarchive" -> {
                category = if (warning) Category.ALERTS else Category.SYSTEM
                val name = d.str("name") ?: ""
                title = when (action) {
                    "station.archive" -> x.t("PC u arkivua: $name", "PC archived: $name")
                    "station.delete" -> x.t("PC u fshi: $name", "PC deleted: $name")
                    else -> x.t("PC u rikthye: $name", "PC restored: $name")
                }
                add(reason())
            }
            "updates.lan_publish" -> {
                category = Category.SYSTEM
                title = x.t("Përditësim i ri për PC-të: ${d.str("version") ?: ""}", "New update for the PCs: ${d.str("version") ?: ""}")
            }
            "clients.update_push" -> {
                category = Category.SYSTEM
                title = x.t("Përditësimi u dërgua te PC-të", "Update sent to the PCs")
                d.long("sent")?.let { add("$it PC") }
            }
            "import.completed" -> {
                category = Category.SYSTEM
                title = x.t("Importi i të dhënave përfundoi", "Data import finished")
                add(d.str("fileName"))
            }

            else -> {
                // Everything else: listed in the app with the action's own name; announced only
                // when the server marks it as a warning.
                category = when {
                    warning -> Category.ALERTS
                    action.startsWith("catalog.") || action.startsWith("supplier.") -> Category.STOCK
                    action.startsWith("order.") || action.startsWith("request.") || action.startsWith("reservation.") -> Category.PCS
                    else -> Category.SYSTEM
                }
                notify = warning && QUIET_PREFIXES.none { action.startsWith(it) }
                title = action.replace('.', ' ').replace('_', ' ').replaceFirstChar { it.uppercase() }
                d?.entries?.asSequence()
                    ?.mapNotNull { (key, value) -> detail(x, key, value) }
                    ?.take(3)
                    ?.forEach { add(it) }
            }
        }

        val text = (if (whoInTitle) parts else listOf(who) + parts).joinToString(" · ")
        return Described(category, title.trim(), text, notify)
    }

    private fun orderPc(orderId: String?): String = lookup.orderPc(orderId)?.let { "$it: " } ?: ""

    private fun billingMode(mode: String?): String? {
        val x = texts()
        return when (mode) {
            "prepaid" -> x.t("parapagim", "prepaid")
            "postpaid" -> x.t("kohë e hapur", "open time")
            "endpay" -> x.t("pagesë në fund", "pay at the end")
            else -> null
        }
    }

    private fun method(method: String?): String? {
        val x = texts()
        return when (method) {
            null -> null
            "cash" -> x.t("para në dorë", "cash")
            "card" -> x.t("kartë", "card")
            "bank_transfer" -> x.t("transfertë bankare", "bank transfer")
            "wallet" -> x.t("balanca", "wallet")
            "credit" -> x.t("borxh", "on credit")
            else -> method
        }
    }

    private fun settlement(value: String?): String? {
        val x = texts()
        return when (value) {
            "on_bill" -> x.t("në faturën e PC-së", "on the PC's bill")
            "pay_now" -> x.t("u pagua menjëherë", "paid at once")
            else -> null
        }
    }

    private fun stockType(type: String?): String? {
        val x = texts()
        return when (type) {
            null -> null
            "adjustment" -> x.t("rregullim", "adjustment")
            "initial" -> x.t("stok fillestar", "opening stock")
            "damaged" -> x.t("dëmtuar", "damaged")
            "expired" -> x.t("skaduar", "expired")
            "missing" -> x.t("mungesë", "missing")
            "stock_count" -> x.t("numërim stoku", "stock count")
            else -> type
        }
    }

    private fun loginFailure(reason: String?): String? {
        val x = texts()
        return when (reason) {
            null -> null
            "bad_password" -> x.t("fjalëkalim i gabuar", "wrong password")
            "unknown_user" -> x.t("përdorues i panjohur", "unknown user")
            "email_mismatch" -> x.t("e-mail i gabuar", "wrong e-mail")
            "inactive" -> x.t("llogari e çaktivizuar", "account switched off")
            "locked" -> x.t("llogaria është e kyçur", "account is locked")
            "locked_now" -> x.t("llogaria u kyç pas shumë përpjekjesh", "account locked after too many tries")
            else -> reason
        }
    }

    /** `amountCents: 1250` → "amount 12.50 €"; short plain values as they are; the rest is left out. */
    private fun detail(x: Texts, key: String, value: Any?): String? {
        if (value !is JsonPrimitive || value is JsonNull) return null
        val content = value.content
        if (content.isEmpty() || content.length > 40) return null
        // Ids say nothing to a person.
        if (key.endsWith("Id") || key == "id" || UUID.matches(content)) return null
        if (key.endsWith("Cents")) return content.toLongOrNull()?.let { "${key.removeSuffix("Cents")} ${x.money(it)}" }
        return "$key: $content"
    }

    private fun JsonArray?.strings(): List<String> =
        this?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p !is JsonNull }?.content } ?: emptyList()

    companion object {
        private val TIME_SUFFIX = Regex("\\s*\\((?:prepaid|extension|postpaid|pay at the end|endpay)(: ([^)]*))?\\)\\s*$")
        private val UUID = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

        /** Machine chatter: never announced, even when the server marks a failure as a warning. */
        private val QUIET_PREFIXES = listOf(
            "station.command.", "station.tasks_ended", "station.wol_configured", "station.maintenance_",
            "backup.external_copy", "customer.login", "remote.", "updates.check",
        )

        /** Audit actions that come together with a sale: when the sale was announced, they stay quiet. */
        val SALE_ACTIONS = setOf(
            "session.start", "session.extend", "session.end", "session.collect", "session.collect_all",
            "order.accept", "order.pay", "station.bulk_minutes", "staff_purchase.create", "debt.opened",
        )
    }
}
