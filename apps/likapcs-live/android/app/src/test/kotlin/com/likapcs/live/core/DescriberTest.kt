package com.likapcs.live.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * The wording of the notifications. The inputs are what a 0.33.4 server really sends: the
 * `live.sale` payload, and rows of `GET /audit-logs` recorded from a test shop.
 */
class DescriberTest {
    private val owner = "c227ed2b-5139-4d16-a8a1-9ad4b887c09c"
    private val cashier = "d3a3b93b-fd50-413e-bb3f-7b0fc2814cf3"

    /** The few API answers the describer looks names up in. */
    private val api = mapOf(
        "/users" to """{"items":[
            {"id":"$owner","username":"owner","fullName":"Pronari Test"},
            {"id":"$cashier","username":"kasjere","fullName":"Kasjere Test"}]}""",
        "/sessions/d3a04be2" to """{"id":"d3a04be2","stationCode":"PC 01"}""",
        "/sessions/8f8cc96a" to """{"id":"8f8cc96a","stationCode":"PC 03"}""",
        "/products/67424bbe" to """{"id":"67424bbe","name":"Ujë 0.5l"}""",
        "/products/16a900da" to """{"id":"16a900da","name":"Coca-Cola 0.33l"}""",
        "/sessions/5e55e7d0" to """{"id":"5e55e7d0","stationCode":"PC 02","customerName":"Driton","pcLabel":null,
            "finalPriceCents":140,"quotedPriceCents":200,"currentPriceCents":140}""",
        "/stations" to """[{"id":"st-5","code":"PC 05","name":"PC 5"},{"id":"st-7","code":"PC 07","name":"PC 7"}]""",
        "/debts/3be70c7b" to """{"id":"3be70c7b","customerName":"Arben Test"}""",
        "/expenses/categories" to """[{"code":"cleaning","nameSq":"Pastrimi","nameEn":"Cleaning"}]""",
    )
    private val asked = ArrayList<String>()

    private fun describer(lang: String = "sq"): Describer {
        val texts = Texts(lang, ZoneId.of("Europe/Belgrade"))
        val lookup = Lookup { path ->
            asked += path
            api[path]?.let { parseJson(it) } as JsonElement?
        }
        return Describer(lookup) { texts }
    }

    private fun json(text: String): JsonObject = parseObject(text)!!

    private val productSale = """{"saleId":"s1","receiptNo":"R-2026-000116","cashierName":"Kasjere Test",
        "completedAt":"2026-11-12T18:37:29.672Z","totalCents":580,"profitCents":491,"missingCost":true,
        "onCredit":false,"customerName":null,"items":[
          {"name":"Coca-Cola 0.33l","quantityMilli":2000,"lineTotalCents":380,"profitCents":322,"isTime":false},
          {"name":"Çips","quantityMilli":1000,"lineTotalCents":200,"profitCents":169,"isTime":false}]}"""

    // ─── Sales ──────────────────────────────────────────────────────────────────────────────

    @Test
    fun aSaleSaysWhoWhatAndHowMuch() {
        val note = describer().sale(json(productSale))!!
        assertEquals("Kasjere Test shiti 5.80 €", note.title)
        assertEquals("Coca-Cola 0.33l ×2, Çips ×1 · fitimi 4.91 € (pa kosto)", note.text)
        assertEquals(Category.SALES, note.category)
        assertEquals("sale:s1", note.key)
        assertEquals("sales", note.tab)
        assertEquals(Texts.parseTime("2026-11-12T18:37:29.672Z"), note.at)
    }

    @Test
    fun theSameSaleInEnglish() {
        val note = describer("en").sale(json(productSale))!!
        assertEquals("Kasjere Test sold 5.80 €", note.title)
        assertEquals("Coca-Cola 0.33l ×2, Çips ×1 · profit 4.91 € (no cost)", note.text)
    }

