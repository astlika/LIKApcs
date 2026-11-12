package com.likapcs.live.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.io.IOException
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Names of the stored values. */
object Keys {
    const val SERVER = "server"
    const val TOKEN = "token"
    const val USER = "user"
    const val EXPIRES_AT = "expiresAt"
    const val BUSINESS = "business"
    const val LANG = "lang"
    const val LAST_USERNAME = "last.username"
    const val LAST_EMAIL = "last.email"

    /** The server's clock when this phone signed in (epoch ms): nothing older is ever announced. */
    const val BASELINE = "baseline"
    const val SALES_SEEN = "sales.seen"
    const val AUDIT_FLOOR = "audit.floor"
    const val AUDIT_SEEN = "audit.seen"
    const val AUDIT_AT = "audit.at"
    const val SUMMARY = "summary"

    fun category(c: Category) = "cat.${c.id}"
}

/**
 * The live link to the LIKApcs server. It keeps one WebSocket to `/ws/admin` open, and turns what
 * the server reports into notes for the owner:
 *
 *  - every completed sale (`live.sale`, and the day's feed as a safety net after a gap);
 *  - every row the server writes to its audit log (who did what), read after each server event,
 *    once a minute, and on every wake-up;
 *  - low stock.
 *
 * Nothing is written to the server and nothing is computed: the engine only reads.
 * It reconnects by itself, and after a gap it catches up from where it stopped (the cursors are
 * stored), so a sale made while the phone had no connection is still announced.
 *
 * All work runs on one thread; public methods may be called from any thread.
 */
