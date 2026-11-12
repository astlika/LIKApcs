package com.likapcs.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

class TextsTest {
    private val zone = ZoneId.of("Europe/Belgrade")
    private val sq = Texts("sq", zone)
    private val en = Texts("en", zone)

    @Test
    fun moneyIsEuroCentsWithTwoDecimals() {
        assertEquals("0.00 €", sq.money(0))
        assertEquals("0.05 €", sq.money(5))
        assertEquals("12.50 €", sq.money(1250))
        assertEquals("1234.56 €", sq.money(123456))
        assertEquals("-1.50 €", sq.money(-150))
        assertEquals("—", sq.money(null))
        assertEquals("+1.50 €", sq.signedMoney(150))
        assertEquals("-1.50 €", sq.signedMoney(-150))
        assertEquals("0.00 €", sq.signedMoney(0))
    }

    @Test
    fun quantitiesDropTrailingZeros() {
        assertEquals("1", sq.qty(1000))
        assertEquals("2", sq.qty(2000))
        assertEquals("0.5", sq.qty(500))
        assertEquals("1.25", sq.qty(1250))
        assertEquals("0.333", sq.qty(333))
        assertEquals("-3", sq.qty(-3000))
        assertEquals("+10", sq.signedQty(10000))
        assertEquals("-3", sq.signedQty(-3000))
    }

    @Test
    fun durations() {
        assertEquals("42 min", sq.duration(2520))
        assertEquals("1 h 05 min", sq.duration(3900))
        assertEquals("0 min", sq.duration(-10))
    }

    @Test
    fun timesAreShownInThePhonesZone() {
        val now = Texts.parseTime("2026-11-12T20:00:00Z")!!
        // 17:05 UTC is 18:05 in Kosovo in winter.
        assertEquals("18:05", sq.time(Texts.parseTime("2026-11-12T17:05:00Z")!!, now))
        // Not today: the date comes with it.
        assertEquals("11.11 23:30", sq.time(Texts.parseTime("2026-11-11T22:30:00Z")!!, now))
        assertEquals("20.11.2026", sq.date("2026-11-20"))
        assertEquals("20.11.2026", sq.date("2026-11-20T10:00:00.000Z"))
        assertEquals("—", sq.date(null))
    }

    @Test
    fun serverTimestampsAreRead() {
        assertEquals(1794507904977L, Texts.parseTime("2026-11-12T18:25:04.977Z"))
        assertEquals(Texts.parseTime("2026-11-12T18:25:04Z"), Texts.parseTime("2026-11-12T19:25:04+01:00"))
        assertNull(Texts.parseTime("yesterday"))
        assertNull(Texts.parseTime(""))
        assertNull(Texts.parseTime(null))
        assertEquals("2026-11-12T18:25:04.977Z", Texts.isoTime(1794507904977L))
    }

    @Test
    fun twoLanguages() {
        assertEquals("shitje", sq.t("shitje", "sales"))
        assertEquals("sales", en.t("shitje", "sales"))
        // Anything that is not English is Albanian, the default.
        assertEquals("shitje", Texts("de", zone).t("shitje", "sales"))
    }
}