    @Test
    fun aSaleOnCreditNamesTheCustomer() {
        val note = describer().sale(json("""{"saleId":"s2","cashierName":"Pronari Test","completedAt":"2026-11-12T18:36:51Z",
            "totalCents":450,"profitCents":381,"missingCost":false,"onCredit":true,"customerName":"Arben Test",
            "items":[{"name":"Sanduiç","quantityMilli":1000,"lineTotalCents":450,"profitCents":381,"isTime":false}]}"""))!!
        assertEquals("Pronari Test shiti 4.50 €", note.title)
        assertEquals("Sanduiç ×1 · fitimi 3.81 € · me borxh: Arben Test", note.text)
    }

    private fun timeSale(vararg lines: String, total: Int = 200, customer: String? = null, lang: String = "sq"): Note =
        describer(lang).sale(json("""{"saleId":"s3","cashierName":"Kasjere Test","totalCents":$total,"profitCents":$total,
            "customerName":${customer?.let { "\"$it\"" }},
            "items":[${lines.joinToString(",") { """{"name":"$it","quantityMilli":1000,"lineTotalCents":200,"profitCents":200,"isTime":true}""" }}]}"""))!!

    @Test
    fun aSessionPaidAtItsStartIsToldAsAStart() {
        val note = timeSale("PC 01 · 60 min (prepaid)")
        assertEquals("Kasjere Test nisi PC 01 · 60 min · 2.00 €", note.title)
        assertEquals("kohë e parapaguar", note.text)
        // Money came in: it is still a sale.
        assertEquals(Category.SALES, note.category)
        assertEquals("Kasjere Test started PC 01 · 60 min · 2.00 €", timeSale("PC 01 · 60 min (prepaid)", lang = "en").title)
    }

    @Test
    fun anExtensionAndABillPaidAtTheEnd() {
        assertEquals("Kasjere Test zgjati PC 01 · +30 min · 2.00 €", timeSale("PC 01 · +30 min (extension)").title)
        val bill = timeSale("PC 02 · 1h 05m (postpaid)", total = 217, customer = "Driton")
        assertEquals("Kasjere Test mbylli PC 02 · 1 h 05 min · 2.17 €", bill.title)
        assertEquals("Driton", bill.text)
        assertEquals("Kasjere Test mbylli PC 02 · 42 min · 2.00 €", timeSale("PC 02 · 42 min (pay at the end)").title)
    }

    @Test
    fun aPackageNameIsTheShopsOwnWordAndStays() {
        val note = timeSale("PC 01 · +180 min (extension: Paketa 3 orë)", customer = "Driton")
        assertEquals("Kasjere Test zgjati PC 01 · +180 min · 2.00 €", note.title)
        assertEquals("Paketa 3 orë · Driton", note.text)
    }

    @Test
    fun severalPcsStartedAtOnce() {
        val note = timeSale("PC 01 · 60 min (prepaid)", "PC 02 · 60 min (prepaid)", "PC 03 · 60 min (prepaid)", total = 600)
        assertEquals("Kasjere Test nisi 3 PC · 6.00 €", note.title)
        assertEquals("PC 01 · 60 min, PC 02 · 60 min, PC 03 · 60 min", note.text)
    }

    @Test
    fun timeSoldTogetherWithProductsIsAPlainSale() {
        val note = describer().sale(json("""{"saleId":"s5","cashierName":"Kasjere Test","totalCents":390,"profitCents":361,"items":[
            {"name":"PC 01 · 60 min (prepaid)","quantityMilli":1000,"lineTotalCents":200,"profitCents":200,"isTime":true},
            {"name":"Coca-Cola 0.33l","quantityMilli":1000,"lineTotalCents":190,"profitCents":161,"isTime":false}]}"""))!!
        assertEquals("Kasjere Test shiti 3.90 €", note.title)
        assertEquals("PC 01 · 60 min, Coca-Cola 0.33l ×1 · fitimi 3.61 €", note.text)
        // A time line this app does not know the form of: left as the server wrote it.
        val odd = describer().sale(json("""{"saleId":"s6","cashierName":"Kasjere Test","totalCents":200,"profitCents":169,"items":[
            {"name":"PC 05 · Paketa e natës","quantityMilli":1000,"lineTotalCents":200,"profitCents":169,"isTime":true}]}"""))!!
        assertEquals("Kasjere Test shiti 2.00 €", odd.title)
        assertEquals("PC 05 · Paketa e natës · fitimi 1.69 €", odd.text)
    }

