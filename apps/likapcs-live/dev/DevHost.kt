/*
 * Development host: runs the same engine and bridge as the Android app on a desktop JVM, so the
 * screens can be opened in a browser and the notifications can be read as text. Never packaged
 * into the APK (it is outside the Android source set).
 *
 *   POST /bridge/call    {"method": "...", "args": {...}}  → the bridge's answer
 *   GET  /bridge/events  server-sent events: state, changed, note
 *   GET  /dev/notes      every notification "posted" so far (DELETE clears the list)
 *
 *   GET  /dev/shell      ?notifications=granted|denied|blocked&battery=true|false
 *   GET  /…              the screens (when a www directory is given)
 *
 * Usage: DevHost [port] [store-file] [www-dir] [bind-address]
 * Environment: LIKALIVE_POLL_MS, LIKALIVE_OUTAGE_MS (shorter waits for the checks, see main).
 */
import com.likapcs.live.core.Bridge
import com.likapcs.live.core.Engine
import com.likapcs.live.core.EngineState
import com.likapcs.live.core.Host
import com.likapcs.live.core.Http
import com.likapcs.live.core.Note
import com.likapcs.live.core.Shell
import com.likapcs.live.core.Store
import com.likapcs.live.core.Summary
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

class FileStore(private val file: File?) : Store {
    private val values = HashMap<String, String>()

    init {
        if (file != null && file.exists()) {
            try {
                for ((k, v) in Json.parseToJsonElement(file.readText()).jsonObject) values[k] = (v as JsonPrimitive).content
            } catch (e: Exception) {
                println("store unreadable, starting empty: ${e.message}")
            }
        }
    }

    @Synchronized
    override fun get(key: String): String? = values[key]

    @Synchronized
    override fun put(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
        file?.writeText(buildJsonObject { for ((k, v) in values) put(k, v) }.toString())
    }
}

class DevShell : Shell {
    @Volatile var notifications = "denied"
    @Volatile var battery = false
    @Volatile var monitoring = false
    lateinit var engine: Engine
    lateinit var host: DevHostImpl

    override fun appVersion() = "1.0.0-dev"
    override fun notifications() = notifications
    override fun batteryFree() = battery
    override fun device(): JsonObject = buildJsonObject {
        put("sdk", 34)
        put("brand", "realme")
        put("model", "RMX3933 (dev host)")
        put("platform", "dev")
    }

    override fun askNotifications() { notifications = "granted"; host.emitState() }
    override fun askBattery() { battery = true; host.emitState() }
    override fun openSettings(page: String) { println("[shell] open settings: $page") }
    override fun testNotification() {
        val x = engine.texts()
        host.post(Note("test:${System.currentTimeMillis()}", com.likapcs.live.core.Category.SALES,
            x.t("Arta shiti 3.50 €", "Arta sold 3.50 €"), x.t("Provë: Coca-Cola ×2 · fitimi 1.20 €", "Test: Coca-Cola ×2 · profit 1.20 €"),
            System.currentTimeMillis(), "sales"))
    }

    override fun startMonitoring() { monitoring = true; engine.start() }
    override fun stopMonitoring() { monitoring = false }
}

class DevHostImpl : Host {
    val notes = CopyOnWriteArrayList<Note>()
    val listeners = CopyOnWriteArrayList<LinkedBlockingQueue<String>>()
    @Volatile var summary: Summary? = null
    lateinit var bridge: Bridge

    private fun emit(event: String, data: String) {
        val frame = "event: $event\ndata: $data\n\n"
        for (q in listeners) q.offer(frame)
    }

    fun emitState() = emit("state", bridge.state().toString())

    override fun post(note: Note) {
        notes += note
        println("[note] ${note.category.id.padEnd(10)} | ${note.title} | ${note.text}")
        emit("note", noteJson(note).toString())
    }

    override fun cancel(key: String) {
        println("[cancel] $key")
        notes.removeIf { it.key == key }
    }

    override fun summary(summary: Summary?) {
        this.summary = summary
        if (summary != null) {
            println("[summary] ${summary.date} turnover=${summary.turnoverCents} sales=${summary.salesCount} " +
                summary.staff.joinToString(", ") { "${it.name}=${it.salesCents}(${it.salesCount})" })
        } else println("[summary] none")
    }

    override fun stateChanged(state: EngineState) {
        println("[state] ${state.conn.id} ${state.detail ?: ""}")
        emitState()
    }

    override fun changed(kind: String) = emit("changed", """{"kind":"$kind"}""")
    override fun stayAwake(ms: Long) = Unit
    override fun log(line: String) = println("[log] $line")

    fun noteJson(n: Note) = buildJsonObject {
        put("key", n.key)
        put("category", n.category.id)
        put("title", n.title)
        put("text", n.text)
        put("at", n.at)
        put("tab", n.tab)
    }
}

