package com.likapcs.live.core

/**
 * Being on time with alarms the phone does not promise to keep.
 *
 * Android delivers an "inexact" alarm no earlier than asked, but may hold it back by three
 * quarters of the time it was set ahead (an hour at most) to deliver it together with others.
 * So a wait is taken in steps: each alarm is set early enough that even its latest delivery is
 * not past the moment, and each delivery sets the next, until the moment is so close that the
 * engine waits the rest awake.
 */
object WakePlan {
    /** This close to the moment the engine takes over (it waits up to 40 s awake by itself). */
    const val HANDOVER_MS = 30_000L
    private const val HOUR_MS = 60 * 60_000L

    /** Where the next alarm is set, at `now`, on the way to `target` (both epoch ms). */
    fun step(now: Long, target: Long): Long {
        val wait = target - now
        if (wait <= HANDOVER_MS) return target
        // t + 3/4 (t − now) ≤ target  ⇔  t ≤ now + 4/7 (target − now); and never more than the
        // phone's hour before the moment.
        return maxOf(now + wait * 4 / 7, target - HOUR_MS)
    }

    /** True when an alarm that went off at `now` was only a step: the next one has to be set. */
    fun early(now: Long, target: Long): Boolean = target - now > HANDOVER_MS
}
