package com.likapcs.live.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * The messages that come from the clock and the day's figures, with a clock moved by hand.
 * The answers have the shape of a 0.33.4 server's `/live/snapshot`, `/debts` and `/reservations`.
 */
class DailyTest {
    private val utc = ZoneId.of("UTC")
    private fun at(hour: Int, minute: Int = 0, day: Int = 12) = Texts.parseTime("2026-11-%02dT%02d:%02d:00Z".format(day, hour, minute))!!

    private val clock = TestClock(at(10))
    private val store = MemoryStore()
    private val api = FakeApi()
    private val notes = ArrayList<Note>()
    private val off = HashSet<Topic>()
    private val denied = HashSet<String>()
    private var online = true
    private var refreshed = 0

    /** How far the server's clock is ahead of the phone's. */
    private var skew = 0L

    /** What `/live/snapshot` answers now. */
    private var snap: JsonObject? = null

    private lateinit var daily: Daily

    private fun make(): Daily {
        daily = Daily(
            store = store,
            options = Options(store),
            texts = { Texts("sq", utc) },
            post = { notes += it },
            // As in the engine: a topic counts only while it is switched on (some are off by default).
            wants = { it !in off && Options(store).on(it) },
            fetch = { api.fetch(it) },
            refresh = {
                refreshed++
                (if (online) snap else null)?.also { daily.snapshot(it) }
            },
            can = { it !in denied },
            online = { online },
            clock = { clock.now },
            zone = { utc },
            skew = { skew },
        )
        return daily
    }

    private fun option(name: String, value: String) = assertTrue(Options(store).put(name, value))
    private fun switchOn(topic: Topic) = Options(store).set(topic, true)

    private fun snapshot(
        turnover: Long, count: Int = 3, date: String = "2026-11-12", lastSale: Long? = null,
        gross: Long = turnover / 2, expenses: Long = 0, refunded: Long = 0, drawer: Long? = null,
        staff: String = """{"userId":"u1","name":"Arta","onDuty":true,"salesCount":$count,"salesCents":$turnover,"lastSaleAt":${lastSale?.let { "\"${Texts.isoTime(it)}\"" }}}""",
    ): JsonObject = parseObject("""{"date":"$date","drawer":{"open":${drawer != null},"expectedCents":$drawer},
        "totals":{"turnoverCents":$turnover,"salesCount":$count,"grossProfitCents":$gross,"netProfitCents":${gross - expenses},
            "expensesCents":$expenses,"refundedCents":$refunded,"incomplete":false},
        "staff":[$staff],"feed":[]}""")!!.also { snap = it }

    private fun titles() = notes.map { it.title }

    // ─── The turnover mark ──────────────────────────────────────────────────────────────────

    @Test
    fun theTurnoverPassingAMarkIsToldOnce() {
        val d = make()
        // The first look is where counting starts, wherever the day stands.
        d.snapshot(snapshot(25_000))
        assertEquals(emptyList<String>(), titles())
        d.snapshot(snapshot(29_900))
        assertEquals(emptyList<String>(), titles())
        d.snapshot(snapshot(31_250, count = 41, gross = 12_000))
        assertEquals(listOf("Qarkullimi i ditës kaloi 300.00 €"), titles())
        assertEquals("Sot 312.50 € · 41 shitje · fitimi 120.00 €", notes[0].text)
        assertEquals(Category.DAY, notes[0].category)
        assertEquals(Topic.TURNOVER_STEP, notes[0].topic)
        // A refund takes the day back under the mark, a sale lifts it over again: not told twice.
        d.snapshot(snapshot(29_500))
        d.snapshot(snapshot(30_500))
        assertEquals(1, notes.size)
        // Two marks in one go: only the higher one.
        d.snapshot(snapshot(52_000))
        assertEquals("Qarkullimi i ditës kaloi 500.00 €", titles().last())
        assertEquals(2, notes.size)
    }