fun main(args: Array<String>) {
    val port = args.getOrNull(0)?.toIntOrNull() ?: 4780
    val storeFile = args.getOrNull(1)?.let { File(it) }
    val store = FileStore(storeFile)
    val http = Http("likalivepcs-dev")
    val host = DevHostImpl()
    val shell = DevShell()
    // Shorter waits for the checks: the audit log is read every LIKALIVE_POLL_MS (a minute on the
    // phone), and a lost link is reported after LIKALIVE_OUTAGE_MS (five minutes on the phone).
    val pollMs = System.getenv("LIKALIVE_POLL_MS")?.toLongOrNull() ?: 60_000L
    val outageMs = System.getenv("LIKALIVE_OUTAGE_MS")?.toLongOrNull() ?: 5 * 60_000L
    val engine = Engine(store, host, http, "likalivepcs-dev", pollMs, outageMs)
    val bridge = Bridge(store, engine, http, shell)
    shell.engine = engine
    shell.host = host
    host.bridge = bridge
    if (engine.signedIn()) shell.startMonitoring()

    val www = args.getOrNull(2)?.takeIf { it.isNotEmpty() }?.let { File(it).canonicalFile }
    val bind = args.getOrNull(3) ?: "127.0.0.1"
    val server = HttpServer.create(InetSocketAddress(bind, port), 0)
    server.executor = Executors.newCachedThreadPool { r -> Thread(r, "dev-http").apply { isDaemon = true } }

    fun send(ex: HttpExchange, status: Int, body: String, type: String = "application/json; charset=utf-8") {
        val bytes = body.toByteArray(Charsets.UTF_8)
        ex.responseHeaders.add("Content-Type", type)
        ex.responseHeaders.add("Cache-Control", "no-store")
        ex.sendResponseHeaders(status, bytes.size.toLong())
        ex.responseBody.use { it.write(bytes) }
    }

    server.createContext("/bridge/call") { ex ->
        try {
            val body = ex.requestBody.readBytes().toString(Charsets.UTF_8)
            val call = Json.parseToJsonElement(body).jsonObject
            val method = (call["method"] as JsonPrimitive).content
            val callArgs = call["args"]?.toString()
            send(ex, 200, bridge.call(method, callArgs))
        } catch (e: Exception) {
            send(ex, 400, """{"ok":false,"error":{"code":"bad_request","message":${JsonPrimitive(e.message ?: "")}}}""")
        }
    }
    server.createContext("/bridge/events") { ex ->
        val queue = LinkedBlockingQueue<String>()
        host.listeners += queue
        try {
            ex.responseHeaders.add("Content-Type", "text/event-stream; charset=utf-8")
            ex.responseHeaders.add("Cache-Control", "no-store")
            ex.sendResponseHeaders(200, 0)
            val out = ex.responseBody
            out.write(": connected\n\n".toByteArray())
            out.flush()
            while (true) {
                val frame = queue.poll(15, TimeUnit.SECONDS) ?: ": keep-alive\n\n"
                out.write(frame.toByteArray(Charsets.UTF_8))
                out.flush()
            }
        } catch (e: Exception) {
            // the browser tab was closed
        } finally {
            host.listeners -= queue
            ex.close()
        }
    }
    server.createContext("/dev/notes") { ex ->
        if (ex.requestMethod == "DELETE") host.notes.clear()
        send(ex, 200, buildJsonArray { host.notes.forEach { add(host.noteJson(it)) } }.toString())
    }
    server.createContext("/dev/shell") { ex ->
        // ?notifications=granted|denied|blocked&battery=true|false — to see every state of the setup card
        val q = (ex.requestURI.query ?: "").split('&').mapNotNull { it.split('=').takeIf { p -> p.size == 2 }?.let { p -> p[0] to p[1] } }.toMap()
        q["notifications"]?.let { shell.notifications = it }
        q["battery"]?.let { shell.battery = it == "true" }
        host.emitState()
        send(ex, 200, bridge.state().toString())
    }
    if (www != null) {
        server.createContext("/") { ex ->
            val name = ex.requestURI.path.trimStart('/').ifEmpty { "index.html" }
            val file = File(www, name).canonicalFile
            if (!file.path.startsWith(www.path) || !file.isFile) {
                send(ex, 404, "not found", "text/plain; charset=utf-8")
            } else {
                val type = when (file.extension) {
                    "html" -> "text/html; charset=utf-8"
                    "css" -> "text/css; charset=utf-8"
                    "js" -> "text/javascript; charset=utf-8"
                    "svg" -> "image/svg+xml"
                    "png" -> "image/png"
                    else -> "application/octet-stream"
                }
                val bytes = file.readBytes()
                ex.responseHeaders.add("Content-Type", type)
                ex.responseHeaders.add("Cache-Control", "no-store")
                ex.sendResponseHeaders(200, bytes.size.toLong())
                ex.responseBody.use { it.write(bytes) }
            }
        }
    }
    server.start()
    println("[dev] likalivepcs dev host on http://$bind:$port")
    Thread.currentThread().join()
}
