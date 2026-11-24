package com.likapcs.live.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.Instant
import java.time.ZoneId

/**
 * What the owner chose in the app's settings beyond the kinds: the finer switches (`Topic`) and
 * the few numbers and hours some of them need. Everything has a default, so nothing has to be
 * set before the app is useful. Values are checked here; a value out of range is not stored.
 */
class Options(private val store: Store) {
    fun on(topic: Topic): Boolean = when (store.get(topicKey(topic))) {
        "1" -> true
        "0" -> false
        else -> topic.default
    }

    fun set(topic: Topic, on: Boolean) = store.put(topicKey(topic), if (on) "1" else "0")

    /** "Time is running out" comes this many minutes before a session ends. */
    val endingMinutes: Int get() = int(ENDING_MINUTES)

    /** A sale of this amount or more is a "big sale". */
    val bigSaleCents: Long get() = int(BIG_SALE_CENTS).toLong()

    /** The turnover mark: a message each time the day's turnover passes a multiple of this. */
    val stepCents: Long get() = int(STEP_CENTS).toLong()

    /** "No sales" comes after this many minutes without one, inside the working hours. */
    val idleMinutes: Int get() = int(IDLE_MINUTES)
    val workFrom: Int get() = clock(WORK_FROM)
    val workTo: Int get() = clock(WORK_TO)

    /** Minute of the day (the shop's clock) for the summary of the day / the debts due today. */
    val summaryAt: Int get() = clock(SUMMARY_AT)
    val debtsAt: Int get() = clock(DEBTS_AT)

    val quietOn: Boolean get() = store.get(key(QUIET_ON)) == "1"
    val quietFrom: Int get() = clock(QUIET_FROM)
    val quietTo: Int get() = clock(QUIET_TO)

    /** True: "things to look at" still ring during the quiet hours. */
    val quietAlerts: Boolean get() = store.get(key(QUIET_ALERTS)) == "1"

    /** True while `nowMs` falls inside the quiet hours (the phone's own clock; they may run over midnight). */
    fun quietAt(nowMs: Long, zone: ZoneId): Boolean = quietOn && inWindow(minuteOfDay(nowMs, zone), quietFrom, quietTo)

    /** Stores one value; false when the name is unknown or the value is out of range. */
    fun put(name: String, value: String): Boolean {
        val range = INTS[name]
        if (range != null) {
            val n = value.toIntOrNull() ?: return false
            if (n < range.min || n > range.max) return false
            store.put(key(name), n.toString())
            return true
        }
        if (name in CLOCKS) {
            val minutes = parseClock(value) ?: return false
            store.put(key(name), formatClock(minutes))
            return true
        }
        if (name in FLAGS) {
            if (value != "true" && value != "false" && value != "1" && value != "0") return false
            store.put(key(name), if (value == "true" || value == "1") "1" else "0")
            return true
        }
        return false
    }

    /** Every switch and value, for the settings screen. */
    fun toJson(): JsonObject = buildJsonObject {
        for ((name, range) in INTS) put(name, int(name, range))
        for (name in CLOCKS.keys) put(name, formatClock(clock(name)))
        for (name in FLAGS) put(name, store.get(key(name)) == "1")
    }

    fun topicsJson(): JsonObject = buildJsonObject { for (t in Topic.entries) put(t.id, on(t)) }

    private fun int(name: String, range: IntRange = INTS.getValue(name)): Int {
        val n = store.get(key(name))?.toIntOrNull() ?: return range.default
        return if (n < range.min || n > range.max) range.default else n
    }

    private fun clock(name: String): Int = parseClock(store.get(key(name))) ?: parseClock(CLOCKS.getValue(name))!!

    private fun topicKey(topic: Topic) = "topic.${topic.id}"

    private fun key(name: String) = "opt.$name"

    private class IntRange(val min: Int, val max: Int, val default: Int)

    companion object {
        const val ENDING_MINUTES = "ending.minutes"
        const val BIG_SALE_CENTS = "big.cents"
        const val STEP_CENTS = "step.cents"
        const val IDLE_MINUTES = "idle.minutes"
        const val WORK_FROM = "work.from"
        const val WORK_TO = "work.to"
        const val SUMMARY_AT = "summary.at"
        const val DEBTS_AT = "debts.at"
        const val QUIET_ON = "quiet.on"
        const val QUIET_FROM = "quiet.from"
        const val QUIET_TO = "quiet.to"
        const val QUIET_ALERTS = "quiet.alerts"

        private val INTS = linkedMapOf(
            ENDING_MINUTES to IntRange(1, 60, 5),
            BIG_SALE_CENTS to IntRange(100, 100_000_000, 5_000),
            STEP_CENTS to IntRange(1_000, 100_000_000, 10_000),
            IDLE_MINUTES to IntRange(1, 24 * 60, 120),
        )
        private val CLOCKS = linkedMapOf(
            WORK_FROM to "09:00",
            WORK_TO to "23:00",
            SUMMARY_AT to "23:00",
            DEBTS_AT to "09:00",
            QUIET_FROM to "23:30",
            QUIET_TO to "08:00",
        )
        private val FLAGS = listOf(QUIET_ON, QUIET_ALERTS)

        /** "09:05" → 545; null when it is not a time of day. */
        fun parseClock(text: String?): Int? {
            val match = CLOCK.matchEntire(text?.trim() ?: return null) ?: return null
            val h = match.groupValues[1].toInt()
            val m = match.groupValues[2].toInt()
            return if (h > 23 || m > 59) null else h * 60 + m
        }

        fun formatClock(minutes: Int): String =
            "${(minutes / 60).toString().padStart(2, '0')}:${(minutes % 60).toString().padStart(2, '0')}"

        fun minuteOfDay(epochMs: Long, zone: ZoneId): Int {
            val t = Instant.ofEpochMilli(epochMs).atZone(zone)
            return t.hour * 60 + t.minute
        }

        /** Is `minute` inside [from, to)? `from` after `to` means the window runs over midnight. */
        fun inWindow(minute: Int, from: Int, to: Int): Boolean = when {
            from == to -> false
            from < to -> minute in from until to
            else -> minute >= from || minute < to
        }

        /** The options a settings screen sent (`{"name": value}`); returns the names it refused. */
        fun applyAll(options: Options, values: JsonObject?): List<String> {
            val refused = ArrayList<String>()
            values?.forEach { (name, value) ->
                val text = (value as? JsonPrimitive)?.content
                if (text == null || !options.put(name, text)) refused += name
            }
            return refused
        }

        private val CLOCK = Regex("(\\d{1,2}):(\\d{2})")
    }
}
