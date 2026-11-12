package com.likapcs.live.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * What the PCs themselves are doing, read from the server's live view of them (`GET /stations`,
 * and the `station.changed` / `session.changed` events):
 *
 *  - a PC came on (its client connected to the server) or went off;
 *  - a PC went off while a customer's session was running on it;
 *  - a session has only a few minutes left;
 *  - a session's time ran out.
 *
 * The server writes none of this to its audit log, so it cannot come from there. Several PCs
 * coming on within a short time (the morning) are one message that grows: "PC 03 u ndez" becomes
 * "U ndezën 12 PC". A PC that only blinks (a cable, a restart of its client) is not announced.
 *
 * What the owner was last told is stored, so a restart of the app repeats nothing, and a change
 * made while the phone had no connection is told when it is back.
 *
 * Not thread-safe: the engine calls it on its own thread.
 */
class PcWatch(
    private val store: Store,
    private val options: Options,
    private val texts: () -> Texts,
    private val post: (Note) -> Unit,
    /** True while messages of this topic would be shown (its kind and the topic are both on). */
    private val wants: (Topic) -> Boolean,
    /** GET on an API path; null on any failure. */
    private val fetch: (String) -> JsonElement?,
    /** Nothing that happened before this moment is announced (the sign-in). */
    private val baseline: () -> Long,
    private val clock: () -> Long = System::currentTimeMillis,
    /**
     * How far the server's clock is ahead of this phone's (ms). A session ends by the server's
     * clock, so "5 minutes left" has to be counted on that one.
     */
    private val skew: () -> Long = { 0L },
    /**
     * True while the link to the server is known to be alive: only then is what is known about a
     * session certain to be current (it may have been extended while the phone slept).
     */
    private val fresh: () -> Boolean = { true },
) {
    private class Pc(val id: String) {
        var code = "PC"
        var paired = false
        var online = false

        /** When `online` last changed, on this phone's clock. */
        var changedAt = 0L
        var sessionId: String? = null
    }

    private class Session(val id: String) {
        var code = "PC"
        var status = "active"
        var startedAt = 0L
        var endsAt: Long? = null
        var who: String? = null
    }

    /** One growing message: the PCs that came on (or went off) shortly after each other. */
    private class Batch(val key: String, val startedAt: Long) {
        val codes = LinkedHashSet<String>()
        var lastAt = startedAt
    }

    private val pcs = LinkedHashMap<String, Pc>()

    /** stationId → online, as the owner was last told (or as it was when the watch began). */
    private val announced = HashMap<String, Boolean>()
    private val sessions = LinkedHashMap<String, Session>()

    /** `sessionId:endsAt` of the "few minutes left" messages already sent. */
    private val warned = LinkedHashSet<String>()

    /** Sessions whose end was already announced here. */
    private val ended = LinkedHashSet<String>()
    private var began = false
    private var loaded = false
    private var onBatch: Batch? = null
    private var offBatch: Batch? = null

    /** When the next PC change is ripe to be told (0: none is waiting). */
    private var pendingAt = 0L

    /** When the full list of PCs was last read. */
    private var lookedAt = 0L

    // ─── What the engine feeds in ───────────────────────────────────────────────────────────

    /** The full list of PCs (`GET /stations`): at every connect, and on every wake-up. */
    fun sync(stations: List<JsonObject>) {
        load()
        val now = clock()
        lookedAt = now
        val present = HashSet<String>()
        val live = HashSet<String>()
        for (s in stations) {
            val id = s.str("id") ?: continue
            if (s.obj("archived") != null) continue
            present += id
            observe(s, now)
            s.obj("activeSession").str("id")?.let { live += it }
        }
        pcs.keys.retainAll(present)
        announced.keys.retainAll(present)
        // Sessions that were running when last seen and are gone now ended while nobody watched.
        // Staff ending one is in the audit log; time running out is not, so it is looked up here.
        val gone = sessions.keys.filter { it !in live }
        for (id in gone.take(GONE_MAX)) {
            val s = fetch("/sessions/$id").asObj() ?: continue
            if (s.str("status") == "expired") expired(s)
        }
        for (id in gone) sessions.remove(id)
        if (!began) {
            // The first look after a sign-in: this is where "from now on" starts.
            began = true
            for (pc in pcs.values) announced[pc.id] = pc.online
        }
        save()
        tick()
    }

    /** One PC changed (`station.changed`). */
    fun station(s: JsonObject) {
        load()
        if (!began) return
        observe(s, clock())
        tick()
    }

    /** One session changed (`session.changed`, a `SessionSummary`). */
    fun session(s: JsonObject) {
        load()
        val id = s.str("id") ?: return
        when (s.str("status")) {
            "active", "paused" -> track(
                id = id,
                code = s.str("stationCode"),
                status = s.str("status") ?: "active",
                startedAt = Texts.parseTime(s.str("startedAt")),
                endsAt = Texts.parseTime(s.str("endsAt")),
                who = s.str("pcLabel") ?: s.str("customerName"),
            )
            "expired" -> {
                sessions.remove(id)
                expired(s)
            }
            else -> sessions.remove(id)
        }
        saveSessions()
        tick()
    }

    /** Tells what is ripe: PC changes that have settled, sessions that are about to end. */
    fun tick() {
        load()
        flush()
        // Switched off: nothing is counted as said, so switching it on takes effect at once.
        if (!wants(Topic.PC_ENDING)) return
        val now = clock()
        val ahead = skew()
        val lead = options.endingMinutes * 60_000L
        var changed = false
        // "5 minutes left" must not be said about a session that was extended meanwhile.
        val certain = fresh()
        for (s in sessions.values) {
            if (s.status != "active") continue
            // The end on this phone's clock.
            val end = (s.endsAt ?: continue) - ahead
            val key = "${s.id}:${s.endsAt}"
            if (key in warned || now < end - lead) continue
            // Not certain, and still of use a little later: the engine asks the server and comes back.
            if (!certain && now <= end - MIN_LEFT_MS) continue
            warned += key
            changed = true
            // Too late to be of use, or a session that was hardly longer than the warning time.
            if (now > end - MIN_LEFT_MS || end - (s.startedAt - ahead) <= lead + SHORT_MS) continue
            val x = texts()
            val left = ((end - now + 59_999) / 60_000).coerceAtLeast(1)
            post(
                Note(
                    key = "ending:$key",
                    category = Category.PCS,
                    title = x.t("${s.code}: mbeten $left min", "${s.code}: $left min left"),
                    text = listOfNotNull(s.who, x.t("mbaron në ${x.time(end, now)}", "ends at ${x.time(end, now)}")).joinToString(" · "),
                    at = now,
                    topic = Topic.PC_ENDING,
                ),
            )
        }
        if (changed) {
            trim(warned, 200)
            store.put(WARNED, buildJsonArray { warned.forEach { add(JsonPrimitive(it)) } }.toString())
        }
    }

    /** The next moment `tick` has something to do (epoch ms, later than `now`); 0: nothing is waiting. */
    fun nextDue(now: Long): Long {
        var next = if (pendingAt > now) pendingAt else 0L
        if (!wants(Topic.PC_ENDING)) return next
        val lead = options.endingMinutes * 60_000L
        val ahead = skew()
        for (s in sessions.values) {
            if (s.status != "active") continue
            val end = s.endsAt ?: continue
            val due = end - ahead - lead
            if (due > now && "${s.id}:$end" !in warned && (next == 0L || due < next)) next = due
        }
        return next
    }

    /** How many PCs are on, and how many there are (PCs with a client installed). */
    fun tally(): Pair<Int, Int> = pcs.values.count { it.online } to pcs.values.count { it.paired }

    /** A new sign-in: forget everything. */
    fun reset() {
        pcs.clear()
        announced.clear()
        sessions.clear()
        warned.clear()
        ended.clear()
        began = false
        loaded = true
        onBatch = null
        offBatch = null
        pendingAt = 0
        lookedAt = 0
        for (key in listOf(ANNOUNCED, SESSIONS, WARNED, ENDED)) store.put(key, null)
    }

    // ─── PCs on and off ─────────────────────────────────────────────────────────────────────

    private fun observe(s: JsonObject, now: Long) {
        val id = s.str("id") ?: return
        if (s.bool("deleted") == true || s.obj("archived") != null) {
            pcs.remove(id)
            announced.remove(id)
            return
        }
        val device = s.obj("device")
        val online = device.bool("online") == true
        var pc = pcs[id]
        if (pc == null) {
            pc = Pc(id)
            pc.online = online
            pc.changedAt = now
            pcs[id] = pc
        } else if (pc.online != online) {
            pc.online = online
            pc.changedAt = now
        }
        pc.code = s.str("code") ?: s.str("name") ?: pc.code
        pc.paired = device != null
        val active = s.obj("activeSession")
        pc.sessionId = active.str("id")
        if (active != null && pc.sessionId != null) {
            track(
                id = pc.sessionId!!,
                code = pc.code,
                status = active.str("status") ?: "active",
                startedAt = Texts.parseTime(active.str("startedAt")),
                endsAt = Texts.parseTime(active.str("endsAt")),
                who = active.str("pcLabel") ?: active.str("customerName"),
            )
        }
        // A PC seen for the first time later on (newly added): nothing to tell about it yet.
        if (began && id !in announced) announced[id] = pc.online
    }

    /** How long a change must last before it is told. */
    private fun settle(pc: Pc): Long = when {
        pc.online -> ON_SETTLE_MS
        playing(pc) -> DROP_SETTLE_MS
        else -> OFF_SETTLE_MS
    }

    /** A customer's session is on this PC, and the owner wants to hear when such a PC goes off. */
    private fun playing(pc: Pc): Boolean = pc.sessionId?.let { sessions[it] } != null && wants(Topic.PC_DROPPED)

    private fun flush() {
        val now = clock()
        if (!wants(Topic.PC_POWER) && !wants(Topic.PC_DROPPED)) {
            // Nobody wants to hear of it: the changes count as told, and nothing is read for them.
            var moved = false
            for (pc in pcs.values) if (announced[pc.id].let { it != null && it != pc.online }) {
                announced[pc.id] = pc.online
                moved = true
            }
            pendingAt = 0
            if (moved) saveAnnounced()
            return
        }
        // Before anything is told, look again: an event can be older than what was read since,
        // and "PC 05 u fik" must never be a mistake.
        val ripe = pcs.values.any { pc -> announced[pc.id].let { it != null && it != pc.online } && now >= pc.changedAt + settle(pc) }
        if (ripe && now - lookedAt > FRESH_MS) {
            val list = fetch("/stations").asArr().objects()
            if (list.isEmpty()) {
                // No answer (the link is down): told after the next full read.
                pendingAt = 0
                return
            }
            lookedAt = now
            for (s in list) observe(s, now)
        }
        val on = ArrayList<Pc>()
        val off = ArrayList<Pc>()
        val dropped = ArrayList<Pc>()
        var next = 0L
        for (pc in pcs.values) {
            val told = announced[pc.id] ?: continue
            if (told == pc.online) continue
            val due = pc.changedAt + settle(pc)
            if (now >= due) {
                announced[pc.id] = pc.online
                when {
                    pc.online -> on += pc
                    playing(pc) -> dropped += pc
                    else -> off += pc
                }
            } else if (next == 0L || due < next) {
                next = due
            }
        }
        pendingAt = next
        if (on.isEmpty() && off.isEmpty() && dropped.isEmpty()) return
        saveAnnounced()
        if (on.isNotEmpty()) announce(true, on, now)
        if (off.isNotEmpty()) announce(false, off, now)
        for (pc in dropped) drop(pc, now)
    }

    private fun announce(on: Boolean, changed: List<Pc>, now: Long) {
        val open = (if (on) onBatch else offBatch)?.takeIf { now - it.lastAt <= MERGE_MS && now - it.startedAt <= MERGE_MAX_MS }
        val batch = open ?: Batch("pc-${if (on) "on" else "off"}:$now", now)
        for (pc in changed) batch.codes += pc.code
        batch.lastAt = now
        if (on) onBatch = batch else offBatch = batch

        val x = texts()
        val codes = sorted(batch.codes)
        val n = codes.size
        val (up, all) = tally()
        val standing = x.t("$up nga $all PC janë ndezur", "$up of $all PCs are on")
        val title = when {
            on && n == 1 -> x.t("${codes[0]} u ndez", "${codes[0]} came on")
            on -> x.t("U ndezën $n PC", "$n PCs came on")
            n == 1 -> x.t("${codes[0]} u fik", "${codes[0]} went off")
            else -> x.t("U fikën $n PC", "$n PCs went off")
        }
        post(
            Note(
                key = batch.key,
                category = Category.POWER,
                title = title,
                text = if (n == 1) standing else "${list(codes)} · $standing",
                at = now,
                topic = Topic.PC_POWER,
                update = open != null,
            ),
        )
    }

    private fun drop(pc: Pc, now: Long) {
        val x = texts()
        val s = pc.sessionId?.let { sessions[it] }
        val left = s?.endsAt?.let { it - skew() - now }?.takeIf { it > 0 }
            ?.let { x.t("mbeten ${x.duration(it / 1000)}", "${x.duration(it / 1000)} left") }
        post(
            Note(
                key = "pc-drop:${pc.id}:$now",
                category = Category.ALERTS,
                title = x.t("${pc.code} u fik gjatë seancës", "${pc.code} went off during a session"),
                text = listOfNotNull(
                    s?.who,
                    left,
                    x.t("PC-ja nuk është më e lidhur me serverin", "the PC is no longer connected to the server"),
                ).joinToString(" · "),
                at = now,
                topic = Topic.PC_DROPPED,
            ),
        )
    }

    // ─── Sessions ───────────────────────────────────────────────────────────────────────────

    private fun track(id: String, code: String?, status: String, startedAt: Long?, endsAt: Long?, who: String?) {
        val s = sessions.getOrPut(id) { Session(id) }
        if (!code.isNullOrBlank()) s.code = code
        s.status = status
        if (startedAt != null) s.startedAt = startedAt
        s.endsAt = endsAt
        if (who != null) s.who = who
    }

    /** A session's time ran out (a `SessionSummary` with status `expired`). */
    private fun expired(s: JsonObject) {
        val id = s.str("id") ?: return
        if (!ended.add(id)) return
        trim(ended, 100)
        store.put(ENDED, buildJsonArray { ended.forEach { add(JsonPrimitive(it)) } }.toString())
        val now = clock()
        val at = Texts.parseTime(s.str("endedAt")) ?: now
        if (at < baseline()) return
        val x = texts()
        val pc = s.str("stationCode") ?: "PC"
        val price = s.long("finalPriceCents") ?: s.long("quotedPriceCents") ?: s.long("currentPriceCents")
        val parts = ArrayList<String>()
        (s.str("pcLabel") ?: s.str("customerName"))?.let { parts += it }
        s.long("billableSeconds")?.takeIf { it > 0 }?.let { parts += x.duration(it) }
        if (price != null && price > 0) {
            parts += if (s.bool("awaitingPayment") == true) x.t("për t'u paguar ${x.money(price)}", "${x.money(price)} to be paid") else x.money(price)
        }
        post(
            Note(
                key = "session-end:$id",
                category = Category.PCS,
                title = x.t("$pc: koha mbaroi", "$pc: time is up"),
                text = parts.joinToString(" · "),
                at = at,
                topic = Topic.PC_ENDED,
            ),
        )
    }

    // ─── Storage ────────────────────────────────────────────────────────────────────────────

    private fun load() {
        if (loaded) return
        loaded = true
        parseObject(store.get(ANNOUNCED))?.let { saved ->
            began = true
            for ((id, value) in saved) announced[id] = (value as? JsonPrimitive)?.content == "true"
        }
        for (o in (parseJson(store.get(SESSIONS)) as? JsonArray).objects()) {
            val id = o.str("id") ?: continue
            track(id, o.str("code"), o.str("status") ?: "active", o.long("startedAt"), o.long("endsAt"), o.str("who"))
        }
        (parseJson(store.get(WARNED)) as? JsonArray)?.forEach { (it as? JsonPrimitive)?.content?.let(warned::add) }
        (parseJson(store.get(ENDED)) as? JsonArray)?.forEach { (it as? JsonPrimitive)?.content?.let(ended::add) }
    }

    private fun save() {
        saveAnnounced()
        saveSessions()
    }

    private fun saveAnnounced() {
        if (!began) return
        store.put(ANNOUNCED, buildJsonObject { for ((id, online) in announced) put(id, online) }.toString())
    }

    private fun saveSessions() {
        val text = buildJsonArray {
            for (s in sessions.values) {
                add(buildJsonObject {
                    put("id", s.id)
                    put("code", s.code)
                    put("status", s.status)
                    put("startedAt", s.startedAt)
                    s.endsAt?.let { put("endsAt", it) }
                    s.who?.let { put("who", it) }
                })
            }
        }.toString()
        if (text != store.get(SESSIONS)) store.put(SESSIONS, text)
    }

    private fun <T> trim(set: LinkedHashSet<T>, max: Int) {
        val it = set.iterator()
        while (set.size > max && it.hasNext()) {
            it.next()
            it.remove()
        }
    }

    companion object {
        private const val ANNOUNCED = "pcs.announced"
        private const val SESSIONS = "pcs.sessions"
        private const val WARNED = "pcs.warned"
        private const val ENDED = "pcs.ended"

        /** A PC that came on is told after this long: the ones right behind it join the same message. */
        const val ON_SETTLE_MS = 2_500L

        /** A PC that went off is told only when it stays off this long (a blink is not news). */
        const val OFF_SETTLE_MS = 10_000L

        /** …and longer when a customer was playing on it: the alert must not be a false alarm. */
        const val DROP_SETTLE_MS = 30_000L

        /** PCs that change within this time of the one before join its message… */
        const val MERGE_MS = 120_000L

        /** …but a message does not keep growing longer than this. */
        const val MERGE_MAX_MS = 10 * 60_000L

        /** With less than this left, "a few minutes left" is no longer worth saying. */
        private const val MIN_LEFT_MS = 20_000L

        /** A session this little longer than the warning time gets no warning (it would come at its start). */
        private const val SHORT_MS = 30_000L

        /** A full read this fresh needs no second look before a change is told. */
        private const val FRESH_MS = 1_500L

        /** How many vanished sessions are looked up after a gap. */
        private const val GONE_MAX = 20

        /** "PC 02" before "PC 10". */
        fun sorted(codes: Collection<String>): List<String> =
            codes.sortedWith(compareBy({ it.filter(Char::isDigit).toIntOrNull() ?: Int.MAX_VALUE }, { it }))

        /** "PC 01, PC 02, PC 03" — a long list ends in "+4". */
        fun list(codes: List<String>, max: Int = 12): String =
            if (codes.size <= max) codes.joinToString(", ") else codes.take(max).joinToString(", ") + " +${codes.size - max}"
    }
}