    @Test
    fun aSaleUnderItsCostAndABigSaleAreThingsToLookAt() {
        val loss = describer().saleAlert(json("""{"saleId":"s7","cashierName":"Kasjere Test","totalCents":100,"profitCents":-50,
            "items":[{"name":"Coca-Cola 0.33l","quantityMilli":2000,"lineTotalCents":100,"profitCents":-50,"isTime":false}]}"""), Topic.SALE_BELOW_COST)!!
        assertEquals("Shitje nën kosto: Kasjere Test · 1.00 €", loss.title)
        assertEquals("Coca-Cola 0.33l ×2 · humbje 0.50 €", loss.text)
        assertEquals("Coca-Cola 0.33l ×2 · loss 0.50 €", describer("en").saleAlert(json("""{"saleId":"s7","cashierName":"Kasjere Test","totalCents":100,"profitCents":-50,
            "items":[{"name":"Coca-Cola 0.33l","quantityMilli":2000,"lineTotalCents":100,"profitCents":-50,"isTime":false}]}"""), Topic.SALE_BELOW_COST)!!.text)
        assertEquals(Category.ALERTS, loss.category)
        assertEquals(Topic.SALE_BELOW_COST, loss.topic)
        // The same key as the plain sale message: one sale is one message.
        assertEquals("sale:s7", loss.key)
        val big = describer().saleAlert(json(productSale), Topic.SALE_BIG)!!
        assertEquals("Shitje e madhe: Kasjere Test · 5.80 €", big.title)
        assertEquals("Big sale: Kasjere Test · 5.80 €", describer("en").saleAlert(json(productSale), Topic.SALE_BIG)!!.title)
    }

    /**
     * Two colas at 1.90 € with 1.00 € off the whole sale, as a 0.33.4 server sends it: the lines
     * still say 3.80 €, the tax (0.43 €) is that of the 2.80 € charged, and "profit" is the lines
     * minus tax minus cost (0.60 €) — which leaves the discount out.
     */
    private val discounted = """{"saleId":"s8","cashierName":"Kasjere Test","totalCents":280,"profitCents":277,"missingCost":false,
        "items":[{"name":"Coca-Cola 0.33l","quantityMilli":2000,"lineTotalCents":380,"profitCents":277,"isTime":false}]}"""

    @Test
    fun aDiscountOnTheWholeSaleIsTakenOffTheProfit() {
        val d = describer()
        assertEquals(100L, d.saleDiscount(json(discounted)))
        assertEquals(177L, d.saleProfit(json(discounted)))
        // The plain message names the discount and the profit that is left.
        val plain = d.sale(json(discounted))!!
        assertEquals("Kasjere Test shiti 2.80 €", plain.title)
        assertEquals("Coca-Cola 0.33l ×2 · zbritje 1.00 € · fitimi 1.77 €", plain.text)
        // A sale without a discount is left as the server said it.
        assertEquals(0L, d.saleDiscount(json(productSale)))
        assertEquals(json(productSale).long("profitCents"), d.saleProfit(json(productSale)))
        // No lines listed (nothing to add up): nothing is taken off.
        assertEquals(0L, d.saleDiscount(json("""{"saleId":"s","totalCents":280,"profitCents":200}""")))
    }

    @Test
    fun aSaleWithADiscountIsToldAsTheDiscount() {
        val note = describer().saleAlert(json(discounted), Topic.SALE_DISCOUNT)!!
        assertEquals("Kasjere Test dha zbritje 1.00 €", note.title)
        assertEquals("shitja 2.80 € · Coca-Cola 0.33l ×2 · fitimi 1.77 €", note.text)
        assertEquals(Category.ALERTS, note.category)
        assertEquals(Topic.SALE_DISCOUNT, note.topic)
        assertEquals("sale:s8", note.key)
        assertEquals("Kasjere Test gave a discount of 1.00 €", describer("en").saleAlert(json(discounted), Topic.SALE_DISCOUNT)!!.title)
    }

