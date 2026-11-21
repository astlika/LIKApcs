package com.likapcs.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The steps towards a moment, checked against the latest delivery Android allows itself. */
class WakePlanTest {
    private val minute = 60_000L
    private val hour = 60 * minute

    /** The latest an inexact alarm set at `now` for `at` may go off (Android's own rule). */
    private fun latest(now: Long, at: Long): Long {
        val ahead = at - now
        return at + minOf(if (ahead < 10_000) 0 else ahead * 3 / 4, hour)
    }

    @Test
    fun evenTheLatestDeliveryIsNotPastTheMoment() {
        for (wait in listOf(31_000L, 45_000, minute, 5 * minute, 55 * minute, hour, 2 * hour, 14 * hour, 30 * hour)) {
            val step = WakePlan.step(0, wait)
            assertTrue("a step is ahead of now ($wait)", step > 0)
            assertTrue("a step is before the moment ($wait)", step < wait)
            assertTrue("late by the full allowance, still in time ($wait)", latest(0, step) <= wait)
        }
    }

    @Test
    fun aMomentThisCloseIsSetAsItIs() {
        assertEquals(30_000L, WakePlan.step(0, 30_000))
        assertEquals(5_000L, WakePlan.step(0, 5_000))
        assertFalse(WakePlan.early(0, 30_000))
        assertFalse(WakePlan.early(40_000, 30_000))
        assertTrue(WakePlan.early(0, 30_001))
    }

    @Test
    fun theStepsArriveWhetherThePhoneIsPromptOrLate() {
        for (wait in listOf(5 * minute, 55 * minute, 14 * hour)) {
            for (late in listOf(false, true)) {
                var now = 0L
                var alarms = 0
                while (WakePlan.early(now, wait)) {
                    val at = WakePlan.step(now, wait)
                    now = if (late) latest(now, at) else at
                    alarms++
                    assertTrue("never past the moment", now <= wait)
                    assertTrue("it ends ($wait, late=$late)", alarms <= 12)
                }
                // What is left is waited for awake by the engine.
                assertTrue(wait - now in 0..WakePlan.HANDOVER_MS)
            }
        }
    }

    @Test
    fun anHourSessionTakesAHandfulOfAlarms() {
        // "Five minutes left" of a one-hour session: 55 minutes ahead, the phone always prompt.
        var now = 0L
        var alarms = 0
        while (WakePlan.early(now, 55 * minute)) {
            now = WakePlan.step(now, 55 * minute)
            alarms++
        }
        assertEquals(6, alarms)
    }
}
