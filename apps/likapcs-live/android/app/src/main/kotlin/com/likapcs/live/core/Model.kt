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

    /** The drawer, expenses, purchases, debts and wallets. */
    MONEY("money"),

    /** Stock, products and prices. */
    STOCK("stock"),

    /** Staff sign-ins and accounts, customers. */
    PEOPLE("people"),

    /** Settings, backups, devices, updates. */
    SYSTEM("system"),

    /** The link between this phone and the server. */
    CONNECTION("connection");

    companion object {
        fun of(id: String?): Category? = entries.firstOrNull { it.id == id }
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
    fun log(line: String)
}