    @Test
    fun aDiscountThatTurnsTheSaleIntoALossSaysBoth() {
        // A can that cost 1.40 € sold for 1.00 € after 1.50 € off: lines 2.50, tax 0.15.
        val sale = json("""{"saleId":"s9","cashierName":"Pronari Test","totalCents":100,"profitCents":95,"missingCost":false,
            "items":[{"name":"Red Bull 0.25l","quantityMilli":1000,"lineTotalCents":250,"profitCents":95,"isTime":false}]}""")
        assertEquals(-55L, describer().saleProfit(sale))
        val note = describer().saleAlert(sale, Topic.SALE_BELOW_COST)!!
        assertEquals("Shitje nën kosto: Pronari Test · 1.00 €", note.title)
        assertEquals("Red Bull 0.25l ×1 · zbritje 1.50 € · humbje 0.55 €", note.text)
    }

    @Test
    fun weighedGoodsKeepTheirDecimals() {
        val note = describer().sale(json("""{"saleId":"s4","cashierName":"Kasjere Test","totalCents":125,"profitCents":50,
            "items":[{"name":"Kikirikë","quantityMilli":250,"lineTotalCents":125,"profitCents":50,"isTime":false}]}"""))!!
        assertEquals("Kikirikë ×0.25 · fitimi 0.50 €", note.text)
    }

    @Test
    fun aSaleWithoutAnIdIsNotAnnounced() {
        assertNull(describer().sale(json("""{"cashierName":"X","totalCents":100}""")))
    }

    @Test
    fun lowStock() {
        val low = describer().stockLow(json("""{"productId":"p1","name":"Ujë 0.5l","stockMilli":3000,"minStockMilli":5000,"at":"2026-11-12T18:00:00Z"}"""))!!
        assertEquals("Stok i ulët: Ujë 0.5l", low.title)
        assertEquals("Mbeten 3 (minimumi 5)", low.text)
        assertEquals(Category.STOCK, low.category)
        val out = describer().stockLow(json("""{"productId":"p1","name":"Ujë 0.5l","stockMilli":0,"minStockMilli":5000,"at":"2026-11-12T18:00:00Z"}"""))!!
        assertEquals("Mbaroi stoku: Ujë 0.5l", out.title)
    }

    // ─── The audit log ──────────────────────────────────────────────────────────────────────

    private fun row(id: Int, actor: String?, label: String?, action: String, entityId: String?, details: String, severity: String = "info") =
        json("""{"id":$id,"occurredAt":"2026-11-12T18:37:22.084Z","actorUserId":${actor?.let { "\"$it\"" }},"actorDeviceId":null,
            "actorLabel":${label?.let { "\"$it\"" }},"action":"$action","entityType":"x","entityId":${entityId?.let { "\"$it\"" }},
            "details":$details,"ipAddress":"127.0.0.1","severity":"$severity"}""")

    private fun check(entry: JsonObject, category: Category, title: String, text: String) {
        val d = describer().audit(entry)
        assertEquals(title, d.title)
        assertEquals(text, d.text)
        assertEquals(category, d.category)
    }

    @Test
    fun anExpense() = check(
        row(402, owner, "owner", "expense.create", "db8bc51e", """{"fromDrawer":true,"amountCents":900,"categoryCode":"cleaning","paymentMethod":"cash"}"""),
        Category.MONEY, "Shpenzim 9.00 €", "Pronari Test · Pastrimi · para në dorë · nga arka",
    )

    @Test
    fun aRefundIsAnAlert() = check(
        row(365, owner, "owner", "sale.refunded", "e654a97a",
            """{"reason":"Klienti e ktheu","restock":true,"refundNo":"K-2026-000009","receiptNo":"R-2026-000099","totalCents":100}""", "warning"),
        Category.ALERTS, "Rimbursim 1.00 €", "Pronari Test · R-2026-000099 · arsyeja: Klienti e ktheu · malli u kthye në stok",
    )