    @Test
    fun aNewDayAndANewStepStartOver() {
        val d = make()
        d.snapshot(snapshot(35_000))
        // Midnight: the first figures of the new day are the starting point.
        d.snapshot(snapshot(0, count = 0, date = "2026-11-13"))
        d.snapshot(snapshot(4_000, date = "2026-11-13"))
        assertEquals(emptyList<String>(), titles())
        d.snapshot(snapshot(10_500, date = "2026-11-13"))
        assertEquals(listOf("Qarkullimi i ditës kaloi 100.00 €"), titles())
        // The owner changes the step: counting starts from where the day stands now.
        option(Options.STEP_CENTS, "5000")
        d.snapshot(snapshot(10_500, date = "2026-11-13"))
        assertEquals(1, notes.size)
        d.snapshot(snapshot(15_200, date = "2026-11-13"))
        assertEquals("Qarkullimi i ditës kaloi 150.00 €", titles().last())
    }

    // ─── The summary of the day ─────────────────────────────────────────────────────────────

    @Test
    fun theSummaryComesAtItsHour() {
        off += setOf(Topic.DEBT_DUE, Topic.RESERVATION_SOON)
        val d = make()
        option(Options.STEP_CENTS, "100000000")
        clock.now = at(22, 59)
        snapshot(31_250, count = 41, gross = 12_000, expenses = 1_250, refunded = 300, drawer = 35_000,
            staff = """{"name":"Arta","salesCount":25,"salesCents":20000},{"name":"Beni","salesCount":16,"salesCents":11250},{"name":"Cimi","salesCount":0,"salesCents":0}""")
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // The watch asks to be woken at eleven.
        assertEquals(at(23), d.nextDue(clock.now))
        clock.now = at(23)
        d.tick()
        assertEquals(listOf("Dita sot: 312.50 € · 41 shitje"), titles())
        assertEquals("fitimi 120.00 € · Arta 200.00 €, Beni 112.50 € · shpenzime 12.50 € · rimbursime 3.00 € · në arkë 350.00 €", notes[0].text)
        assertEquals(Topic.DAY_SUMMARY, notes[0].topic)
        // The figures were read again for it.
        assertEquals(1, refreshed)
        // Once a day; the next one is tomorrow.
        clock.plus(60_000)
        d.tick()
        assertEquals(1, notes.size)
        assertEquals(at(23, day = 13), d.nextDue(clock.now))
    }

    @Test
    fun aDayWithoutSalesSaysSo() {
        val d = make()
        option(Options.SUMMARY_AT, "21:30")
        clock.now = at(21, 30)
        snapshot(0, count = 0, staff = "")
        d.tick()
        assertEquals(listOf("Dita sot: asnjë shitje"), titles())
    }

    @Test
    fun withoutAConnectionTheSummaryUsesTheLastFiguresAndSaysFromWhen() {
        val d = make()
        option(Options.STEP_CENTS, "100000000")
        clock.now = at(22, 40)
        d.snapshot(snapshot(8_000, count = 9, gross = 3_000))
        online = false
        clock.now = at(23)
        d.tick()
        assertEquals(listOf("Dita sot: 80.00 € · 9 shitje"), titles())
        assertTrue(notes[0].text, notes[0].text.endsWith("gjendja e orës 22:40"))
    }

    @Test
    fun aSummaryThatIsHoursLateOrOfAnotherDayIsNotSent() {
        val d = make()
        option(Options.STEP_CENTS, "100000000")
        d.snapshot(snapshot(8_000, date = "2026-11-12"))
        // The app was not running at 23:00 and starts the next morning.
        clock.now = at(7, day = 13)
        online = false
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // …and at 23:00 of that day the stored figures are still yesterday's (no connection all day).
        clock.now = at(23, day = 13)
        d.tick()
        assertEquals(emptyList<String>(), titles())
    }

