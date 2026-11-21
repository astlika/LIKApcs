package com.likapcs.live.core

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * PCs coming on and going off, and sessions running out — with a clock moved by hand. The
 * inputs have the shape of `GET /stations` and of the `session.changed` event of a 0.33.4 server.
 */
class PcWatchTest {
    private val start = Texts.parseTime("2026-11-12T09:00:00Z")!!
    private val clock = TestClock(start)
    private val store = MemoryStore()
    private val api = FakeApi()
    private val notes = ArrayList<Note>()
    private val off = HashSet<Topic>()
    private var baseline = 0L

    /** How far the server's clock is ahead of the phone's. */
    private var skew = 0L

    /** Is the link to the server known to be alive? */
    private var fresh = true

    /** What the server would answer now: the test's own picture of the shop. */
    private val shop = LinkedHashMap<String, JsonObject>()

    private fun watch() = PcWatch(
        store = store,
        options = Options(store),
        texts = { Texts("sq", ZoneId.of("UTC")) },
        post = { notes += it },
        wants = { it !in off && Options(store).on(it) },
        fetch = { path ->
            if (path == "/stations") api.answers[path] = "[${shop.values.joinToString(",")}]"
            api.fetch(path)
        },
        baseline = { baseline },
        clock = { clock.now },
        skew = { skew },
        fresh = { fresh },
    )

    private fun iso(ms: Long) = Texts.isoTime(ms)

    /** A PC as `GET /stations` lists it; `session` is the JSON of its `activeSession`. */
    private fun pc(n: Int, online: Boolean, session: String? = null, paired: Boolean = true): JsonObject {
        val code = "PC %02d".format(n)
        val device = if (paired) """{"id":"dev-$n","online":$online}""" else "null"
        return parseObject("""{"id":"st-$n","number":$n,"code":"$code","name":"PC $n","isEnabled":true,
            "status":"${if (session != null) "occupied" else if (online) "available" else "offline"}",
            "device":$device,"activeSession":${session ?: "null"},"archived":null}""")!!.also { shop["st-$n"] = it }
    }

    private fun active(id: String, endsAt: Long?, startedAt: Long = start, who: String? = "Driton") =
        """{"id":"$id","customerName":${who?.let { "\"$it\"" }},"pcLabel":null,"billingMode":"prepaid","status":"active",
            "startedAt":"${iso(startedAt)}","endsAt":${endsAt?.let { "\"${iso(it)}\"" }},"pausedAt":null}"""

    private fun all() = shop.values.toList()
    private fun titles() = notes.map { it.title }

    // ─── On and off ─────────────────────────────────────────────────────────────────────────