    @Test
    fun freeMinutesAreAnAlertWithTheReason() = check(
        row(361, owner, "owner", "session.gift", "d3a04be2", """{"reason":"Na vjen keq për pritjen","minutes":15}"""),
        Category.ALERTS, "PC 01: 15 min dhuratë", "Pronari Test · arsyeja: Na vjen keq për pritjen",
    )

    @Test
    fun aCancelledSession() = check(
        row(362, owner, "owner", "session.cancel", "8f8cc96a", """{"reason":"Gabim në nisje"}""", "warning"),
        Category.ALERTS, "PC 03: seanca u anulua", "Pronari Test · arsyeja: Gabim në nisje",
    )

    @Test
    fun anOpenSessionTakesThePcFromTheRowItself() = check(
        row(378, cashier, "kasjere", "session.start", "cf279083",
            """{"minutes":null,"requestId":null,"priceCents":0,"billingMode":"postpaid","stationCode":"PC 04"}"""),
        Category.PCS, "Kasjere Test nisi PC 04", "kohë e hapur",
    )

    @Test
    fun aPaidSessionStartNamesMinutesAndPrice() = check(
        row(379, cashier, "kasjere", "session.start", "d3a04be2",
            """{"minutes":60,"requestId":null,"priceCents":200,"billingMode":"prepaid","stationCode":"PC 01"}"""),
        Category.PCS, "Kasjere Test nisi PC 01 · 60 min · 2.00 €", "parapagim",
    )

    @Test
    fun aSessionTheCustomerStartedHasNoStaffName() = check(
        row(380, null, null, "session.start", "d3a04be2", """{"minutes":30,"priceCents":0,"billingMode":"prepaid","stationCode":"PC 01"}"""),
        Category.PCS, "PC 01: seanca nisi · 30 min", "Sistemi · parapagim",
    )

    @Test
    fun anExtensionByStaff() = check(
        row(381, cashier, "kasjere", "session.extend", "d3a04be2", """{"minutes":30,"priceCents":100,"requestId":"r1"}"""),
        Category.PCS, "Kasjere Test zgjati PC 01 · +30 min · 1.00 €", "kërkesë nga klienti",
    )

    @Test
    fun aSessionClosedByStaffSaysHowLongWhoAndHowMuch() {
        val entry = row(382, cashier, "kasjere", "session.end", "5e55e7d0", """{"billableSeconds":2520,"billingMode":"prepaid"}""")
        check(entry, Category.PCS, "Kasjere Test mbylli PC 02 · 42 min", "Driton · 1.40 € · parapagim")
        assertEquals(Topic.PC_ENDED, describer().audit(entry).topic)
    }

    // ─── PCs switched on and off from the Admin ─────────────────────────────────────────────

    @Test
    fun theWakeSignalForOnePc() {
        val d = describer().audit(row(500, owner, "owner", "station.wake", "st-5", """{"mac":"08:BF:B8:12:34:56","targets":["255.255.255.255"],"warnings":[]}"""))
        assertEquals("Pronari Test e ndezi PC 05", d.title)
        assertEquals("sinjali i ndezjes u dërgua", d.text)
        assertEquals(Category.POWER, d.category)
        assertEquals(Topic.PC_WAKE, d.topic)
        assertTrue(d.notify)
        // Several in a row by the same person become one message.
        assertEquals("wake:Pronari Test", d.group)
        assertEquals("PC 05", d.item)
        val (title, text) = d.many!!(listOf("PC 07", "PC 05"))
        assertEquals("Pronari Test ndezi 2 PC", title)
        assertEquals("PC 05, PC 07 · sinjali i ndezjes u dërgua", text)
    }