    // ─── Debts due today ────────────────────────────────────────────────────────────────────

    @Test
    fun debtsDueTodayComeOnceInTheMorning() {
        val d = make()
        off += Topic.DAY_SUMMARY
        api.answers["/debts"] = """{"items":[
            {"id":"d1","customerName":"Arben","remainingCents":2000},{"id":"d2","customerName":"Blerim","remainingCents":1500},
            {"id":"d3","customerName":"Arben","remainingCents":1000},{"id":"d4","customerName":"Cen","remainingCents":0}],"total":4}"""
        api.answers["/debts/overview"] = """{"openCents":16500,"overdueCents":12000,"dueTodayCents":4500,"openCount":8,"overdueCount":5,"debtors":4}"""
        clock.now = at(8, 59)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(at(9), d.nextDue(clock.now))
        clock.now = at(9)
        d.tick()
        assertEquals(listOf("Sot skadojnë 3 borxhe · 45.00 €"), titles())
        assertEquals("Arben 30.00 €, Blerim 15.00 € · të vonuara: 5 · 120.00 €", notes[0].text)
        assertEquals(Topic.DEBT_DUE, notes[0].topic)
        assertTrue(api.asked.any { it.startsWith("/debts?filter=due_today") })
        clock.plus(3_600_000)
        d.tick()
        assertEquals(1, notes.size)
    }

    @Test
    fun noDebtsDueIsNoMessageAndOneDebtReadsAsOne() {
        val d = make()
        off += Topic.DAY_SUMMARY
        api.answers["/debts"] = """{"items":[],"total":0}"""
        clock.now = at(9, 30)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // The next day there is one.
        api.answers["/debts"] = """{"items":[{"id":"d1","customerName":"Arben","remainingCents":2000}],"total":1}"""
        api.answers["/debts/overview"] = """{"overdueCents":0,"overdueCount":0}"""
        clock.now = at(9, day = 13)
        d.tick()
        assertEquals(listOf("Sot skadon një borxh · 20.00 €"), titles())
        assertEquals("Arben 20.00 €", notes[0].text)
    }

    @Test
    fun withoutAConnectionTheDebtsComeLaterThatDay() {
        val d = make()
        off += Topic.DAY_SUMMARY
        api.answers["/debts"] = """{"items":[{"id":"d1","customerName":"Arben","remainingCents":2000}],"total":1}"""
        online = false
        clock.now = at(9)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        online = true
        clock.now = at(13, 20)
        d.tick()
        assertEquals(1, notes.size)
        // An account that may not see customers is never asked.
        notes.clear()
        api.asked.clear()
        denied += Daily.CUSTOMERS_VIEW
        clock.now = at(9, day = 13)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(emptyList<String>(), api.asked.filter { it.startsWith("/debts") })
    }

    // ─── No sales ───────────────────────────────────────────────────────────────────────────

    @Test
    fun noSaleForHoursInsideTheWorkingHours() {
        switchOn(Topic.SALES_IDLE)
        off += Topic.DAY_SUMMARY
        val d = make()
        clock.now = at(14, 5)
        d.snapshot(snapshot(5_000, lastSale = at(14, 5)))
        clock.now = at(16, 4)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(at(16, 5), d.nextDue(clock.now))
        clock.now = at(16, 5)
        d.tick()
        assertEquals(listOf("Asnjë shitje prej 2 h 00 min"), titles())
        assertEquals("Shitja e fundit: ora 14:05.", notes[0].text)
        assertEquals(Category.ALERTS, notes[0].category)
        assertEquals(Topic.SALES_IDLE, notes[0].topic)
        // Said once for this quiet stretch.
        clock.now = at(18)
        d.tick()
        assertEquals(1, notes.size)
        // A sale ends the stretch; two hours after it the message can come again.
        d.sale(at(18, 10))
        clock.now = at(20, 10)
        snapshot(6_000, lastSale = at(18, 10))
        d.tick()
        assertEquals(2, notes.size)
    }

