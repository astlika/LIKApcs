package com.likapcs.live.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Names for the ids in the audit log: the PC of a session, a product, a customer, a staff member.
 * The audit log stores ids; the owner wants to read "PC 04" and "Coca-Cola". Best effort: when a
 * name cannot be read (no permission, no connection) the text is simply shorter.
 *
 * `fetch` does a GET on an API path and returns the parsed answer, or null on any failure.
 */
class Lookup(private val fetch: (path: String) -> JsonElement?) {
    private class Lru(private val max: Int) : LinkedHashMap<String, String>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, String>?): Boolean = size > max
    }

    /** What is worth saying about a session besides its PC. */
    class SessionInfo(val pc: String?, val who: String?, val priceCents: Long?)

    private class InfoLru(private val max: Int) : LinkedHashMap<String, SessionInfo>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, SessionInfo>?): Boolean = size > max
    }

    private val sessionInfo = InfoLru(200)
    private val users = Lru(300)
    private val sessions = Lru(500)
    private val products = Lru(500)
    private val customers = Lru(500)
    private val debts = Lru(300)
    private val orders = Lru(300)
    private val stations = HashMap<String, String>()
    private val expenseCategories = HashMap<String, Pair<String, String>>()
    private val logins = Lru(100)
    private var usersAt = 0L
    private var stationsAt = 0L
    private var expenseCategoriesAt = 0L

    @Synchronized
    fun clear() {
        listOf(users, sessions, products, customers, debts, orders).forEach { it.clear() }
        sessionInfo.clear()
        stations.clear()
        expenseCategories.clear()
        logins.clear()
        usersAt = 0
        stationsAt = 0
        expenseCategoriesAt = 0
    }

    /** `via`: `phone` or `web`, from the server's sign-in event. */
    @Synchronized
    fun rememberLogin(userId: String?, via: String?) {
        if (!userId.isNullOrEmpty() && !via.isNullOrEmpty()) logins[userId] = via
    }

    @Synchronized
    fun loginVia(userId: String?): String? = if (userId == null) null else logins[userId]

    /** The name of an expense category in the app's language ("cleaning" → "Pastrimi"). */
    @Synchronized
    fun expenseCategory(code: String?, english: Boolean): String? {
        if (code.isNullOrEmpty()) return null
        val now = System.currentTimeMillis()
        if (code !in expenseCategories && now - expenseCategoriesAt > REFRESH_MS) {
            expenseCategoriesAt = now
            val answer = fetch("/expenses/categories")
            for (c in (answer.asArr() ?: answer.asObj().arr("items")).objects()) {
                val key = c.str("code") ?: continue
                expenseCategories[key] = (c.str("nameSq") ?: key) to (c.str("nameEn") ?: key)
            }
        }
        val names = expenseCategories[code] ?: return code
        return if (english) names.second else names.first
    }

    @Synchronized
    fun rememberUser(id: String?, name: String?) {
        if (!id.isNullOrEmpty() && !name.isNullOrBlank()) users[id] = name
    }

    @Synchronized
    fun rememberSession(id: String?, pc: String?) {
        if (!id.isNullOrEmpty() && !pc.isNullOrBlank()) sessions[id] = pc
    }

    /** A PC seen in the live list (`GET /stations`, `station.changed`). */
    @Synchronized
    fun rememberStation(id: String?, code: String?) {
        if (!id.isNullOrEmpty() && !code.isNullOrBlank()) stations[id] = code
    }

    /** A session as the server last described it (`session.changed`, a `SessionSummary`). */
    @Synchronized
    fun rememberSession(s: JsonObject?) {
        val id = s.str("id") ?: return
        s.str("stationCode")?.takeIf { it.isNotBlank() }?.let { sessions[id] = it }
        sessionInfo[id] = info(s)
    }

    /** Who sat at a session's PC and what it cost; read from the server when not seen yet. */
    @Synchronized
    fun session(id: String?): SessionInfo? {
        if (id.isNullOrEmpty()) return null
        sessionInfo[id]?.let { return it }
        val s = try {
            fetch("/sessions/$id").asObj()
        } catch (e: Exception) {
            null
        } ?: return null
        if (s.str("id") == null) return null
        s.str("stationCode")?.takeIf { it.isNotBlank() }?.let { sessions[id] = it }
        return info(s).also { sessionInfo[id] = it }
    }

    private fun info(s: JsonObject?) = SessionInfo(
        pc = s.str("stationCode"),
        who = s.str("pcLabel") ?: s.str("customerName"),
        priceCents = s.long("finalPriceCents") ?: s.long("quotedPriceCents") ?: s.long("currentPriceCents"),
    )

    /** Full name of a staff member. The list is read once and again when someone unknown appears. */
    @Synchronized
    fun userName(id: String?): String? {
        if (id.isNullOrEmpty()) return null
        users[id]?.let { return it.ifEmpty { null } }
        val now = System.currentTimeMillis()
        if (now - usersAt > REFRESH_MS) {
            usersAt = now
            val answer = fetch("/users")
            val list = answer.asObj().arr("items") ?: answer.asArr()
            for (u in list.objects()) rememberUser(u.str("id"), u.str("fullName") ?: u.str("username"))
        }
        return users[id]?.ifEmpty { null }
    }

    /** The PC code ("PC 04") of a session. */
    @Synchronized
    fun sessionPc(id: String?): String? = cached(sessions, id) {
        fetch("/sessions/$id").asObj().str("stationCode")
    }

    @Synchronized
    fun stationCode(id: String?): String? {
        if (id.isNullOrEmpty()) return null
        stations[id]?.let { return it }
        val now = System.currentTimeMillis()
        if (now - stationsAt > REFRESH_MS) {
            stationsAt = now
            for (s in fetch("/stations").asArr().objects()) {
                val sid = s.str("id") ?: continue
                stations[sid] = s.str("code") ?: s.str("name") ?: continue
            }
        }
        return stations[id]
    }

    @Synchronized
    fun productName(id: String?): String? = cached(products, id) {
        fetch("/products/$id").asObj().str("name")
    }

    @Synchronized
    fun customerName(id: String?): String? = cached(customers, id) {
        val o = fetch("/customers/$id").asObj()
        o.str("name") ?: o.obj("customer").str("name")
    }

    /** The customer who owes a debt. */
    @Synchronized
    fun debtCustomer(id: String?): String? = cached(debts, id) {
        val o = fetch("/debts/$id").asObj()
        o.str("customerName") ?: o.obj("debt").str("customerName") ?: o.obj("customer").str("name")
    }

    /** The PC an order came from. */
    @Synchronized
    fun orderPc(id: String?): String? = cached(orders, id) {
        val o = fetch("/orders/$id").asObj()
        o.str("stationCode") ?: o.obj("order").str("stationCode")
    }

    /** A miss is remembered as "" so the same id is not asked again and again. */
    private fun cached(map: Lru, id: String?, load: () -> String?): String? {
        if (id.isNullOrEmpty()) return null
        map[id]?.let { return it.ifEmpty { null } }
        val value = try {
            load()
        } catch (e: Exception) {
            null
        }
        map[id] = value ?: ""
        return value
    }

    companion object {
        private const val REFRESH_MS = 60_000L
    }
}