    @Test
    fun wakeAll() {
        val d = describer().audit(row(501, owner, "owner", "station.wake_all", null,
            """{"sent":["PC 02","PC 01","PC 10"],"skipped":[{"code":"PC 04","reason":"no_mac"},{"code":"PC 05","reason":"online"},
                {"code":"PC 06","reason":"online"}]}"""))
        assertEquals("Pronari Test i ndezi të gjitha PC-të (3)", d.title)
        assertEquals("PC 01, PC 02, PC 10 · 2 ishin ndezur · 1 nuk mund të ndizen nga rrjeti · sinjali i ndezjes u dërgua", d.text)
        assertEquals(Topic.PC_WAKE, d.topic)
        assertEquals("Pronari Test switched all PCs on (3)",
            describer("en").audit(row(501, owner, "owner", "station.wake_all", null, """{"sent":["PC 02","PC 01","PC 10"],"skipped":[]}""")).title)
    }

    @Test
    fun shutDownAndRestartFromTheAdmin() {
        val off = describer().audit(row(502, owner, "owner", "station.command.power.shutdown", "st-5", """{"deviceId":"d1","payload":{},"ok":true,"error":null}"""))
        assertEquals("Pronari Test e fiku PC 05", off.title)
        assertEquals(Category.POWER, off.category)
        assertEquals(Topic.PC_COMMAND, off.topic)
        assertTrue(off.notify)
        assertEquals("Pronari Test fiku 2 PC", off.many!!(listOf("PC 05", "PC 07")).first)
        val restart = describer().audit(row(503, owner, "owner", "station.command.power.restart", "st-7", """{"ok":true}"""))
        assertEquals("Pronari Test e rinisi PC 07", restart.title)
        assertEquals("restart:Pronari Test", restart.group)
        // A PC that did not answer is said as such, and never merged with the ones that did.
        val failed = describer().audit(row(504, owner, "owner", "station.command.power.shutdown", "st-7", """{"ok":false,"error":"device disconnected"}""", "warning"))
        assertEquals("PC 07 nuk u fik", failed.title)
        assertEquals("Pronari Test · gabimi: device disconnected", failed.text)
        assertNull(failed.group)
    }

    @Test
    fun otherCommandsToAPcAreListedButNotAnnounced() {
        val d = describer().audit(row(505, owner, "owner", "station.command.message.show", "st-5", """{"payload":{"text":"Mbyllim për 10 minuta"},"ok":true}"""))
        assertEquals("PC 05: mesazh në ekran", d.title)
        assertEquals("Pronari Test · Mbyllim për 10 minuta", d.text)
        assertFalse(d.notify)
        assertFalse(describer().audit(row(506, owner, "owner", "station.command.lock", "st-5", """{"ok":true}""")).notify)
    }

    @Test
    fun aDiscountIsAThingToLookAt() {
        val d = describer().audit(row(507, cashier, "kasjere", "sale.completed", "s9",
            """{"receiptNo":"R-2026-000120","totalCents":400,"discountCents":100,"items":3}"""))
        assertEquals("Kasjere Test dha zbritje 1.00 €", d.title)
        assertEquals("shitja 4.00 € · R-2026-000120 · 3 artikuj", d.text)
        assertEquals("shitja 4.00 € · R-1 · 1 artikull", describer().audit(row(510, cashier, "kasjere", "sale.completed", "s9",
            """{"receiptNo":"R-1","totalCents":400,"discountCents":100,"items":1}""")).text)
        assertEquals(Category.ALERTS, d.category)
        assertEquals(Topic.SALE_DISCOUNT, d.topic)
        assertTrue(d.notify)
        // Without a discount the row stays quiet: the sale itself is the message.
        assertFalse(describer().audit(row(508, cashier, "kasjere", "sale.completed", "s9", """{"receiptNo":"R-1","totalCents":400,"discountCents":0,"items":3}""")).notify)
        val bill = describer().audit(row(509, cashier, "kasjere", "session.collect", "5e55e7d0", """{"amountCents":300,"discountCents":50,"orders":0}"""))
        assertEquals("Kasjere Test dha zbritje 0.50 € · PC 02", bill.title)
        assertEquals("u pagua 3.00 €", bill.text)
    }