    @Test
    fun aSaleThatWasNotReportedYetStopsTheMessage() {
        switchOn(Topic.SALES_IDLE)
        off += Topic.DAY_SUMMARY
        val d = make()
        clock.now = at(14)
        d.snapshot(snapshot(5_000, lastSale = at(14)))
        // By four o'clock a sale was made that this phone has not heard of: reading again finds it.
        clock.now = at(16)
        snapshot(5_500, lastSale = at(15, 50))
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(1, refreshed)
    }

    @Test
    fun outsideTheWorkingHoursNobodyExpectsASale() {
        switchOn(Topic.SALES_IDLE)
        off += Topic.DAY_SUMMARY
        val d = make()
        clock.now = at(22, 30)
        d.snapshot(snapshot(5_000, lastSale = at(22, 30)))
        // Closed at 23:00: at half past midnight nothing is said.
        clock.now = at(0, 30, day = 13)
        snapshot(0, count = 0, date = "2026-11-13", staff = "")
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // Two hours after opening without a single sale.
        clock.now = at(11, day = 13)
        d.tick()
        assertEquals(listOf("Asnjë shitje prej 2 h 00 min"), titles())
        assertEquals("Ende asnjë shitje që nga ora 09:00.", notes[0].text)
    }

    @Test
    fun theQuietTimeIsCountedOnThePhonesClock() {
        switchOn(Topic.SALES_IDLE)
        off += setOf(Topic.DAY_SUMMARY, Topic.DEBT_DUE, Topic.RESERVATION_SOON)
        // The shop's computer is an hour ahead: a sale it stamps 13:00 was made at 12:00 here.
        skew = 60 * 60_000
        val d = make()
        clock.now = at(12)
        d.snapshot(snapshot(5_000, lastSale = at(13)))
        clock.now = at(13, 59)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(at(14), d.nextDue(clock.now))
        clock.now = at(14)
        d.tick()
        assertEquals(listOf("Asnjë shitje prej 2 h 00 min"), titles())
        assertEquals("Shitja e fundit: ora 12:00.", notes[0].text)
    }

    @Test
    fun workingHoursMayRunOverMidnight() {
        switchOn(Topic.SALES_IDLE)
        off += Topic.DAY_SUMMARY
        option(Options.WORK_FROM, "16:00")
        option(Options.WORK_TO, "02:00")
        val d = make()
        clock.now = at(23, 20)
        d.snapshot(snapshot(5_000, lastSale = at(23, 20)))
        clock.now = at(1, 20, day = 13)
        snapshot(0, count = 0, date = "2026-11-13", staff = "")
        d.tick()
        assertEquals(listOf("Asnjë shitje prej 2 h 00 min"), titles())
    }

    // ─── Reservations ───────────────────────────────────────────────────────────────────────

    private fun reservation(id: String, startsAt: Long, remindMinutes: Int, status: String = "scheduled", who: String = "Driton", phone: String? = "044 123 456") =
        """{"id":"$id","startsAt":"${Texts.isoTime(startsAt)}","remindMinutes":$remindMinutes,
            "remindAt":"${Texts.isoTime(startsAt - remindMinutes * 60_000L)}","status":"$status","customerName":"$who",
            "phone":${phone?.let { "\"$it\"" }},"stations":[{"stationId":"st-4","code":"PC 04","number":4},{"stationId":"st-3","code":"PC 03","number":3}]}"""

