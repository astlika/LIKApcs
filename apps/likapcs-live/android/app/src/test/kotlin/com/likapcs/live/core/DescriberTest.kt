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

    @Test
    fun pcTimeLosesTheServersEnglishBracket() {
        fun text(line: String) = describer().sale(json("""{"saleId":"s3","cashierName":"Kasjere Test","totalCents":200,
            "profitCents":169,"items":[{"name":"$line","quantityMilli":1000,"lineTotalCents":200,"profitCents":169,"isTime":true}]}"""))!!.text
        assertEquals("PC 01 · 60 min · fitimi 1.69 €", text("PC 01 · 60 min (prepaid)"))
        assertEquals("PC 01 · +30 min · fitimi 1.69 €", text("PC 01 · +30 min (extension)"))
        assertEquals("PC 02 · 1 min · fitimi 1.69 €", text("PC 02 · 1 min (postpaid)"))
        // A package name is the shop's own word: it stays.
        assertEquals("PC 01 · +180 min (Paketa 3 orë) · fitimi 1.69 €", text("PC 01 · +180 min (extension: Paketa 3 orë)"))
        assertEquals("PC 05 · Paketa e natës · fitimi 1.69 €", text("PC 05 · Paketa e natës"))
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
        Category.ALERTS, "PC 03: sesioni u anulua", "Pronari Test · arsyeja: Gabim në nisje",
    )

    @Test
    fun anOpenSessionTakesThePcFromTheRowItself() = check(
        row(378, cashier, "kasjere", "session.start", "cf279083",
            """{"minutes":null,"requestId":null,"priceCents":0,"billingMode":"postpaid","stationCode":"PC 04"}"""),
        Category.PCS, "PC 04: sesion i ri", "Kasjere Test · kohë e hapur",
    )

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
