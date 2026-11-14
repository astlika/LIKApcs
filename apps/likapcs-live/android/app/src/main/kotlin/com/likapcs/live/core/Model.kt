package com.likapcs.live.core

/**
 * The kinds of messages the owner can switch on and off. Each one is its own Android
 * notification channel, so sound and importance can also be set per kind in the system settings.
 */
enum class Category(val id: String) {
    /** Every completed sale: who sold, what, for how much. */
    SALES("sales"),

    /** Things an owner should look at: refunds, voids, price changes, free time, failed sign-ins. */
    ALERTS("alerts"),

    /** PC sessions, requests and orders from PCs, reservations. */
    PCS("pcs"),

    /** PCs switched on and off: the wake signal, a PC coming on or going off, shut down and restart. */
    POWER("power"),

    /** The drawer, expenses, purchases, debts and wallets. */
    MONEY("money"),

    /** Stock, products and prices. */
    STOCK("stock"),

    /** Staff sign-ins and accounts, customers. */
    PEOPLE("people"),

    /** Settings, backups, devices, updates. */
    SYSTEM("system"),

    /** The day as a whole: turnover marks, the evening summary, debts due today. */
    DAY("day"),

    /** The link between this phone and the server. */
    CONNECTION("connection");

    companion object {
        fun of(id: String?): Category? = entries.firstOrNull { it.id == id }
    }
}

/**
 * A finer switch inside a kind (1.1). A message that carries a topic is shown only while both its
 * kind and its topic are on. `default` false: the owner has to switch it on first.
 */
enum class Topic(val id: String, val category: Category, val default: Boolean = true) {
    /** "Ndiz" / "Ndiz të gjitha" in the Admin: the wake signal was sent. */
    PC_WAKE("pc.wake", Category.POWER),

    /** A PC really came on (its client connected) or went off. */
    PC_POWER("pc.power", Category.POWER),

    /** Shut down / restart sent from the Admin. */
    PC_COMMAND("pc.command", Category.POWER),

    /** A PC went off while a customer's session was running on it. */
    PC_DROPPED("pc.dropped", Category.ALERTS),

    /** A session was started or extended. */
    PC_SESSION("pc.session", Category.PCS),

    /** A session has only a few minutes left. */
    PC_ENDING("pc.ending", Category.PCS),

    /** A session ended: stopped by staff, or its time ran out. */
    PC_ENDED("pc.ended", Category.PCS),

    /** A reservation starts soon. */
    RESERVATION_SOON("reservation.soon", Category.PCS),

    /** A sale with a discount. */
    SALE_DISCOUNT("sale.discount", Category.ALERTS),

    /** A sale that lost money: sold under cost. */
    SALE_BELOW_COST("sale.below_cost", Category.ALERTS),

    /** A sale above the amount the owner set. */
    SALE_BIG("sale.big", Category.ALERTS, default = false),

    /** No sale for some hours during working hours. */
    SALES_IDLE("sales.idle", Category.ALERTS, default = false),

    /** The day's turnover passed the next mark (every 100 €, say). */
    TURNOVER_STEP("turnover.step", Category.DAY),

    /** The summary of the day at the hour the owner chose. */
    DAY_SUMMARY("day.summary", Category.DAY),

    /** Debts that are due today, once in the morning. */
    DEBT_DUE("debt.due", Category.DAY);

    companion object {
        fun of(id: String?): Topic? = entries.firstOrNull { it.id == id }
    }
}

/** One message for the owner: a system notification on the phone, a row in the activity list. */
data class Note(
    /** Stable identity, e.g. `sale:<id>` or `audit:<id>`: the same key never shows twice. */
    val key: String,
    val category: Category,
    val title: String,
    val text: String,
    /** When it happened (epoch milliseconds, the server's clock). */
    val at: Long,
    /** Which screen a tap opens: `sales`, `activity` or `settings`. */
    val tab: String = "activity",
    /** The finer switch this message belongs to, when it has one. */
    val topic: Topic? = null,
    /**
     * True: a message with this key may already be on the screen and this one takes its place
     * without ringing again ("U ndezën 3 PC" growing to "U ndezën 12 PC").
     */
    val update: Boolean = false,
    /** Set by the engine during the owner's quiet hours: shown, but without sound or vibration. */
    val silent: Boolean = false,
)

enum class Conn(val id: String) {
    /** Not signed in, or monitoring was stopped. */
    STOPPED("stopped"),
    CONNECTING("connecting"),
    ONLINE("online"),

    /** The server cannot be reached; the engine keeps trying. */
    OFFLINE("offline"),

    /** The server no longer accepts the sign-in: the owner has to sign in again. */
    UNAUTHORIZED("unauthorized"),
}

data class EngineState(
    val conn: Conn = Conn.STOPPED,
    /** When `conn` last changed (epoch ms). */
    val since: Long = 0,
    /** The last message received from the server (epoch ms), 0 when none yet. */
    val lastEventAt: Long = 0,
    val serverVersion: String? = null,
    /** Why the link is down, for the settings screen (never shown as an alarm). */
    val detail: String? = null,
)

/** Today's figures for the permanent notification: the day at a glance without opening the app. */
data class Summary(
    val date: String,
    val turnoverCents: Long,
    val salesCount: Int,
    val staff: List<StaffLine>,
    val drawerOpen: Boolean,
    val drawerExpectedCents: Long?,
    val at: Long,
) {
    data class StaffLine(val name: String, val salesCents: Long, val salesCount: Int, val onDuty: Boolean)
}

/** Key-value storage that survives restarts (Android: SharedPreferences). */
interface Store {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

/** What the engine needs from the device it runs on. */
interface Host {
    fun post(note: Note)
    fun cancel(key: String)
    fun summary(summary: Summary?)
    fun stateChanged(state: EngineState)

    /** Something changed on the server; `kind` is `sales`, `activity` or `all`. The open screen refreshes. */
    fun changed(kind: String)

    /** Keep the processor awake for up to `ms` while a message is handled. */
    fun stayAwake(ms: Long)

    /**
     * Wake the engine (`Engine.wake`) at this moment (epoch ms) even when the phone sleeps: a
     * session is about to end, the summary of the day is due. 0 takes the request back. One
     * request at a time: a new one replaces the one before.
     */
    fun wakeAt(epochMs: Long)
    fun log(line: String)
}
