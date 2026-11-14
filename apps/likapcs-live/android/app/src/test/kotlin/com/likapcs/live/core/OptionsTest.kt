package com.likapcs.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

class OptionsTest {
    private val utc = ZoneId.of("UTC")

    /** 2026-11-12 at the given UTC hour and minute. */
    private fun at(hour: Int, minute: Int = 0) = Texts.parseTime("2026-11-12T%02d:%02d:00Z".format(hour, minute))!!

    @Test
    fun everythingHasADefault() {
        val o = Options(MemoryStore())
        assertEquals(5, o.endingMinutes)
        assertEquals(5_000L, o.bigSaleCents)
        assertEquals(10_000L, o.stepCents)
        assertEquals(120, o.idleMinutes)
        assertEquals(23 * 60, o.summaryAt)
        assertEquals(9 * 60, o.debtsAt)
        assertFalse(o.quietOn)
        // Most topics are on from the start; the ones that could nag are not.
        assertTrue(o.on(Topic.PC_POWER))
        assertTrue(o.on(Topic.PC_WAKE))
        assertTrue(o.on(Topic.DAY_SUMMARY))
        assertFalse(o.on(Topic.SALE_BIG))
        assertFalse(o.on(Topic.SALES_IDLE))
    }

    @Test
    fun aTopicCanBeSwitchedOffAndOn() {
        val o = Options(MemoryStore())
        o.set(Topic.PC_POWER, false)
        assertFalse(o.on(Topic.PC_POWER))
        o.set(Topic.SALE_BIG, true)
        assertTrue(o.on(Topic.SALE_BIG))
        assertEquals("pc.power", Topic.of("pc.power")!!.id)
        assertNull(Topic.of("nope"))
    }

    @Test
    fun valuesOutOfRangeAreRefused() {
        val o = Options(MemoryStore())
        assertTrue(o.put(Options.ENDING_MINUTES, "10"))
        assertEquals(10, o.endingMinutes)
        assertFalse(o.put(Options.ENDING_MINUTES, "0"))
        assertFalse(o.put(Options.ENDING_MINUTES, "abc"))
        assertEquals(10, o.endingMinutes)
        assertTrue(o.put(Options.SUMMARY_AT, "7:05"))
        assertEquals(7 * 60 + 5, o.summaryAt)
        assertFalse(o.put(Options.SUMMARY_AT, "24:00"))
        assertFalse(o.put(Options.SUMMARY_AT, "12:60"))
        assertFalse(o.put("no.such.option", "1"))
        assertTrue(o.put(Options.QUIET_ON, "true"))
        assertTrue(o.quietOn)
        assertFalse(o.put(Options.QUIET_ON, "maybe"))
    }

    @Test
    fun aTimeOfDayIsReadAndWritten() {
        assertEquals(545, Options.parseClock("09:05"))
        assertEquals(0, Options.parseClock("0:00"))
        assertNull(Options.parseClock("9"))
        assertNull(Options.parseClock(null))
        assertEquals("09:05", Options.formatClock(545))
        assertEquals("23:59", Options.formatClock(23 * 60 + 59))
    }

    @Test
    fun quietHoursMayRunOverMidnight() {
        val o = Options(MemoryStore())
        o.put(Options.QUIET_FROM, "23:30")
        o.put(Options.QUIET_TO, "08:00")
        // Switched off: never quiet.
        assertFalse(o.quietAt(at(2), utc))
        o.put(Options.QUIET_ON, "true")
        assertTrue(o.quietAt(at(23, 30), utc))
        assertTrue(o.quietAt(at(2), utc))
        assertTrue(o.quietAt(at(7, 59), utc))
        assertFalse(o.quietAt(at(8), utc))
        assertFalse(o.quietAt(at(23, 29), utc))
        // The hours are the phone's local time: 07:30 UTC is 08:30 in Kosovo, after the quiet hours.
        assertTrue(o.quietAt(at(7, 30), utc))
        assertFalse(o.quietAt(at(7, 30), ZoneId.of("Europe/Belgrade")))
        // A window inside one day.
        o.put(Options.QUIET_FROM, "13:00")
        o.put(Options.QUIET_TO, "15:00")
        assertTrue(o.quietAt(at(14), utc))
        assertFalse(o.quietAt(at(15), utc))
        // From and to the same: no window at all.
        o.put(Options.QUIET_TO, "13:00")
        assertFalse(o.quietAt(at(13), utc))
    }

    @Test
    fun theSettingsScreenGetsEveryValue() {
        val o = Options(MemoryStore())
        val json = o.toJson()
        assertEquals("5", json.str(Options.ENDING_MINUTES))
        assertEquals("23:00", json.str(Options.SUMMARY_AT))
        assertEquals(false, json.bool(Options.QUIET_ON))
        assertEquals(Topic.entries.size, o.topicsJson().size)
        val refused = Options.applyAll(o, parseObject("""{"ending.minutes":3,"summary.at":"22:30","big.cents":"x","nope":1}"""))
        assertEquals(listOf("big.cents", "nope"), refused)
        assertEquals(3, o.endingMinutes)
        assertEquals(22 * 60 + 30, o.summaryAt)
    }
}