    @Test
    fun aReservationIsRemindedAtTheTimeTheShopSet() {
        off += Topic.DAY_SUMMARY
        off += Topic.DEBT_DUE
        val d = make()
        api.answers["/reservations"] = """{"items":[${reservation("r1", at(18), 15)}]}"""
        clock.now = at(17)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // The phone is asked to wake the app at the reminder time (not just to read the list again).
        assertEquals(at(17, 45), d.nextDue(clock.now))
        clock.now = at(17, 44)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(at(17, 45), d.nextDue(clock.now))
        clock.now = at(17, 45)
        d.tick()
        assertEquals(listOf("Rezervim pas 15 min: Driton"), titles())
        assertEquals("PC 03, PC 04 · ora 18:00 · 044 123 456", notes[0].text)
        assertEquals(Topic.RESERVATION_SOON, notes[0].topic)
        clock.now = at(17, 50)
        d.tick()
        assertEquals(1, notes.size)
    }

    @Test
    fun beforeAReminderTheListIsReadAgain() {
        off += setOf(Topic.DAY_SUMMARY, Topic.DEBT_DUE)
        val d = make()
        api.answers["/reservations"] = """{"items":[${reservation("r1", at(18), 15)},${reservation("r2", at(18, 30), 15, who = "Beni")}]}"""
        clock.now = at(17, 30)
        d.tick()
        // r1 is cancelled, and the phone did not hear of it (it slept, the link was dead).
        api.answers["/reservations"] = """{"items":[${reservation("r1", at(18), 15, status = "cancelled")},${reservation("r2", at(18, 30), 15, who = "Beni")}]}"""
        clock.now = at(17, 45)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(at(18, 15), d.nextDue(clock.now))
        clock.now = at(18, 15)
        d.tick()
        assertEquals(listOf("Rezervim pas 15 min: Beni"), titles())
    }

    @Test
    fun withoutAConnectionAReminderWaitsForTheList() {
        off += setOf(Topic.DAY_SUMMARY, Topic.DEBT_DUE)
        val d = make()
        api.answers["/reservations"] = """{"items":[${reservation("r1", at(18), 15)}]}"""
        clock.now = at(17, 30)
        d.tick()
        // At the reminder time the server cannot be reached: nothing is said on old knowledge.
        online = false
        clock.now = at(17, 45)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // Seven minutes later the link is back: the reminder is still of use.
        online = true
        clock.now = at(17, 52)
        d.tick()
        assertEquals(listOf("Rezervim pas 8 min: Driton"), titles())
    }

    @Test
    fun aListThatCannotBeReadIsTriedAgainSoon() {
        off += setOf(Topic.DAY_SUMMARY, Topic.DEBT_DUE)
        val d = make()
        api.answers["/reservations"] = """{"items":[${reservation("r1", at(18), 15)}]}"""
        clock.now = at(17, 30)
        d.tick()
        // Connected, but this one read fails.
        api.answers.remove("/reservations")
        clock.now = at(17, 45)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(at(17, 47), d.nextDue(clock.now))
        api.answers["/reservations"] = """{"items":[${reservation("r1", at(18), 15)}]}"""
        clock.now = at(17, 47)
        d.tick()
        assertEquals(listOf("Rezervim pas 13 min: Driton"), titles())
    }

    @Test
    fun aCancelledOrLongPastReservationIsNotReminded() {
        off += Topic.DAY_SUMMARY
        off += Topic.DEBT_DUE
        val d = make()
        api.answers["/reservations"] = """{"items":[${reservation("r1", at(18), 15, status = "cancelled")},${reservation("r2", at(12), 0, who = "Beni", phone = null)}]}"""
        // The phone was off over noon: r2 started six hours ago.
        clock.now = at(18)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // A reservation made just now that starts in two minutes, reminder at its start.
        api.answers["/reservations"] = """{"items":[${reservation("r3", at(18, 2), 0, who = "Cen", phone = null)}]}"""
        d.reservationsChanged()
        d.tick()
        assertEquals(emptyList<String>(), titles())
        clock.now = at(18, 2)
        d.tick()
        assertEquals(listOf("Rezervimi fillon tani: Cen"), titles())
        assertEquals("PC 03, PC 04 · ora 18:02", notes[0].text)
    }

