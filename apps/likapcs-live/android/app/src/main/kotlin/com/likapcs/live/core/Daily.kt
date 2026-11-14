package com.likapcs.live.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.net.URLEncoder
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * The messages that come from the clock and from the day's figures rather than from one event:
 *
 *  - the day's turnover passed the next mark (every 100 €, say);
 *  - the summary of the day at the hour the owner chose;
 *  - the debts that are due today, once in the morning;
 *  - no sale for some hours inside the working hours;
 *  - a reservation starts soon (at the reminder time the shop set for it).
 *
 * Hours are the shop's (`zone`: the server's time zone setting), as the day itself is: an owner
 * who is abroad still gets the summary when the shop's day ends. Everything is read from the
 * server; nothing is computed beyond adding up what the server lists. What was already said is
 * stored, so nothing repeats.
 *
 * Not thread-safe: the engine calls it on its own thread.
 */
class Daily(
    private val store: Store,
    private val options: Options,
    private val texts: () -> Texts,
    private val post: (Note) -> Unit,
    /** True while messages of this topic would be shown (its kind and the topic are both on). */
    private val wants: (Topic) -> Boolean,
    /** GET on an API path; null on any failure. */
    private val fetch: (String) -> JsonElement?,
    /** Reads the day's figures again (the engine's own read, which calls `snapshot`); null on failure. */
    private val refresh: () -> JsonObject?,
    private val can: (String) -> Boolean,
    private val online: () -> Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    /** The shop's time zone. */
    private val zone: () -> ZoneId = ZoneId::systemDefault,
    /** How far the server's clock is ahead of this phone's (ms): the times of sales are the server's. */
    private val skew: () -> Long = { 0L },
) {
    private class Reservation(val id: String, val startsAt: Long, val remindAt: Long, val who: String, val pcs: List<String>, val phone: String?)

    private var reservations: List<Reservation> = emptyList()
    private var reservationsAt = 0L
    private var reservationsStale = true
    private val reminded = LinkedHashSet<String>()
    private var loaded = false

    /** When the last sale of the day was made (epoch ms on this phone's clock); 0 when not known. */
    private var lastSaleAt = 0L

    /** When each kind of read was last tried: one that fails is not tried again at once. */
    private val triedAt = HashMap<String, Long>()

    /** May this read be tried now? One that failed is left alone for a while (`worked` forgets the failure). */
    private fun mayTry(what: String, now: Long): Boolean {
        val last = triedAt[what]
        if (last != null && now - last < RETRY_MS && now >= last) return false
        triedAt[what] = now
        return true
    }

    private fun worked(what: String) {
        triedAt.remove(what)
    }

    // ─── What the engine feeds in ───────────────────────────────────────────────────────────

    /** The day's figures were read (`GET /live/snapshot`). */
    fun snapshot(snap: JsonObject) {
        load()
        val totals = snap.obj("totals")
        val date = snap.str("date") ?: return
        var newest = 0L
        for (s in snap.arr("staff").objects()) Texts.parseTime(s.str("lastSaleAt"))?.let { if (it > newest) newest = it }
        for (s in snap.arr("feed").objects()) Texts.parseTime(s.str("completedAt"))?.let { if (it > newest) newest = it }
        if (newest > 0 && newest - skew() > lastSaleAt) lastSaleAt = newest - skew()

        val figures = buildJsonObject {
            put("date", date)
            put("at", clock())
            put("turnoverCents", totals.long("turnoverCents") ?: 0)
            put("salesCount", totals.long("salesCount") ?: 0)
            put("grossProfitCents", totals.long("grossProfitCents") ?: 0)
            put("netProfitCents", totals.long("netProfitCents") ?: 0)
            put("expensesCents", totals.long("expensesCents") ?: 0)
            put("refundedCents", totals.long("refundedCents") ?: 0)
            put("incomplete", totals.bool("incomplete") == true)
            put("drawerOpen", snap.obj("drawer").bool("open") == true)
            snap.obj("drawer").long("expectedCents")?.let { put("drawerExpectedCents", it) }
            put("lastSaleAt", lastSaleAt)
            putJsonArray("staff") {
                snap.arr("staff").objects()
                    .filter { (it.long("salesCount") ?: 0) > 0 }
                    .sortedByDescending { it.long("salesCents") ?: 0 }
                    .forEach { s ->
                        add(buildJsonObject {
                            put("name", s.str("name") ?: "?")
                            put("salesCents", s.long("salesCents") ?: 0)
                            put("salesCount", s.long("salesCount") ?: 0)
                        })
                    }
            }
        }
        store.put(FIGURES, figures.toString())
        turnoverMark(date, figures)
    }

    /** A sale was just made (`live.sale`); `at` is its time on the server's clock. */
    fun sale(at: Long) {
        if (at - skew() > lastSaleAt) lastSaleAt = at - skew()
    }

    /** A reservation was made, changed or cancelled (`reservation.changed`). */
    fun reservationsChanged() {
        reservationsStale = true
        triedAt.remove("reservations")
    }

    /** Says what is due now. */
    fun tick() {
        load()
        val now = clock()
        summary(now)
        debts(now)
        idle(now)
        reservations(now)
    }

    /** The next moment `tick` has something to do (epoch ms, later than `now`); 0: nothing is waiting. */
    fun nextDue(now: Long): Long {
        load()
        val today = date(now)
        val times = ArrayList<Long>()
        if (wants(Topic.DAY_SUMMARY)) times += next(today, options.summaryAt, now, store.get(SUMMARY_DONE))
        if (wants(Topic.DEBT_DUE) && can(CUSTOMERS_VIEW)) times += next(today, options.debtsAt, now, store.get(DEBTS_DONE))
        if (wants(Topic.SALES_IDLE)) {
            val from = options.workFrom
            val to = options.workTo
            val wait = options.idleMinutes * 60_000L
            if (Options.inWindow(Options.minuteOfDay(now, zone()), from, to)) {
                times += maxOf(lastSaleAt, opened(now, from, to)) + wait
            } else if (from != to) {
                // Closed now: the first check is one waiting time after the next opening.
                val open = at(today, from).let { if (it > now) it else at(today.plusDays(1), from) }
                times += open + wait
            }
        }
        if (wants(Topic.RESERVATION_SOON) && can(STATIONS_VIEW)) {
            // (The list itself is read again at the periodic wake-ups: no appointment for that.)
            for (r in reservations) if ("${r.id}:${r.startsAt}" !in reminded) times += r.remindAt
            // A reminder that waits for the list to be read again (that read failed a moment ago).
            if (online() && reservations.any { ripe(it, now) }) times += (triedAt["reservations"] ?: now) + RETRY_MS
        }
        return times.filter { it > now }.minOrNull() ?: 0L
    }

    /**
     * The owner moved the hour of the summary or of the debts: the new hour counts from now, even
     * when today's message went out already (an hour that has just passed is caught up at once).
     */
    fun hourMoved(option: String) {
        when (option) {
            Options.SUMMARY_AT -> store.put(SUMMARY_DONE, null)
            Options.DEBTS_AT -> {
                store.put(DEBTS_DONE, null)
                triedAt.remove("debts")
            }
        }
    }

    /** A new sign-in: forget everything; what was due earlier today is not caught up. */
    fun reset() {
        loaded = true
        reservations = emptyList()
        reservationsAt = 0
        reservationsStale = true
        reminded.clear()
        triedAt.clear()
        lastSaleAt = 0
        for (key in listOf(FIGURES, MARK, IDLE_DONE, REMINDED)) store.put(key, null)
        val now = clock()
        val today = date(now)
        store.put(SUMMARY_DONE, if (now >= at(today, options.summaryAt)) today.toString() else null)
        store.put(DEBTS_DONE, if (now >= at(today, options.debtsAt)) today.toString() else null)
    }

    // ─── The turnover mark ──────────────────────────────────────────────────────────────────

    private fun turnoverMark(date: String, figures: JsonObject) {
        val step = options.stepCents
        val turnover = figures.long("turnoverCents") ?: 0
        val index = if (turnover <= 0) 0 else turnover / step
        val saved = store.get(MARK)?.split('|')
        val same = saved != null && saved.size == 3 && saved[0] == date && saved[1] == step.toString()
        val before = if (same) saved!![2].toLongOrNull() ?: 0 else null
        // A new day, a new step, or the first look: this is where counting starts.
        if (before == null || index != before) store.put(MARK, "$date|$step|${if (before == null) index else maxOf(index, before)}")
        if (before == null || index <= before) return
        val x = texts()
        post(
            Note(
                key = "turnover:$date:$index",
                category = Category.DAY,
                title = x.t("Qarkullimi i ditës kaloi ${x.money(index * step)}", "The day's turnover passed ${x.money(index * step)}"),
                text = listOf(
                    x.t("Sot ${x.money(turnover)}", "Today ${x.money(turnover)}"),
                    x.t("${figures.long("salesCount") ?: 0} shitje", "${figures.long("salesCount") ?: 0} sales"),
                    x.t("fitimi ${x.money(figures.long("grossProfitCents"))}", "profit ${x.money(figures.long("grossProfitCents"))}"),
                ).joinToString(" · "),
                at = clock(),
                tab = "sales",
                topic = Topic.TURNOVER_STEP,
            ),
        )
    }

    // ─── The summary of the day ─────────────────────────────────────────────────────────────

    private fun summary(now: Long) {
        if (!wants(Topic.DAY_SUMMARY)) return
        val today = date(now)
        val due = at(today, options.summaryAt)
        if (now < due || store.get(SUMMARY_DONE) == today.toString()) return
        store.put(SUMMARY_DONE, today.toString())
        // The app was not running at that hour: hours later it is no longer news.
        if (now - due > LATE_MS) return
        val fresh = if (online()) refresh() != null else false
        val f = parseObject(store.get(FIGURES)) ?: return
        // The figures must be this day's (after a day without a connection they are not).
        if (f.str("date") != today.toString()) return
        val x = texts()
        val count = f.long("salesCount") ?: 0
        val parts = ArrayList<String>()
        if (count > 0) {
            var profit = x.t("fitimi ${x.money(f.long("grossProfitCents"))}", "profit ${x.money(f.long("grossProfitCents"))}")
            if (f.bool("incomplete") == true) profit += x.t(" (pa disa kosto)", " (some costs missing)")
            parts += profit
            val staff = f.arr("staff").objects()
            if (staff.isNotEmpty()) {
                parts += staff.take(4).joinToString(", ") { "${it.str("name")} ${x.money(it.long("salesCents"))}" } +
                    if (staff.size > 4) " +${staff.size - 4}" else ""
            }
        }
        f.long("expensesCents")?.takeIf { it > 0 }?.let { parts += x.t("shpenzime ${x.money(it)}", "expenses ${x.money(it)}") }
        f.long("refundedCents")?.takeIf { it > 0 }?.let { parts += x.t("rimbursime ${x.money(it)}", "refunds ${x.money(it)}") }
        if (f.bool("drawerOpen") == true) f.long("drawerExpectedCents")?.let { parts += x.t("në arkë ${x.money(it)}", "in the drawer ${x.money(it)}") }
        if (!fresh) f.long("at")?.let { parts += x.t("gjendja e orës ${x.time(it, now)}", "as of ${x.time(it, now)}") }
        post(
            Note(
                key = "day-summary:$today",
                category = Category.DAY,
                title = if (count > 0) {
                    x.t("Dita sot: ${x.money(f.long("turnoverCents"))} · $count shitje", "Today: ${x.money(f.long("turnoverCents"))} · $count sales")
                } else {
                    x.t("Dita sot: asnjë shitje", "Today: no sales")
                },
                text = parts.joinToString(" · "),
                at = now,
                tab = "sales",
                topic = Topic.DAY_SUMMARY,
            ),
        )
    }

    // ─── Debts due today ────────────────────────────────────────────────────────────────────

    private fun debts(now: Long) {
        if (!wants(Topic.DEBT_DUE) || !can(CUSTOMERS_VIEW)) return
        val today = date(now)
        if (now < at(today, options.debtsAt) || store.get(DEBTS_DONE) == today.toString()) return
        // Without a connection: later today, when the link is back.
        if (!online() || !mayTry("debts", now)) return
        val answer = fetch("/debts?filter=due_today&pageSize=50").asObj() ?: return
        store.put(DEBTS_DONE, today.toString())
        val due = answer.arr("items").objects().filter { (it.long("remainingCents") ?: 0) > 0 }
        if (due.isEmpty()) return
        val x = texts()
        val sum = due.sumOf { it.long("remainingCents") ?: 0 }
        val byCustomer = LinkedHashMap<String, Long>()
        for (d in due) {
            val name = d.str("customerName") ?: "?"
            byCustomer[name] = (byCustomer[name] ?: 0) + (d.long("remainingCents") ?: 0)
        }
        val names = byCustomer.entries.sortedByDescending { it.value }
        val parts = ArrayList<String>()
        parts += names.take(4).joinToString(", ") { "${it.key} ${x.money(it.value)}" } + if (names.size > 4) " +${names.size - 4}" else ""
        val overview = fetch("/debts/overview").asObj()
        val overdue = overview.long("overdueCount") ?: 0
        if (overdue > 0) {
            parts += x.t("të vonuara: $overdue · ${x.money(overview.long("overdueCents"))}", "overdue: $overdue · ${x.money(overview.long("overdueCents"))}")
        }
        post(
            Note(
                key = "debts-due:$today",
                category = Category.DAY,
                title = if (due.size == 1) {
                    x.t("Sot skadon një borxh · ${x.money(sum)}", "One debt is due today · ${x.money(sum)}")
                } else {
                    x.t("Sot skadojnë ${due.size} borxhe · ${x.money(sum)}", "${due.size} debts are due today · ${x.money(sum)}")
                },
                text = parts.joinToString(" · "),
                at = now,
                topic = Topic.DEBT_DUE,
            ),
        )
    }

    // ─── No sales ───────────────────────────────────────────────────────────────────────────

    private fun idle(now: Long) {
        if (!wants(Topic.SALES_IDLE) || !online()) return
        val from = options.workFrom
        val to = options.workTo
        if (!Options.inWindow(Options.minuteOfDay(now, zone()), from, to)) return
        val opened = opened(now, from, to)
        val wait = options.idleMinutes * 60_000L
        if (now - maxOf(lastSaleAt, opened) < wait) return
        if (store.get(IDLE_DONE) == maxOf(lastSaleAt, opened).toString()) return
        // Before saying it, read the day again: a sale may not have been reported here yet.
        if (!mayTry("idle", now)) return
        refresh() ?: return
        worked("idle")
        val since = maxOf(lastSaleAt, opened)
        if (now - since < wait || store.get(IDLE_DONE) == since.toString()) return
        store.put(IDLE_DONE, since.toString())
        val x = texts()
        post(
            Note(
                key = "idle:$since",
                category = Category.ALERTS,
                title = x.t("Asnjë shitje prej ${x.duration((now - since) / 1000)}", "No sale for ${x.duration((now - since) / 1000)}"),
                text = if (lastSaleAt >= opened) {
                    x.t("Shitja e fundit: ora ${x.time(lastSaleAt, now)}.", "Last sale: at ${x.time(lastSaleAt, now)}.")
                } else {
                    x.t("Ende asnjë shitje që nga ora ${Options.formatClock(from)}.", "No sale yet since ${Options.formatClock(from)}.")
                },
                at = now,
                tab = "sales",
                topic = Topic.SALES_IDLE,
            ),
        )
    }

    /** When the working hours that `now` falls in began (they may run over midnight). */
    private fun opened(now: Long, from: Int, to: Int): Long {
        val today = date(now)
        return if (from > to && Options.minuteOfDay(now, zone()) < to) at(today.minusDays(1), from) else at(today, from)
    }

    // ─── Reservations ───────────────────────────────────────────────────────────────────────

    private fun reservations(now: Long) {
        if (!wants(Topic.RESERVATION_SOON) || !can(STATIONS_VIEW)) return
        // The list is read again when it is old or was changed, and before any reminder: the
        // reservation may have been cancelled or moved since the list was read.
        val old = reservationsStale || now - reservationsAt >= RESERVATIONS_EVERY_MS ||
            (now - reservationsAt > RESERVATIONS_FRESH_MS && reservations.any { ripe(it, now) })
        if (old && online() && mayTry("reservations", now)) readReservations(now)
        // Not confirmed just now (no connection): no reminder. It comes when the list could be
        // read, as long as it is still of use then.
        if (now - reservationsAt > RESERVATIONS_FRESH_MS) return
        var changed = false
        for (r in reservations) {
            val key = "${r.id}:${r.startsAt}"
            if (key in reminded || now < r.remindAt) continue
            reminded += key
            changed = true
            // Long past its start (the phone was off): not a reminder any more.
            if (now > r.startsAt + RESERVATION_LATE_MS) continue
            val x = texts()
            val minutes = (r.startsAt - now + 30_000) / 60_000
            post(
                Note(
                    key = "reservation:$key",
                    category = Category.PCS,
                    title = if (minutes >= 1) {
                        x.t("Rezervim pas $minutes min: ${r.who}", "Reservation in $minutes min: ${r.who}")
                    } else {
                        x.t("Rezervimi fillon tani: ${r.who}", "Reservation starts now: ${r.who}")
                    },
                    text = listOfNotNull(
                        PcWatch.list(PcWatch.sorted(r.pcs)).ifEmpty { null },
                        x.t("ora ${x.time(r.startsAt, now)}", "at ${x.time(r.startsAt, now)}"),
                        r.phone,
                    ).joinToString(" · "),
                    at = now,
                    topic = Topic.RESERVATION_SOON,
                ),
            )
        }
        if (changed) {
            val it = reminded.iterator()
            while (reminded.size > 100 && it.hasNext()) {
                it.next()
                it.remove()
            }
            store.put(REMINDED, buildJsonArray { reminded.forEach { add(JsonPrimitive(it)) } }.toString())
        }
    }

    private fun readReservations(now: Long) {
        val from = URLEncoder.encode(Texts.isoTime(now - 60 * 60_000L), "UTF-8")
        val to = URLEncoder.encode(Texts.isoTime(now + 36 * 60 * 60_000L), "UTF-8")
        val answer = fetch("/reservations?from=$from&to=$to").asObj() ?: return
        worked("reservations")
        reservationsAt = now
        reservationsStale = false
        reservations = answer.arr("items").objects().mapNotNull { r ->
            if (r.str("status") != "scheduled") return@mapNotNull null
            val id = r.str("id") ?: return@mapNotNull null
            val startsAt = Texts.parseTime(r.str("startsAt")) ?: return@mapNotNull null
            Reservation(
                id = id,
                startsAt = startsAt,
                remindAt = Texts.parseTime(r.str("remindAt")) ?: startsAt,
                who = r.str("customerName") ?: "?",
                pcs = r.arr("stations").objects().mapNotNull { it.str("code") },
                phone = r.str("phone")?.takeIf { it.isNotBlank() },
            )
        }
    }

    /** A reminder for this reservation is due now and not sent yet. */
    private fun ripe(r: Reservation, now: Long): Boolean =
        now >= r.remindAt && now <= r.startsAt + RESERVATION_LATE_MS && "${r.id}:${r.startsAt}" !in reminded

    // ─── Helpers ────────────────────────────────────────────────────────────────────────────

    private fun load() {
        if (loaded) return
        loaded = true
        (parseJson(store.get(REMINDED)) as? JsonArray)?.forEach { (it as? JsonPrimitive)?.content?.let(reminded::add) }
        lastSaleAt = parseObject(store.get(FIGURES)).long("lastSaleAt") ?: 0
    }

    private fun date(epochMs: Long): LocalDate = Instant.ofEpochMilli(epochMs).atZone(zone()).toLocalDate()

    /** `minute` of that day on the shop's clock, as epoch ms. */
    private fun at(day: LocalDate, minute: Int): Long = day.atTime(minute / 60, minute % 60).atZone(zone()).toInstant().toEpochMilli()

    /** The next time a once-a-day message is due: today when it is still ahead, else tomorrow. */
    private fun next(today: LocalDate, minute: Int, now: Long, done: String?): Long {
        val due = at(today, minute)
        return if (due > now && done != today.toString()) due else at(today.plusDays(1), minute)
    }

    companion object {
        private const val FIGURES = "day.figures"
        private const val MARK = "day.mark"
        private const val SUMMARY_DONE = "day.summary.done"
        private const val DEBTS_DONE = "day.debts.done"
        private const val IDLE_DONE = "day.idle.done"
        private const val REMINDED = "day.reminded"

        const val CUSTOMERS_VIEW = "customers.view"
        const val STATIONS_VIEW = "stations.view"

        /** The summary of the day is not sent more than this long after its hour. */
        private const val LATE_MS = 3 * 60 * 60_000L

        /** The list of reservations is read again at least this often. */
        private const val RESERVATIONS_EVERY_MS = 30 * 60_000L

        /** A list read this recently is taken as it is when a reminder is due. */
        private const val RESERVATIONS_FRESH_MS = 60_000L

        /** A read that failed is tried again after this long. */
        private const val RETRY_MS = 2 * 60_000L

        /** A reminder is still sent this long after the reservation's start. */
        private const val RESERVATION_LATE_MS = 10 * 60_000L
    }
}