class Engine(
    private val store: Store,
    private val host: Host,
    private val http: Http,
    private val userAgent: String,
    /** How often the audit log is read when no server event asks for it sooner. */
    private val pollMs: Long = POLL_MS,
    /** How long the link must be down before the owner is told. */
    private val outageMs: Long = OUTAGE_MS,
) {
    private val exec: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "likalive-engine").apply { isDaemon = true }
    }

    val lookup = Lookup { path -> get(path)?.takeIf { it.ok }?.let { parseJson(it.body) } }
    val describer = Describer(lookup) { texts() }

    @Volatile private var current = EngineState()
    @Volatile private var lastEventAt = 0L
    @Volatile private var cachedTexts: Texts? = null

    private var running = false
    private var socket: WsClient? = null
    private var generation = 0
    private var attempt = 0
    private var retry: ScheduledFuture<*>? = null
    private var pinger: ScheduledFuture<*>? = null
    private var poller: ScheduledFuture<*>? = null
    private var welcomeTimer: ScheduledFuture<*>? = null
    private var snapshotTask: ScheduledFuture<*>? = null
    private var auditTask: ScheduledFuture<*>? = null
    private var outageTask: ScheduledFuture<*>? = null
    private var outageNoted = false
    private var lastPongAt = 0L
    private var lastAuditPollAt = 0L

    /** A wake-up asked whether the link is alive: its answer starts the catch-up reads. */
    private var catchUpOnPong = false

    private var loaded = false
    private val seenSales = LinkedHashSet<String>()
    private val seenAudit = LinkedHashSet<Long>()

    /** Sales announced a moment ago: an audit row that came with one of them stays quiet. */
    private class RecentSale(val cashier: String, val at: Long, val totalCents: Long, val lineCents: List<Long>)

    private val recentSales = ArrayDeque<RecentSale>()

    /** Last known status of each session, for the texts used when the audit log cannot be read. */
    private val sessionStatus = HashMap<String, String>()

    // ─── Public ─────────────────────────────────────────────────────────────────────────────

    fun state(): EngineState = current.copy(lastEventAt = lastEventAt)

    fun texts(): Texts {
        val lang = store.get(Keys.LANG) ?: "sq"
        cachedTexts?.let { if (it.lang == lang) return it }
        return Texts(lang).also { cachedTexts = it }
    }

    fun signedIn(): Boolean = store.get(Keys.TOKEN) != null && store.get(Keys.SERVER) != null

    fun can(permission: String): Boolean =
        parseObject(store.get(Keys.USER)).arr("permissions")?.any { (it as? JsonPrimitive)?.content == permission } == true

    fun enabled(category: Category): Boolean = store.get(Keys.category(category)) != "0"

    /** Starts (or keeps) the link. Safe to call again and again. */
    fun start() = exec.execute {
        running = true
        if (current.conn != Conn.CONNECTING && current.conn != Conn.ONLINE) {
            attempt = 0
            connect()
        }
    }

    fun stop() = exec.execute {
        running = false
        teardown()
        setConn(Conn.STOPPED, null)
    }

    /**
     * Called when the phone wakes the app (alarm), when the network comes back, and when the app
     * is opened: check the link now and read anything missed.
     */
    fun wake(reason: String) = exec.execute {
        if (!running) return@execute
        host.stayAwake(if (current.conn == Conn.ONLINE) PONG_WAIT_MS + 2_000 else 12_000)
        when (current.conn) {
            Conn.ONLINE -> {
                // Is the link still alive? Only its answer tells. What the server did not push
                // is read after that answer (see `server.pong`): on a dead link those reads
                // would only block this thread until they time out.
                val sentAt = System.currentTimeMillis()
                catchUpOnPong = true
                ping()
                exec.schedule({
                    if (current.conn == Conn.ONLINE && lastPongAt < sentAt) {
                        host.log("no answer to ping after $reason: reconnecting")
                        socket?.abort()
                    }
                }, PONG_WAIT_MS, TimeUnit.MILLISECONDS)
            }
            Conn.OFFLINE -> {
                // The timers stand still while the phone sleeps: the clock decides here.
                if (!outageNoted && System.currentTimeMillis() - current.since >= outageMs) noteOutage(current.since)
                // A new network or an opened app is a reason to try eagerly again. The periodic
                // alarm is not: while the server stays away it makes one try and lets the phone sleep.
                if (reason != WAKE_ALARM) attempt = 0
                connect()
            }
            else -> Unit
        }
    }

    /** How long the link has been down (ms); 0 while it is up or stopped. */
    fun offlineFor(): Long {
        val s = current
        return if (s.conn == Conn.OFFLINE) System.currentTimeMillis() - s.since else 0
    }

    /**
     * A new sign-in: forget everything about the previous one. Only what happens after
     * `baselineMs` (the server's clock at sign-in) is announced.
     */
    fun resetForSignIn(baselineMs: Long) = exec.execute {
        teardown()
        seenSales.clear()
        seenAudit.clear()
        recentSales.clear()
        sessionStatus.clear()
        lookup.clear()
        loaded = true
        for (key in listOf(Keys.SALES_SEEN, Keys.AUDIT_FLOOR, Keys.AUDIT_SEEN, Keys.AUDIT_AT, Keys.SUMMARY)) store.put(key, null)
        store.put(Keys.BASELINE, baselineMs.toString())
        setConn(Conn.STOPPED, null)
    }

    /** The language or the categories changed: show the day's figures again in the new wording. */
    fun optionsChanged() = exec.execute {
        cachedTexts = null
        parseObject(store.get(Keys.SUMMARY))?.let { host.summary(summaryFromJson(it)) }
    }

    /** GET on an API path with the stored sign-in. Null: the server could not be reached. */
    fun get(path: String): HttpResult? {
        val server = store.get(Keys.SERVER) ?: return null
        val token = store.get(Keys.TOKEN) ?: return null
        return try {
            // The server is on the shop's own network and answers in milliseconds: a read that
            // takes this long has failed, and waiting longer would only hold everything else up.
            val result = http.request("GET", "$server/api/v1$path", token, connectTimeoutMs = 5_000, readTimeoutMs = 10_000)
            if (result.status == 401) exec.execute { unauthorized() }
            result
        } catch (e: IOException) {
            // No answer while the live link looks fine: the link is probably dead too (a network
            // that died without a word). Drop it, so the engine reconnects and catches up.
            exec.execute {
                if (current.conn == Conn.ONLINE) {
                    host.log("a read failed (${e.message}): reconnecting")
                    socket?.abort()
                }
            }
            null
        }
    }

    // ─── Connection ─────────────────────────────────────────────────────────────────────────

    private fun connect() {
        retry?.cancel(false)
        retry = null
        if (!running) return
        val server = store.get(Keys.SERVER)
        val token = store.get(Keys.TOKEN)
        if (server == null || token == null) {
            setConn(Conn.STOPPED, null)
            return
        }
        load()
        val gen = ++generation
        socket?.abort()
        // While retrying after a failure the state stays "offline": no flicker on the screen.
        if (current.conn != Conn.OFFLINE) setConn(Conn.CONNECTING, null)
        host.stayAwake(CONNECT_TIMEOUT_MS + 4_000L)
        val url = (if (server.startsWith("https")) "wss" + server.substring(5) else "ws" + server.substring(4)) + "/ws/admin"
        val client = WsClient(
            URI(url),
            userAgent,
            object : WsClient.Listener {
                override fun onOpen() {
                    exec.execute {
                        if (gen == generation) {
                            socket?.send(buildJsonObject {
                                put("type", "admin.hello")
                                put("token", token)
                                put("protocolVersion", PROTOCOL_VERSION)
                            }.toString())
                        }
                    }
                }

                override fun onText(text: String) {
                    // The answer to a ping needs no work: the phone is not kept awake for it.
                    val pong = text.length < 160 && text.contains("\"server.pong\"")
                    if (!pong) host.stayAwake(15_000)
                    exec.execute { if (gen == generation) onMessage(text) }
                }

                override fun onEnd(code: Int, reason: String, status: Int, error: Exception?) {
                    // Awake until the engine has decided what to do next (see onEnd below).
                    host.stayAwake(5_000)
                    exec.execute { if (gen == generation) onEnd(code, reason, status) }
                }
            },
            connectTimeoutMs = CONNECT_TIMEOUT_MS,
            readTimeoutMs = READ_TIMEOUT_MS,
        )
        socket = client
        client.start()
        welcomeTimer?.cancel(false)
        welcomeTimer = exec.schedule({
            if (gen == generation && current.conn != Conn.ONLINE) {
                host.log("no welcome from the server: closing")
                client.abort()
            }
        }, WELCOME_WAIT_MS, TimeUnit.MILLISECONDS)
    }

    private fun teardown() {
        generation++
        retry?.cancel(false)
        pinger?.cancel(false)
        poller?.cancel(false)
        welcomeTimer?.cancel(false)
        snapshotTask?.cancel(false)
        auditTask?.cancel(false)
        outageTask?.cancel(false)
        retry = null
        pinger = null
        poller = null
        welcomeTimer = null
        snapshotTask = null
        auditTask = null
        outageTask = null
        socket?.abort()
        socket = null
    }

    private fun onMessage(text: String) {
        val message = parseObject(text) ?: return
        lastEventAt = System.currentTimeMillis()
        when (message.str("type")) {
            "server.welcome" -> onWelcome(message)
            "server.pong" -> {
                lastPongAt = System.currentTimeMillis()
                if (catchUpOnPong) {
                    catchUpOnPong = false
                    scheduleSnapshot(0)
                    scheduleAudit(200, urgent = true)
                }
            }
            "server.event" -> onEvent(message.str("event") ?: "", message.obj("payload"))
            "server.error" -> host.log("server error: ${message.str("code")} ${message.str("message")}")
        }
    }

    private fun onWelcome(message: JsonObject) {
        welcomeTimer?.cancel(false)
        attempt = 0
        catchUpOnPong = false
        lastPongAt = System.currentTimeMillis()
        outageTask?.cancel(false)
        if (outageNoted) {
            host.cancel(OUTAGE_KEY)
            outageNoted = false
        }
        current = current.copy(serverVersion = message.str("serverVersion"))
        setConn(Conn.ONLINE, null)
        pinger?.cancel(false)
        pinger = exec.scheduleWithFixedDelay({ ping() }, PING_MS, PING_MS, TimeUnit.MILLISECONDS)
        poller?.cancel(false)
        poller = exec.scheduleWithFixedDelay({ scheduleAudit(0, urgent = true) }, pollMs, pollMs, TimeUnit.MILLISECONDS)
        refreshMe()
        // Sales first: an audit row that came with a sale must find that sale already announced.
        refreshSnapshot()
        pollAudit()
        host.changed("all")
    }

    private fun ping() {
        val s = socket ?: return
        if (!s.send("""{"type":"admin.ping"}""")) s.abort()
    }

    private fun onEnd(code: Int, reason: String, status: Int) {
        pinger?.cancel(false)
        poller?.cancel(false)
        welcomeTimer?.cancel(false)
        socket = null
        if (code == CLOSE_UNAUTHORIZED) {
            unauthorized()
            return
        }
        if (!running) {
            setConn(Conn.STOPPED, null)
            return
        }
        val detail = when {
            code == CLOSE_INCOMPATIBLE -> "incompatible"
            status == 403 -> "forbidden"
            status in 400..599 -> "http_$status"
            code == 0 -> "unreachable"
            else -> "closed_$code"
        }
        host.log("link ended: code=$code status=$status $reason")
        if (current.conn != Conn.OFFLINE) {
            setConn(Conn.OFFLINE, detail)
            outageTask?.cancel(false)
            val since = current.since
            outageTask = exec.schedule({ noteOutage(since) }, outageMs, TimeUnit.MILLISECONDS)
        } else if (current.detail != detail) {
            current = current.copy(detail = detail)
            host.stateChanged(state())
        }
        val delay = if (code == CLOSE_INCOMPATIBLE) 10 * 60_000L else BACKOFF_MS[minOf(attempt, BACKOFF_MS.size - 1)]
        attempt++
        retry?.cancel(false)
        retry = exec.schedule({ connect() }, delay, TimeUnit.MILLISECONDS)
        // The first tries follow each other quickly and the phone stays awake for them. After
        // that it may sleep: its timers stand still then, and the next try comes with the next
        // wake-up (the app's alarm, or a change of network).
        if (delay <= QUICK_RETRY_MS) host.stayAwake(delay + 3_000)
    }

    private fun noteOutage(since: Long) {
        if (!running || current.conn != Conn.OFFLINE || outageNoted) return
        val x = texts()
        outageNoted = true
        post(
            Note(
                key = OUTAGE_KEY,
                category = Category.CONNECTION,
                title = x.t("Pa lidhje me serverin", "No connection to the server"),
                text = x.t(
                    "Njoftimet nuk po vijnë që nga ora ${x.time(since)}. Kontrolloni internetin ose Tailscale; sapo të kthehet lidhja, vijnë edhe ato që munguan.",
                    "No notifications since ${x.time(since)}. Check the internet or Tailscale; when the link is back, the missed ones arrive too.",
                ),
                at = since,
                tab = "settings",
            ),
        )
    }

    /** The server refuses the sign-in (expired after its 30 days, or signed out from the Admin). */
    private fun unauthorized() {
        if (store.get(Keys.TOKEN) == null) return
        teardown()
        store.put(Keys.TOKEN, null)
        store.put(Keys.SUMMARY, null)
        host.summary(null)
        setConn(Conn.UNAUTHORIZED, "unauthorized")
        val x = texts()
        host.post(
            Note(
                key = "conn:signin",
                category = Category.CONNECTION,
                title = x.t("Hyni përsëri në likalivepcs", "Sign in to likalivepcs again"),
                text = x.t(
                    "Kyçja në server ka skaduar. Hapni aplikacionin dhe hyni përsëri, që njoftimet të vazhdojnë.",
                    "The sign-in has expired. Open the app and sign in again to keep the notifications coming.",
                ),
                at = System.currentTimeMillis(),
                tab = "settings",
            ),
        )
    }

    private fun setConn(conn: Conn, detail: String?) {
        if (current.conn == conn && current.detail == detail) return
        current = current.copy(conn = conn, since = System.currentTimeMillis(), detail = detail)
        host.stateChanged(state())
    }

    // ─── Events ─────────────────────────────────────────────────────────────────────────────

    private fun onEvent(event: String, payload: JsonObject?) {
        when (event) {
            "live.sale" -> {
                payload?.let { announceSale(it) }
                scheduleSnapshot(700)
                scheduleAudit(900, urgent = true)
                host.changed("sales")
            }
            "reports.changed" -> {
                scheduleSnapshot(900)
                scheduleAudit(600, urgent = true)
                host.changed("sales")
            }
            "session.changed" -> {
                lookup.rememberSession(payload.str("id"), payload.str("stationCode"))
                if (!can(AUDIT_VIEW)) payload?.let { sessionFallback(it) }
                scheduleAudit(600, urgent = true)
                host.changed("activity")
            }
            "staff.login" -> {
                lookup.rememberUser(payload.str("userId"), payload.str("fullName"))
                lookup.rememberLogin(payload.str("userId"), payload.str("via"))
                if (!can(AUDIT_VIEW) && payload != null) {
                    val x = texts()
                    val name = payload.str("fullName") ?: payload.str("username") ?: "?"
                    post(Note("login:${payload.str("userId")}:${payload.str("at")}", Category.PEOPLE,
                        x.t("$name u kyç", "$name signed in"),
                        if (payload.str("via") == "phone") x.t("nga telefoni", "from the phone") else x.t("nga kompjuteri", "from the computer"),
                        Texts.parseTime(payload.str("at")) ?: System.currentTimeMillis()))
                }
                scheduleAudit(500, urgent = true)
            }
            "debt.changed" -> {
                if (!can(AUDIT_VIEW) && payload != null) {
                    val x = texts()
                    val amount = x.money(payload.long("amountCents"))
                    val title = when (payload.str("action")) {
                        "paid" -> x.t("Pagesë borxhi $amount", "Debt payment $amount")
                        "rescheduled" -> x.t("Afati i borxhit u shty", "Debt due date moved")
                        else -> x.t("Borxh i falur", "Debt written off")
                    }
                    post(Note("debt:${payload.str("at")}", if (payload.str("action") == "written_off") Category.ALERTS else Category.MONEY,
                        title, payload.str("customerName") ?: "", Texts.parseTime(payload.str("at")) ?: System.currentTimeMillis()))
                }
                scheduleSnapshot(900)
                scheduleAudit(600, urgent = true)
            }
            "stock.low" -> payload?.let { p -> describer.stockLow(p)?.let { post(it) } }
            "system.restored" -> {
                // The database was replaced by a backup: the audit ids start over from that copy.
                store.put(Keys.AUDIT_FLOOR, null)
                store.put(Keys.AUDIT_SEEN, null)
                store.put(Keys.AUDIT_AT, null)
                seenAudit.clear()
                lookup.clear()
                val x = texts()
                post(Note("restored:${System.currentTimeMillis()}", Category.ALERTS,
                    x.t("Të dhënat u rikthyen nga një kopje rezervë", "Data restored from a backup"),
                    x.t("Serveri LIKApcs u kthye në një gjendje të mëparshme.", "The LIKApcs server went back to an earlier state."),
                    System.currentTimeMillis()))
                scheduleSnapshot(1500)
                scheduleAudit(1500, urgent = true)
                host.changed("all")
            }
            "permissions.changed" -> {
                refreshMe()
                scheduleAudit(800, urgent = true)
            }
            // Requests, orders, reservations, PCs, devices: the audit log tells what happened.
            else -> {
                scheduleAudit(800, urgent = event != "station.changed" && event != "device.changed")
                if (event != "station.changed") host.changed("activity")
            }
        }
    }

    /** Session changes in plain words, for an account that may not read the audit log. */
    private fun sessionFallback(s: JsonObject) {
        val id = s.str("id") ?: return
        val status = s.str("status") ?: return
        val previous = sessionStatus.put(id, status)
        if (sessionStatus.size > 600) sessionStatus.clear()
        if (previous == status) return
        val startedAt = Texts.parseTime(s.str("startedAt")) ?: 0
        // The first sight of a session that has been running for a while is not a new start.
        if (previous == null && status == "active" && System.currentTimeMillis() - startedAt > 60_000) return
        val x = texts()
        val pc = s.str("stationCode") ?: "PC"
        val who = s.str("pcLabel") ?: s.str("customerName")
        val title = when (status) {
            "active" -> if (previous == "paused") x.t("$pc: sesioni vazhdoi", "$pc: session resumed") else x.t("$pc: sesion i ri", "$pc: session started")
            "paused" -> x.t("$pc: sesioni u pauzua", "$pc: session paused")
            "completed" -> x.t("$pc: sesioni mbaroi", "$pc: session ended")
            "cancelled" -> x.t("$pc: sesioni u anulua", "$pc: session cancelled")
            "expired" -> x.t("$pc: koha mbaroi", "$pc: time is up")
            else -> return
        }
        val text = when (status) {
            "completed" -> x.money(s.long("finalPriceCents") ?: s.long("currentPriceCents"))
            else -> who ?: ""
        }
        post(Note("session:$id:$status", if (status == "cancelled") Category.ALERTS else Category.PCS, title, text, System.currentTimeMillis()))
    }

    // ─── Sales ──────────────────────────────────────────────────────────────────────────────

    private fun announceSale(sale: JsonObject) {
        val id = sale.str("saleId") ?: return
        if (!seenSales.add(id)) return
        trim(seenSales, 300)
        saveSeenSales()
        val baseline = store.get(Keys.BASELINE)?.toLongOrNull() ?: 0
        val at = Texts.parseTime(sale.str("completedAt")) ?: System.currentTimeMillis()
        if (at < baseline) return
        // A session that ended with nothing to pay is not a sale worth a message.
        if ((sale.long("totalCents") ?: 0) == 0L) return
        val note = describer.sale(sale) ?: return
        if (enabled(Category.SALES)) {
            recentSales.addLast(
                RecentSale(
                    cashier = sale.str("cashierName") ?: "",
                    at = at,
                    totalCents = sale.long("totalCents") ?: 0,
                    lineCents = sale.arr("items").objects().mapNotNull { it.long("lineTotalCents") },
                ),
            )
            while (recentSales.size > 60) recentSales.removeFirst()
            host.post(note)
        }
    }

    private fun scheduleSnapshot(delayMs: Long) {
        if (snapshotTask?.isDone == false) return
        snapshotTask = exec.schedule({ refreshSnapshot() }, delayMs, TimeUnit.MILLISECONDS)
    }

    /** Today's figures (for the permanent notification) and the sales the socket did not deliver. */
    private fun refreshSnapshot() {
        val result = get("/live/snapshot") ?: return
        if (!result.ok) return
        val snap = result.json() ?: return
        for (s in snap.arr("staff").objects()) lookup.rememberUser(s.str("userId"), s.str("name"))

        val feed = snap.arr("feed").objects()
        val fresh = feed
            .filter { it.str("saleId")?.let { id -> id !in seenSales } == true }
            .sortedBy { Texts.parseTime(it.str("completedAt")) ?: 0 }
        if (fresh.size > FLOOD) {
            // A long gap: the newest few one by one, the rest as one line.
            val older = fresh.dropLast(FLOOD_KEEP)
            val baseline = store.get(Keys.BASELINE)?.toLongOrNull() ?: 0
            val missed = older.filter { (Texts.parseTime(it.str("completedAt")) ?: 0) >= baseline }
            for (s in older) s.str("saleId")?.let { seenSales.add(it) }
            if (missed.isNotEmpty()) {
                val x = texts()
                // The server lists the newest sales of the day only. When every one of them is
                // new, there were more than these: the line says "at least" and names no sum.
                val more = feed.size >= FEED_SIZE && fresh.size == feed.size && missed.size == older.size
                val title = if (more) {
                    x.t("Të paktën ${missed.size} shitje të tjera ndërkohë", "At least ${missed.size} more sales meanwhile")
                } else {
                    val sum = x.money(missed.sumOf { it.long("totalCents") ?: 0 })
                    x.t("Edhe ${missed.size} shitje ndërkohë · $sum", "${missed.size} more sales meanwhile · $sum")
                }
                post(Note("sales-more:${System.currentTimeMillis()}", Category.SALES, title,
                    x.t("Hapni aplikacionin për t'i parë të gjitha.", "Open the app to see them all."),
                    System.currentTimeMillis(), tab = "sales"))
            }
            for (s in fresh.takeLast(FLOOD_KEEP)) announceSale(s)
        } else {
            for (s in fresh) announceSale(s)
        }

        val summary = summaryJson(snap)
        store.put(Keys.SUMMARY, summary.toString())
        host.summary(summaryFromJson(summary))
    }

    private fun summaryJson(snap: JsonObject): JsonObject = buildJsonObject {
        val totals = snap.obj("totals")
        val drawer = snap.obj("drawer")
        put("date", snap.str("date") ?: "")
        put("turnoverCents", totals.long("turnoverCents") ?: 0)
        put("salesCount", totals.long("salesCount") ?: 0)
        put("drawerOpen", drawer.bool("open") == true)
        drawer.long("expectedCents")?.let { put("drawerExpectedCents", it) }
        put("at", System.currentTimeMillis())
        putJsonArray("staff") {
            snap.arr("staff").objects()
                .filter { (it.long("salesCount") ?: 0) > 0 || it.bool("onDuty") == true }
                .sortedByDescending { it.long("salesCents") ?: 0 }
                .forEach { s ->
                    add(buildJsonObject {
                        put("name", s.str("name") ?: "?")
                        put("salesCents", s.long("salesCents") ?: 0)
                        put("salesCount", s.long("salesCount") ?: 0)
                        put("onDuty", s.bool("onDuty") == true)
                    })
                }
        }
    }

    private fun summaryFromJson(o: JsonObject): Summary = Summary(
        date = o.str("date") ?: "",
        turnoverCents = o.long("turnoverCents") ?: 0,
        salesCount = (o.long("salesCount") ?: 0).toInt(),
        staff = o.arr("staff").objects().map {
            Summary.StaffLine(it.str("name") ?: "?", it.long("salesCents") ?: 0, (it.long("salesCount") ?: 0).toInt(), it.bool("onDuty") == true)
        },
        drawerOpen = o.bool("drawerOpen") == true,
        drawerExpectedCents = o.long("drawerExpectedCents"),
        at = o.long("at") ?: 0,
    )

    // ─── The audit log ──────────────────────────────────────────────────────────────────────

    /** `urgent` false: chatter (a PC's status); such reads are at least five seconds apart. */
    private fun scheduleAudit(delayMs: Long, urgent: Boolean) {
        if (auditTask?.isDone == false) return
        var delay = delayMs
        if (!urgent) delay = maxOf(delay, CHATTER_GAP_MS - (System.currentTimeMillis() - lastAuditPollAt))
        auditTask = exec.schedule({ pollAudit() }, maxOf(0, delay), TimeUnit.MILLISECONDS)
    }

    private fun pollAudit() {
        if (!can(AUDIT_VIEW)) return
        lastAuditPollAt = System.currentTimeMillis()
        val floor = store.get(Keys.AUDIT_FLOOR)?.toLongOrNull()
        if (floor == null) {
            // First read after a sign-in: remember where the log stands; only later rows are news.
            val result = get("/audit-logs?pageSize=1") ?: return
            if (!result.ok) return
            val top = result.json().arr("items").objects().firstOrNull()
            store.put(Keys.AUDIT_FLOOR, (top.long("id") ?: 0).toString())
            store.put(Keys.AUDIT_AT, top.str("occurredAt") ?: Texts.isoTime(System.currentTimeMillis()))
            return
        }
        // Rows are read from a little before the newest one seen: a transaction that started
        // earlier can commit later, and its row must not be lost.
        val lastAt = Texts.parseTime(store.get(Keys.AUDIT_AT)) ?: (System.currentTimeMillis() - OVERLAP_MS)
        val from = URLEncoder.encode(Texts.isoTime(lastAt - OVERLAP_MS), "UTF-8")
        val fresh = ArrayList<JsonObject>()
        var newestAt = lastAt
        var page = 1
        var beyond = false
        while (true) {
            val result = get("/audit-logs?pageSize=$PAGE_SIZE&page=$page&from=$from") ?: return
            if (!result.ok) return
            val body = result.json()
            for (entry in body.arr("items").objects()) {
                val id = entry.long("id") ?: continue
                Texts.parseTime(entry.str("occurredAt"))?.let { if (it > newestAt) newestAt = it }
                if (id > floor && id !in seenAudit) fresh += entry
            }
            if (page.toLong() * PAGE_SIZE >= (body.long("total") ?: 0)) break
            if (page == MAX_PAGES) {
                // More happened during the gap than is read here (the newest rows come first).
                beyond = true
                break
            }
            page++
        }
        if (fresh.isEmpty()) return
        fresh.sortBy { it.long("id") }
        for (entry in fresh) {
            entry.long("id")?.let { seenAudit.add(it) }
            if (entry.str("action") == "session.start") {
                lookup.rememberSession(entry.str("entityId"), entry.obj("details").str("stationCode"))
            }
        }
        trim(seenAudit, 600)
        store.put(Keys.AUDIT_SEEN, buildJsonArray { seenAudit.forEach { add(JsonPrimitive(it)) } }.toString())
        store.put(Keys.AUDIT_AT, Texts.isoTime(newestAt))

        // A session start, an extension or a payment is announced as the sale it made. The sale
        // may still be on its way: reading the day's feed now announces it before these rows.
        if (enabled(Category.SALES) && fresh.any { it.str("action") in Describer.SALE_ACTIONS && !cameWithSale(it) }) refreshSnapshot()
        val notes = fresh.mapNotNull { entry -> if (cameWithSale(entry)) null else describer.auditNote(entry) }
            .filter { enabled(it.category) }
        if (notes.size > FLOOD) {
            // A long gap: every alert, the newest few of the rest, and one line for the remainder.
            val alerts = notes.filter { it.category == Category.ALERTS }.takeLast(FLOOD)
            val others = notes.filter { it.category != Category.ALERTS }
            val shown = alerts + others.takeLast(maxOf(0, FLOOD_KEEP - alerts.size))
            val hidden = notes.size - shown.size
            val x = texts()
            if (hidden > 0 && enabled(Category.CONNECTION)) {
                host.post(Note("audit-more:${System.currentTimeMillis()}", Category.CONNECTION,
                    if (beyond) x.t("Më shumë se $hidden ndryshime të tjera ndërkohë", "More than $hidden other changes meanwhile")
                    else x.t("Edhe $hidden ndryshime ndërkohë", "$hidden more changes meanwhile"),
                    x.t("Hapni aplikacionin për t'i parë të gjitha te Aktiviteti.", "Open the app to see them all under Activity."),
                    System.currentTimeMillis()))
            }
            shown.sortedBy { it.at }.forEach { host.post(it) }
        } else {
            notes.forEach { host.post(it) }
        }
        host.changed("activity")
    }

    /**
     * True when this audit row is the other half of a sale that was just announced: a prepaid
     * session start, an extension, a payment. The row and the sale are written in one transaction,
     * so they carry the same person, almost the same time and (where the row has one) the same amount.
     */
    private fun cameWithSale(entry: JsonObject): Boolean {
        val action = entry.str("action")
        if (action !in Describer.SALE_ACTIONS) return false
        val at = Texts.parseTime(entry.str("occurredAt")) ?: return false
        val details = entry.obj("details")
        val amount: Long? = when (action) {
            "session.start", "session.extend" -> details.long("priceCents") ?: 0
            "session.collect" -> details.long("amountCents")
            "order.accept", "order.pay" -> details.long("totalCents")
            else -> null
        }
        // Nothing was paid (open time, a free extension): there is no sale to pair with.
        if (amount != null && amount <= 0) return false
        val who = describer.actor(entry)
        return recentSales.any { sale ->
            sale.cashier == who && Math.abs(sale.at - at) <= SALE_PAIR_MS &&
                (amount == null || sale.totalCents == amount || amount in sale.lineCents)
        }
    }

    // ─── Helpers ────────────────────────────────────────────────────────────────────────────

    /** Reads the account again: its permissions can change while the app runs. */
    private fun refreshMe() {
        val result = get("/auth/me") ?: return
        if (!result.ok) return
        val me = result.json() ?: return
        if (me.str("id") != null) store.put(Keys.USER, me.toString())
    }

    private fun post(note: Note) {
        if (enabled(note.category)) host.post(note)
    }

    private fun load() {
        if (loaded) return
        loaded = true
        (parseJson(store.get(Keys.SALES_SEEN)) as? JsonArray)?.forEach { (it as? JsonPrimitive)?.content?.let(seenSales::add) }
        (parseJson(store.get(Keys.AUDIT_SEEN)) as? JsonArray)?.forEach { (it as? JsonPrimitive)?.content?.toLongOrNull()?.let(seenAudit::add) }
        parseObject(store.get(Keys.SUMMARY))?.let { host.summary(summaryFromJson(it)) }
    }

    private fun saveSeenSales() {
        store.put(Keys.SALES_SEEN, buildJsonArray { seenSales.forEach { add(JsonPrimitive(it)) } }.toString())
    }

    private fun <T> trim(set: LinkedHashSet<T>, max: Int) {
        val it = set.iterator()
        while (set.size > max && it.hasNext()) {
            it.next()
            it.remove()
        }
    }

    companion object {
        const val PROTOCOL_VERSION = 1
        const val AUDIT_VIEW = "audit.view"
        const val LIVE_VIEW = "live.view"
        const val OUTAGE_KEY = "conn:outage"

        private const val CLOSE_UNAUTHORIZED = 4001
        private const val CLOSE_INCOMPATIBLE = 4003

        /** `wake` reason of the periodic alarm. */
        const val WAKE_ALARM = "alarm"

        private const val PING_MS = 25_000L
        private const val PONG_WAIT_MS = 8_000L
        private const val CONNECT_TIMEOUT_MS = 8_000
        private const val QUICK_RETRY_MS = 20_000L
        private const val READ_TIMEOUT_MS = 75_000
        private const val WELCOME_WAIT_MS = 20_000L
        private const val POLL_MS = 60_000L
        private const val CHATTER_GAP_MS = 5_000L
        private const val OUTAGE_MS = 5 * 60_000L
        private val BACKOFF_MS = longArrayOf(2_000, 5_000, 10_000, 20_000, 40_000, 60_000)

        private const val PAGE_SIZE = 100
        private const val MAX_PAGES = 5
        private const val OVERLAP_MS = 120_000L
        private const val SALE_PAIR_MS = 2_000L

        /** More new notes than this at once (after a long gap) are summed up instead of listed. */
        private const val FLOOD = 8
        private const val FLOOD_KEEP = 5

        /** How many sales the server's day feed lists at most (`/live/snapshot`). */
        private const val FEED_SIZE = 30
    }
}