    @Test
    fun aReadThatFailsIsNotTriedAgainAtOnce() {
        off += setOf(Topic.DAY_SUMMARY, Topic.RESERVATION_SOON)
        val d = make()
        clock.now = at(9)
        // The server gives no answer for the debts.
        d.tick()
        clock.plus(20_000)
        d.tick()
        clock.plus(20_000)
        d.tick()
        assertEquals(1, api.asked.count { it.startsWith("/debts") })
        // A few minutes later it is tried again, and this time there is an answer.
        api.answers["/debts"] = """{"items":[{"id":"d1","customerName":"Arben","remainingCents":2000}],"total":1}"""
        clock.plus(3 * 60_000)
        d.tick()
        assertEquals(1, notes.size)
    }

    @Test
    fun theHoursAreTheShopsWhereverThePhoneIs() {
        // The shop is in Kosovo (UTC+1 in November). Its summary hour, 23:00, is 22:00 UTC —
        // whatever the clock on the owner's phone shows where he is.
        val kosovo = ZoneId.of("Europe/Belgrade")
        off += setOf(Topic.DEBT_DUE, Topic.RESERVATION_SOON)
        val d = Daily(
            store = store, options = Options(store), texts = { Texts("sq", utc) }, post = { notes += it },
            wants = { it !in off && Options(store).on(it) }, fetch = { api.fetch(it) },
            refresh = { snap?.also { daily.snapshot(it) } }, can = { true }, online = { true },
            clock = { clock.now }, zone = { kosovo },
        )
        daily = d
        option(Options.STEP_CENTS, "100000000")
        clock.now = at(21, 30)
        snapshot(8_000, count = 9)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(at(22), d.nextDue(clock.now))
        clock.now = at(22)
        d.tick()
        assertEquals(listOf("Dita sot: 80.00 € · 9 shitje"), titles())
        // An hour later the shop's day is over: its figures are another day's.
        notes.clear()
        clock.now = at(23, 30)
        snapshot(0, count = 0, date = "2026-11-13", staff = "")
        option(Options.SUMMARY_AT, "00:15")
        d.hourMoved(Options.SUMMARY_AT)
        d.tick()
        assertEquals(listOf("Dita sot: asnjë shitje"), titles())
    }

    @Test
    fun movingTheHourCountsFromNow() {
        off += setOf(Topic.DEBT_DUE, Topic.RESERVATION_SOON)
        val d = make()
        option(Options.STEP_CENTS, "100000000")
        clock.now = at(23)
        snapshot(8_000, count = 9)
        d.tick()
        assertEquals(1, notes.size)
        // At 23:10 the owner moves the summary to 23:05: that hour has just passed, so it comes now.
        clock.now = at(23, 10)
        option(Options.SUMMARY_AT, "23:05")
        d.hourMoved(Options.SUMMARY_AT)
        d.tick()
        assertEquals(2, notes.size)
    }

    // ─── Sign-in ────────────────────────────────────────────────────────────────────────────

    @Test
    fun aSignInLateInTheDayDoesNotCatchUp() {
        val d = make()
        api.answers["/debts"] = """{"items":[{"id":"d1","customerName":"Arben","remainingCents":2000}],"total":1}"""
        clock.now = at(23, 30)
        d.reset()
        d.snapshot(snapshot(31_250))
        d.tick()
        assertEquals(emptyList<String>(), titles())
        // The next day both come at their hours.
        api.answers["/debts/overview"] = """{"overdueCount":0}"""
        clock.now = at(9, day = 13)
        d.tick()
        assertEquals(1, notes.size)
    }

    @Test
    fun aSwitchedOffTopicAsksForNothing() {
        off += setOf(Topic.DAY_SUMMARY, Topic.DEBT_DUE, Topic.RESERVATION_SOON)
        val d = make()
        clock.now = at(23)
        d.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(emptyList<String>(), api.asked)
        assertEquals(0L, d.nextDue(clock.now))
    }
}