    @Test
    fun theFirstLookAnnouncesNothing() {
        val w = watch()
        pc(1, true); pc(2, false); pc(3, false)
        w.sync(all())
        clock.plus(60_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(1 to 3, w.tally())
    }

    @Test
    fun aPcThatComesOnIsToldOnceItHasSettled() {
        val w = watch()
        pc(1, true); pc(2, false); pc(3, false)
        w.sync(all())
        w.station(pc(2, true))
        assertEquals(emptyList<String>(), titles())
        // The watch asks to be called again when the change is ripe.
        assertEquals(clock.now + PcWatch.ON_SETTLE_MS, w.nextDue(clock.now))
        clock.plus(PcWatch.ON_SETTLE_MS)
        w.tick()
        assertEquals(listOf("PC 02 u ndez"), titles())
        assertEquals("2 nga 3 PC janë ndezur", notes[0].text)
        assertEquals(Category.POWER, notes[0].category)
        assertEquals(Topic.PC_POWER, notes[0].topic)
        assertFalse(notes[0].update)
        // Told once.
        clock.plus(60_000)
        w.tick()
        assertEquals(1, notes.size)
        assertEquals(0L, w.nextDue(clock.now))
    }

    @Test
    fun pcsComingOnOneAfterTheOtherAreOneMessageThatGrows() {
        val w = watch()
        for (n in 1..12) pc(n, false)
        w.sync(all())
        w.station(pc(3, true))
        clock.plus(3_000)
        w.tick()
        w.station(pc(1, true))
        w.station(pc(10, true))
        clock.plus(3_000)
        w.tick()
        for (n in listOf(2, 4, 5, 6, 7, 8, 9, 11, 12)) w.station(pc(n, true))
        clock.plus(3_000)
        w.tick()
        assertEquals(listOf("PC 03 u ndez", "U ndezën 3 PC", "U ndezën 12 PC"), titles())
        assertEquals("PC 01, PC 03, PC 10 · 3 nga 12 PC janë ndezur", notes[1].text)
        // The same message every time: it is replaced, and rings only the first time.
        assertEquals(1, notes.map { it.key }.distinct().size)
        assertEquals(listOf(false, true, true), notes.map { it.update })
        assertTrue(notes[2].text.endsWith("12 nga 12 PC janë ndezur"))
        // Much later it is a new message.
        clock.plus(PcWatch.MERGE_MS + 1_000)
        w.station(pc(3, false))
        clock.plus(PcWatch.OFF_SETTLE_MS)
        w.tick()
        w.station(pc(3, true))
        clock.plus(PcWatch.ON_SETTLE_MS)
        w.tick()
        assertEquals(listOf("PC 03 u fik", "PC 03 u ndez"), titles().takeLast(2))
        assertEquals(3, notes.map { it.key }.distinct().size)
    }

    @Test
    fun closingTimeIsOneMessageToo() {
        val w = watch()
        for (n in 1..4) pc(n, true)
        w.sync(all())
        for (n in 1..4) w.station(pc(n, false))
        clock.plus(PcWatch.OFF_SETTLE_MS)
        w.tick()
        assertEquals(listOf("U fikën 4 PC"), titles())
        assertEquals("PC 01, PC 02, PC 03, PC 04 · 0 nga 4 PC janë ndezur", notes[0].text)
    }

    @Test
    fun aBlinkIsNotNews() {
        val w = watch()
        pc(1, true)
        w.sync(all())
        w.station(pc(1, false))
        clock.plus(4_000)
        w.tick()
        w.station(pc(1, true))
        clock.plus(60_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
    }

    @Test
    fun beforeAPcIsSaidToBeOffTheListIsReadAgain() {
        val w = watch()
        pc(1, true)
        w.sync(all())
        clock.plus(5_000)
        // The event says "off", but by now the PC is back and that event was lost.
        w.station(pc(1, false))
        pc(1, true)
        clock.plus(PcWatch.OFF_SETTLE_MS)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        assertTrue(api.asked.contains("/stations"))
    }

    @Test
    fun withoutAnAnswerNothingIsSaidUntilTheNextFullRead() {
        val w = watch()
        pc(1, true)
        w.sync(all())
        clock.plus(5_000)
        w.station(pc(1, false))
        clock.plus(PcWatch.OFF_SETTLE_MS)
        val list = all()
        shop.clear() // the link is down: the look-again gets no answer
        w.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(0L, w.nextDue(clock.now))
        // The link is back and the PC is still off.
        clock.plus(120_000)
        list.forEach { shop[it.str("id")!!] = it }
        w.sync(all())
        assertEquals(listOf("PC 01 u fik"), titles())
    }

    @Test
    fun afterTheServerRestartsThePcsAreGivenTimeToFindItAgain() {
        val w = watch()
        pc(1, true); pc(2, true); pc(3, false)
        w.sync(all())
        // The server restarts. This phone finds it again first: for the server every PC is off.
        pc(1, false); pc(2, false)
        w.sync(all(), afterGap = true)
        clock.plus(15_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        // Twenty seconds later the PCs' own programs have connected again.
        pc(1, true); pc(2, true)
        w.station(pc(1, true))
        w.station(pc(2, true))
        clock.plus(40_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(0L, w.nextDue(clock.now))
    }

    @Test
    fun aPcThatStaysOffAfterTheLinkCameBackIsToldAfterThatTime() {
        val w = watch()
        pc(1, true); pc(2, true)
        w.sync(all())
        // While the phone had no connection PC 02 was switched off.
        pc(2, false)
        w.sync(all(), afterGap = true)
        assertEquals(start + PcWatch.RECONNECT_GRACE_MS, w.nextDue(clock.now))
        clock.plus(PcWatch.RECONNECT_GRACE_MS - 1_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        clock.plus(1_000)
        w.tick()
        assertEquals(listOf("PC 02 u fik"), titles())
        // A PC that goes off later, on a link that stayed up, is told after the usual ten seconds.
        w.station(pc(1, false))
        clock.plus(PcWatch.OFF_SETTLE_MS)
        w.tick()
        // (Close enough to the first to join its message.)
        assertEquals(listOf("PC 02 u fik", "U fikën 2 PC"), titles())
        assertEquals(notes[0].key, notes[1].key)
        assertTrue(notes[1].update)
    }

    @Test
    fun aSlowLookTellsWhatBecameRipeWhileItWasOnItsWay() {
        val w = watch()
        pc(1, false); pc(2, false); pc(3, false)
        w.sync(all())
        clock.plus(60_000)
        w.station(pc(2, true))
        clock.plus(1_000)
        w.station(pc(3, true))
        // The look before PC 02 is told takes over a second: PC 03 has settled when it is back.
        api.onFetch = { clock.plus(1_200) }
        clock.plus(1_500)
        w.tick()
        api.onFetch = null
        assertEquals(listOf("U ndezën 2 PC"), titles())
        assertEquals(0L, w.nextDue(clock.now))
    }

    @Test
    fun aChangeWhoseMomentHasPassedIsDueAtOnce() {
        val w = watch()
        pc(1, false); pc(2, false); pc(3, false)
        w.sync(all())
        w.station(pc(2, true))
        clock.plus(1_000)
        w.station(pc(3, true))
        clock.plus(1_500)
        w.tick()
        assertEquals(listOf("PC 02 u ndez"), titles())
        // Showing it took its time: the moment of PC 03 has passed before the next one is asked for.
        clock.plus(1_300)
        val next = w.nextDue(clock.now)
        assertTrue("due right away, was ${next - clock.now} ms", next > clock.now && next - clock.now <= 500)
        clock.now = next
        w.tick()
        assertEquals(listOf("PC 02 u ndez", "U ndezën 2 PC"), titles())
        assertEquals(0L, w.nextDue(clock.now))
    }

    @Test
    fun aPcWithoutAClientIsNeverAnnounced() {
        val w = watch()
        pc(1, true); pc(2, false, paired = false)
        w.sync(all())
        assertEquals(1 to 1, w.tally())
        // It gets its client and connects for the first time: that is a PC coming on.
        w.station(pc(2, true))
        clock.plus(PcWatch.ON_SETTLE_MS)
        w.tick()
        assertEquals(listOf("PC 02 u ndez"), titles())
        // A PC added to the shop later is first seen silently.
        w.station(pc(3, true))
        clock.plus(PcWatch.ON_SETTLE_MS)
        w.tick()
        assertEquals(1, notes.size)
    }

    @Test
    fun aPcThatGoesOffDuringASessionIsAnAlert() {
        val w = watch()
        pc(5, true, active("s1", start + 60 * 60_000))
        w.sync(all())
        clock.plus(18 * 60_000)
        w.station(pc(5, false, active("s1", start + 60 * 60_000)))
        // Not a plain "went off" after the short wait…
        clock.plus(PcWatch.OFF_SETTLE_MS)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        // …but an alert once it has really stayed off.
        clock.plus(PcWatch.DROP_SETTLE_MS - PcWatch.OFF_SETTLE_MS)
        w.tick()
        assertEquals(listOf("PC 05 u fik gjatë seancës"), titles())
        assertEquals("Driton · mbeten 41 min · PC-ja nuk është më e lidhur me serverin", notes[0].text)
        assertEquals(Category.ALERTS, notes[0].category)
        assertEquals(Topic.PC_DROPPED, notes[0].topic)
        // When it is back, that is told as a PC coming on.
        w.station(pc(5, true, active("s1", start + 60 * 60_000)))
        clock.plus(PcWatch.ON_SETTLE_MS)
        w.tick()
        assertEquals("PC 05 u ndez", titles().last())
    }

    @Test
    fun withTheAlertSwitchedOffItIsAPlainWentOff() {
        off += Topic.PC_DROPPED
        val w = watch()
        pc(5, true, active("s1", start + 60 * 60_000))
        w.sync(all())
        w.station(pc(5, false, active("s1", start + 60 * 60_000)))
        clock.plus(PcWatch.OFF_SETTLE_MS)
        w.tick()
        assertEquals(listOf("PC 05 u fik"), titles())
    }

    @Test
    fun aRestartOfTheAppRepeatsNothingAndCatchesUp() {
        val first = watch()
        pc(1, true); pc(2, false)
        first.sync(all())
        first.station(pc(2, true))
        clock.plus(PcWatch.ON_SETTLE_MS)
        first.tick()
        assertEquals(listOf("PC 02 u ndez"), titles())
        notes.clear()

        // The app is stopped; meanwhile PC 01 is switched off.
        clock.plus(40 * 60_000)
        pc(1, false)
        val second = watch()
        second.sync(all())
        clock.plus(PcWatch.OFF_SETTLE_MS)
        second.tick()
        assertEquals(listOf("PC 01 u fik"), titles())
    }

    @Test
    fun aDeletedPcIsForgotten() {
        val w = watch()
        pc(1, true); pc(2, true)
        w.sync(all())
        w.station(parseObject("""{"id":"st-2","code":"PC 02","deleted":true,"device":null}""")!!)
        shop.remove("st-2")
        clock.plus(60_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(1 to 1, w.tally())
    }

    // ─── Sessions ───────────────────────────────────────────────────────────────────────────

    @Test
    fun aSessionAboutToEndIsToldOnce() {
        val w = watch()
        val end = start + 60 * 60_000
        pc(5, true, active("s1", end))
        w.sync(all())
        // The watch asks to be woken five minutes before the end.
        assertEquals(end - 5 * 60_000, w.nextDue(clock.now))
        clock.now = end - 5 * 60_000 - 1_000
        w.tick()
        assertEquals(emptyList<String>(), titles())
        clock.now = end - 5 * 60_000
        w.tick()
        assertEquals(listOf("PC 05: mbeten 5 min"), titles())
        assertEquals("Driton · mbaron në 10:00", notes[0].text)
        assertEquals(Topic.PC_ENDING, notes[0].topic)
        clock.plus(60_000)
        w.tick()
        assertEquals(1, notes.size)
        assertEquals(0L, w.nextDue(clock.now))
    }

    @Test
    fun anExtensionMovesTheWarning() {
        val w = watch()
        val end = start + 60 * 60_000
        pc(5, true, active("s1", end))
        w.sync(all())
        clock.now = end - 5 * 60_000
        w.tick()
        // Half an hour more is bought: there will be a new warning before the new end.
        val later = end + 30 * 60_000
        w.session(parseObject("""{"id":"s1","stationId":"st-5","stationCode":"PC 05","customerName":"Driton","status":"active",
            "startedAt":"${iso(start)}","endsAt":"${iso(later)}"}""")!!)
        assertEquals(later - 5 * 60_000, w.nextDue(clock.now))
        clock.now = later - 4 * 60_000
        w.tick()
        assertEquals(listOf("PC 05: mbeten 5 min", "PC 05: mbeten 4 min"), titles())
    }

    @Test
    fun theMinutesAreCountedOnTheServersClock() {
        // The shop's computer is three minutes ahead of the phone: for it the hour ends at
        // 10:00, which is 09:57 on the phone.
        skew = 3 * 60_000
        val w = watch()
        val end = start + 60 * 60_000
        pc(5, true, active("s1", end))
        w.sync(all())
        assertEquals(end - 8 * 60_000, w.nextDue(clock.now))
        clock.now = end - 8 * 60_000 - 1_000
        w.tick()
        assertEquals(emptyList<String>(), titles())
        clock.now = end - 8 * 60_000
        w.tick()
        assertEquals(listOf("PC 05: mbeten 5 min"), titles())
        // The hour is shown as the owner's own phone will show it.
        assertEquals("Driton · mbaron në 09:57", notes[0].text)
    }

    @Test
    fun afterASleepTheServerIsAskedBeforeAWarning() {
        val w = watch()
        val end = start + 60 * 60_000
        pc(5, true, active("s1", end))
        w.sync(all())
        // The phone slept; nothing is known about the link.
        fresh = false
        clock.now = end - 5 * 60_000
        w.tick()
        assertEquals(emptyList<String>(), titles())
        // The link turns out to be dead; on the new one the server tells of an extension made meanwhile.
        fresh = true
        pc(5, true, active("s1", end + 30 * 60_000))
        w.sync(all())
        clock.plus(5_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(end + 25 * 60_000, w.nextDue(clock.now))
    }

    @Test
    fun aLinkThatAnswersLetsTheWarningThrough() {
        val w = watch()
        val end = start + 60 * 60_000
        pc(5, true, active("s1", end))
        w.sync(all())
        fresh = false
        clock.now = end - 5 * 60_000
        w.tick()
        fresh = true
        clock.plus(300)
        w.tick()
        assertEquals(listOf("PC 05: mbeten 5 min"), titles())
    }

    @Test
    fun withTheWarningSwitchedOffNoWakeUpIsAskedFor() {
        off += Topic.PC_ENDING
        val w = watch()
        val end = start + 60 * 60_000
        pc(5, true, active("s1", end))
        w.sync(all())
        assertEquals(0L, w.nextDue(clock.now))
        // Switched on with four minutes to go: it still comes.
        clock.now = end - 4 * 60_000
        w.tick()
        off -= Topic.PC_ENDING
        w.tick()
        assertEquals(listOf("PC 05: mbeten 4 min"), titles())
    }

    @Test
    fun withPowerMessagesSwitchedOffNothingIsReadForThem() {
        off += setOf(Topic.PC_POWER, Topic.PC_DROPPED)
        val w = watch()
        pc(1, false); pc(2, false)
        w.sync(all())
        api.asked.clear()
        w.station(pc(1, true))
        clock.plus(5_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        assertEquals(emptyList<String>(), api.asked)
        assertEquals(0L, w.nextDue(clock.now))
        // Switched on later: what happened before is not brought up again.
        off.clear()
        clock.plus(60_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
        w.station(pc(2, true))
        clock.plus(3_000)
        w.tick()
        assertEquals(listOf("PC 02 u ndez"), titles())
    }

    @Test
    fun theOwnerChoosesHowManyMinutesBefore() {
        store.put("opt.${Options.ENDING_MINUTES}", "10")
        val w = watch()
        val end = start + 60 * 60_000
        pc(5, true, active("s1", end))
        w.sync(all())
        clock.now = end - 10 * 60_000
        w.tick()
        assertEquals(listOf("PC 05: mbeten 10 min"), titles())
    }

    @Test
    fun shortAndPausedAndOpenSessionsGetNoWarning() {
        val w = watch()
        // Three minutes in all: never longer than the warning time.
        pc(1, true, active("short", start + 3 * 60_000))
        // Open time has no end.
        pc(2, true, active("open", null))
        w.sync(all())
        w.session(parseObject("""{"id":"paused","stationId":"st-3","stationCode":"PC 03","status":"paused",
            "startedAt":"${iso(start - 50 * 60_000)}","endsAt":"${iso(start + 2 * 60_000)}"}""")!!)
        clock.plus(60_000)
        w.tick()
        clock.plus(60_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
    }

    @Test
    fun timeThatRunsOutIsToldFromTheEvent() {
        val w = watch()
        pc(5, true, active("s1", start + 60 * 60_000))
        w.sync(all())
        clock.now = start + 60 * 60_000 + 500
        val expired = parseObject("""{"id":"s1","stationId":"st-5","stationCode":"PC 05","customerName":"Driton","pcLabel":null,
            "billingMode":"prepaid","status":"expired","startedAt":"${iso(start)}","endedAt":"${iso(start + 60 * 60_000)}",
            "endReason":"expired","billableSeconds":3600,"finalPriceCents":200,"awaitingPayment":false}""")!!
        w.session(expired)
        assertEquals(listOf("PC 05: koha mbaroi"), titles())
        assertEquals("Driton · 1 h 00 min · 2.00 €", notes[0].text)
        assertEquals(Topic.PC_ENDED, notes[0].topic)
        assertEquals(start + 60 * 60_000, notes[0].at)
        // The same event again (a reconnect) says nothing new.
        w.session(expired)
        assertEquals(1, notes.size)
    }

    @Test
    fun aSessionToBePaidAtTheEndSaysSo() {
        val w = watch()
        w.session(parseObject("""{"id":"s2","stationCode":"PC 02","pcLabel":"Tavolina 2","status":"expired","endedAt":"${iso(start)}",
            "billableSeconds":1800,"finalPriceCents":100,"awaitingPayment":true}""")!!)
        assertEquals("Tavolina 2 · 30 min · për t'u paguar 1.00 €", notes[0].text)
    }

    @Test
    fun timeThatRanOutWhileNobodyWatchedIsLookedUp() {
        val first = watch()
        pc(5, true, active("s1", start + 60 * 60_000))
        pc(6, true, active("s2", null))
        first.sync(all())

        // The phone has no connection for two hours. s1 ran out; s2 was closed by staff (that
        // one is in the audit log, so it is not told from here).
        clock.plus(2 * 60 * 60_000)
        pc(5, true); pc(6, true)
        api.answers["/sessions/s1"] = """{"id":"s1","stationCode":"PC 05","customerName":"Driton","status":"expired",
            "endedAt":"${iso(start + 60 * 60_000)}","billableSeconds":3600,"finalPriceCents":200}"""
        api.answers["/sessions/s2"] = """{"id":"s2","stationCode":"PC 06","status":"completed","endedAt":"${iso(start + 90 * 60_000)}"}"""
        val second = watch()
        second.sync(all())
        assertEquals(listOf("PC 05: koha mbaroi"), titles())
        // …and not again at the next look.
        second.sync(all())
        assertEquals(1, notes.size)
    }

    @Test
    fun nothingFromBeforeTheSignInIsAnnounced() {
        baseline = start
        val w = watch()
        w.session(parseObject("""{"id":"old","stationCode":"PC 01","status":"expired","endedAt":"${iso(start - 60_000)}","billableSeconds":60}""")!!)
        assertEquals(emptyList<String>(), titles())
    }

    @Test
    fun aNewSignInForgetsEverything() {
        val w = watch()
        pc(1, true)
        w.sync(all())
        w.reset()
        assertEquals(0 to 0, w.tally())
        // The next look is a first look again.
        pc(1, false)
        w.sync(all())
        clock.plus(60_000)
        w.tick()
        assertEquals(emptyList<String>(), titles())
    }

    @Test
    fun pcCodesAreListedInOrder() {
        assertEquals(listOf("PC 02", "PC 10", "VIP"), PcWatch.sorted(listOf("VIP", "PC 10", "PC 02")))
        assertEquals("PC 01, PC 02 +2", PcWatch.list(listOf("PC 01", "PC 02", "PC 03", "PC 04"), max = 2))
    }
}
