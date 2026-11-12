package com.likapcs.live.core

import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Wording and number formats for one language: Albanian (`sq`, the default) or English (`en`).
 * Money is euro cents from the server; it is only formatted here, never computed.
 */
class Texts(val lang: String, private val zone: ZoneId = ZoneId.systemDefault()) {
    val english: Boolean = lang == "en"

    fun t(sq: String, en: String): String = if (english) en else sq

    /** 1250 → "12.50 €" */
    fun money(cents: Long?): String {
        if (cents == null) return "—"
        val abs = Math.abs(cents)
        val sign = if (cents < 0) "-" else ""
        return "$sign${abs / 100}.${(abs % 100).toString().padStart(2, '0')} €"
    }

    /** +1.50 € / -1.50 € (0 has no sign). */
    fun signedMoney(cents: Long): String = if (cents > 0) "+${money(cents)}" else money(cents)

    /** 2000 → "2", 500 → "0.5" */
    fun qty(milli: Long): String {
        val abs = Math.abs(milli)
        val whole = abs / 1000
        val rest = (abs % 1000).toString().padStart(3, '0').trimEnd('0')
        val sign = if (milli < 0) "-" else ""
        return if (rest.isEmpty()) "$sign$whole" else "$sign$whole.$rest"
    }

    fun signedQty(milli: Long): String = if (milli > 0) "+${qty(milli)}" else qty(milli)

    /** 3900 s → "1 h 05 min", 2520 s → "42 min", 40 s → "nën 1 min" */
    fun duration(seconds: Long): String {
        if (seconds in 1..59) return t("nën 1 min", "under 1 min")
        val minutes = Math.max(0, seconds) / 60
        val h = minutes / 60
        val m = minutes % 60
        return if (h > 0) "$h h ${m.toString().padStart(2, '0')} min" else "$m min"
    }

    /** "14:05" in the phone's time zone; with the date when it is not today. */
    fun time(epochMs: Long, nowMs: Long = System.currentTimeMillis()): String {
        val at = Instant.ofEpochMilli(epochMs).atZone(zone)
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        return if (at.toLocalDate() == today) CLOCK.format(at) else DAY_CLOCK.format(at)
    }

    /** "2026-11-20" (or a full timestamp) → "20.11.2026" */
    fun date(iso: String?): String {
        if (iso.isNullOrBlank()) return "—"
        return try {
            DAY.format(LocalDate.parse(iso.take(10)))
        } catch (e: Exception) {
            iso
        }
    }

    companion object {
        private val CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
        private val DAY_CLOCK: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM HH:mm")
        private val DAY: DateTimeFormatter = DateTimeFormatter.ofPattern("dd.MM.yyyy")

        /** ISO timestamp → epoch milliseconds; null when it cannot be read. */
        fun parseTime(iso: String?): Long? {
            if (iso.isNullOrBlank()) return null
            return try {
                Instant.parse(iso).toEpochMilli()
            } catch (e: Exception) {
                try {
                    OffsetDateTime.parse(iso).toInstant().toEpochMilli()
                } catch (e2: Exception) {
                    null
                }
            }
        }

        fun isoTime(epochMs: Long): String = Instant.ofEpochMilli(epochMs).toString()
    }
}