    @Test
    fun aFailedSignIn() = check(
        row(369, cashier, "kasjere", "auth.login_failed", cashier, """{"reason":"bad_password"}""", "warning"),
        Category.ALERTS, "Hyrje e dështuar: kasjere", "fjalëkalim i gabuar · 127.0.0.1",
    )

    @Test
    fun stockWrittenOff() = check(
        row(367, owner, "owner", "inventory.adjusted", "67424bbe", """{"type":"damaged","delta":-3000,"reason":"U thyen shishet"}""", "warning"),
        Category.ALERTS, "Stoku: Ujë 0.5l -3", "Pronari Test · dëmtuar · arsyeja: U thyen shishet",
    )

    @Test
    fun aPriceChange() = check(
        row(368, owner, "owner", "catalog.product.updated", "16a900da", """{"sellingPriceCents":190,"sellingPriceMills":1900}"""),
        Category.STOCK, "Produkt i ndryshuar: Coca-Cola 0.33l", "Pronari Test · çmimi 1.90 €",
    )

    @Test
    fun cashTakenFromTheDrawer() = check(
        row(371, owner, "owner", "cash.withdrawal", "c4f6489d", """{"reason":"Në kasafortë","amountCents":5000}"""),
        Category.MONEY, "Dalje parash nga arka 50.00 €", "Pronari Test · arsyeja: Në kasafortë",
    )

    @Test
    fun aDebtPaymentNamesTheCustomer() = check(
        row(372, owner, "owner", "debt.paid", "3be70c7b", """{"settled":false,"paymentId":"fb507419","amountCents":200}"""),
        Category.MONEY, "Pagesë borxhi 2.00 €", "Pronari Test · Arben Test",
    )

    @Test
    fun aSaleRowIsListedButNotAnnouncedTwice() {
        val entry = row(403, cashier, "kasjere", "sale.completed", "902ec3df",
            """{"items":2,"methods":["cash"],"freeItems":[],"receiptNo":"R-2026-000116","timeItems":[],"totalCents":580,"discountCents":0}""")
        val d = describer().audit(entry)
        assertEquals("Shitje 5.80 €", d.title)
        assertFalse("the live sale message already told it", d.notify)
        assertNull(describer().auditNote(entry))
    }

    @Test
    fun aNoteCarriesTheRowsIdentityAndTime() {
        val note = describer().auditNote(row(402, owner, "owner", "expense.create", "db8bc51e",
            """{"fromDrawer":true,"amountCents":900,"categoryCode":"cleaning","paymentMethod":"cash"}"""))!!
        assertEquals("audit:402", note.key)
        assertEquals("activity", note.tab)
        assertEquals(Texts.parseTime("2026-11-12T18:37:22.084Z"), note.at)
    }

    @Test
    fun anActionThisVersionDoesNotKnowStillReads() {
        // A newer server may log things this app has never heard of: they must not break it.
        val d = describer().audit(row(900, owner, "owner", "loyalty.points.granted", "x1", """{"points":50,"nested":{"a":[1,2]}}"""))
        assertTrue(d.title.isNotBlank())
        assertNotNull(d.category)
        // …and neither may a row with nothing in it.
        val empty = describer().audit(json("""{"id":901}"""))
        assertNotNull(empty.title)
    }

    @Test
    fun whoDidIt() {
        val d = describer()
        assertEquals("Pronari Test", d.actor(row(1, owner, "owner", "x", null, "{}")))
        // Not in the staff list (deleted since): the sign-in name from the row.
        assertEquals("dikush", d.actor(row(2, "0000", "dikush", "x", null, "{}")))
        assertEquals("Sistemi", d.actor(row(3, null, "system", "x", null, "{}")))
        assertEquals("System", describer("en").actor(row(3, null, "system", "x", null, "{}")))
    }

    @Test
    fun namesAreLookedUpOnce() {
        val d = describer()
        repeat(3) {
            d.audit(row(367, owner, "owner", "inventory.adjusted", "67424bbe", """{"type":"damaged","delta":-3000,"reason":"x"}"""))
        }
        assertEquals(1, asked.count { it == "/products/67424bbe" })
        assertEquals(1, asked.count { it == "/users" })
    }
}
