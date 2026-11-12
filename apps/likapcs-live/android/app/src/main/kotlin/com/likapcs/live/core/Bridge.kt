package com.likapcs.live.core

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.io.IOException

/** What the screens can ask of the device they run on (the Android app, or the test host). */
interface Shell {
    fun appVersion(): String

    /** `granted`, `denied` (can be asked) or `blocked` (must be switched on in the settings). */
    fun notifications(): String

    /** True when the phone may not put the app to sleep ("battery: no restrictions"). */
    fun batteryFree(): Boolean
    fun device(): JsonObject
    fun askNotifications()
    fun askBattery()
    fun openSettings(page: String)
    fun testNotification()

    /** Start / stop the background service that keeps the link open. */
    fun startMonitoring()
    fun stopMonitoring()
}

/**
 * The calls the screens (a WebView) make: every one takes JSON and answers JSON, so the screens
 * never talk to the server themselves and never hold the sign-in token.
 * Answer: `{"ok":true,"data":…}` or `{"ok":false,"error":{"code":…,"message":…}}`.
 */
class Bridge(
    private val store: Store,
    private val engine: Engine,
    private val http: Http,
    private val shell: Shell,
) {
    private class Failure(val code: String, override val message: String) : Exception(message)

    fun call(method: String, argsJson: String?): String {
        val args = parseObject(argsJson)
        return try {
            val data: JsonElement = when (method) {
                "getState" -> state()
                "signIn" -> signIn(args)
                "signOut" -> signOut()
                "request" -> request(args)
                "activity" -> activity(args)
                "setOptions" -> setOptions(args)
                "discover" -> discover()
                "askNotifications" -> { shell.askNotifications(); state() }
                "askBattery" -> { shell.askBattery(); state() }
                "openSettings" -> { shell.openSettings(args.str("page") ?: "app"); state() }
                "testNotification" -> { shell.testNotification(); state() }
                "refresh" -> { engine.wake("screen"); state() }
                else -> throw Failure("unknown_method", method)
            }
            buildJsonObject {
                put("ok", true)
                put("data", data)
            }.toString()
        } catch (e: Failure) {
            failure(e.code, e.message)
        } catch (e: Exception) {
            failure("internal", e.message ?: e.javaClass.simpleName)
        }
    }

    private fun failure(code: String, message: String): String = buildJsonObject {
        put("ok", false)
        putJsonObject("error") {
            put("code", code)
            put("message", message)
        }
    }.toString()

    fun state(): JsonObject {
        val s = engine.state()
        val user = parseObject(store.get(Keys.USER))
        return buildJsonObject {
            put("appVersion", shell.appVersion())
            put("signedIn", engine.signedIn())
            put("server", store.get(Keys.SERVER))
            put("business", store.get(Keys.BUSINESS))
            put("lang", store.get(Keys.LANG) ?: "sq")
            if (user != null && engine.signedIn()) {
                putJsonObject("user") {
                    put("id", user.str("id"))
                    put("username", user.str("username"))
                    put("fullName", user.str("fullName"))
                    put("permissions", user.arr("permissions") ?: buildJsonArray { })
                }
            } else {
                put("user", null as String?)
            }
            putJsonObject("last") {
                put("username", store.get(Keys.LAST_USERNAME))
                put("email", store.get(Keys.LAST_EMAIL))
            }
            put("connection", s.conn.id)
            put("since", s.since)
            put("lastEventAt", s.lastEventAt)
            put("serverVersion", s.serverVersion)
            put("detail", s.detail)
            put("expiresAt", store.get(Keys.EXPIRES_AT))
            putJsonObject("categories") {
                for (c in Category.entries) put(c.id, engine.enabled(c))
            }
            putJsonObject("setup") {
                put("notifications", shell.notifications())
                put("battery", shell.batteryFree())
            }
            put("device", shell.device())
        }
    }

    private fun signIn(args: JsonObject?): JsonElement {
        val server = normalizeServer(args.str("server") ?: "")
            ?: throw Failure("bad_address", "not a server address")
        val username = args.str("username")?.trim().orEmpty()
        val email = args.str("email")?.trim().orEmpty()
        val password = args.str("password").orEmpty()
        if (username.isEmpty() || email.isEmpty() || password.isEmpty()) throw Failure("missing", "all fields are needed")

        // 1. Is a LIKApcs server there? Its clock is where "from now on" starts.
        val health = try {
            http.request("GET", "$server/api/v1/system/health", connectTimeoutMs = 6_000, readTimeoutMs = 8_000)
        } catch (e: IOException) {
            throw Failure("unreachable", e.message ?: "no answer")
        }
        val info = health.json()
        if (!health.ok || info.str("version") == null) throw Failure("not_likapcs", "no LIKApcs server at this address")
        val baseline = Texts.parseTime(info.str("time")) ?: System.currentTimeMillis()

        // 2. The phone sign-in: sign-in name, e-mail and password must all match.
        val login = try {
            http.request(
                "POST", "$server/api/v1/auth/phone-login",
                body = buildJsonObject {
                    put("username", username)
                    put("email", email)
                    put("password", password)
                    put("rememberMe", true)
                }.toString(),
            )
        } catch (e: IOException) {
            throw Failure("unreachable", e.message ?: "no answer")
        }
        if (!login.ok) {
            throw when (login.status) {
                400, 401 -> Failure("invalid_credentials", login.errorMessage ?: "invalid")
                423 -> Failure("locked", login.errorMessage ?: "locked")
                429 -> Failure("too_many", login.errorMessage ?: "too many attempts")
                else -> Failure("server_error", "HTTP ${login.status} ${login.errorMessage ?: ""}".trim())
            }
        }
        val body = login.json()
        val token = body.str("token") ?: throw Failure("server_error", "no token in the answer")
        val user = body.obj("user") ?: throw Failure("server_error", "no user in the answer")

        // 3. The account must be allowed to see live tracking.
        val allowed = user.arr("permissions")?.any { (it as? JsonPrimitive)?.content == Engine.LIVE_VIEW } == true
        if (!allowed) {
            try {
                http.request("POST", "$server/api/v1/auth/logout", token = token)
            } catch (e: IOException) {
                // the token stays unused and expires by itself
            }
            throw Failure("no_permission", "the account has no live.view permission")
        }

        engine.resetForSignIn(baseline)
        store.put(Keys.SERVER, server)
        store.put(Keys.TOKEN, token)
        store.put(Keys.USER, user.toString())
        store.put(Keys.EXPIRES_AT, body.str("expiresAt"))
        store.put(Keys.BUSINESS, info.str("name"))
        store.put(Keys.LAST_USERNAME, username)
        store.put(Keys.LAST_EMAIL, email)
        shell.startMonitoring()
        return state()
    }

    private fun signOut(): JsonElement {
        val server = store.get(Keys.SERVER)
        val token = store.get(Keys.TOKEN)
        shell.stopMonitoring()
        engine.stop()
        if (server != null && token != null) {
            try {
                http.request("POST", "$server/api/v1/auth/logout", token = token, connectTimeoutMs = 4_000, readTimeoutMs = 4_000)
            } catch (e: IOException) {
                // not reachable: the sign-in on the server expires by itself
            }
        }
        for (key in listOf(Keys.TOKEN, Keys.USER, Keys.EXPIRES_AT, Keys.SUMMARY)) store.put(key, null)
        return state()
    }

    /** Read-only: the screens can GET from the API, nothing else. */
    private fun request(args: JsonObject?): JsonElement {
        val path = args.str("path") ?: throw Failure("missing", "path")
        if (!path.startsWith("/") || path.contains("..") || path.contains("://")) throw Failure("bad_path", path)
        if (!engine.signedIn()) throw Failure("signed_out", "not signed in")
        val result = engine.get(path) ?: throw Failure("unreachable", "no answer from the server")
        return buildJsonObject {
            put("status", result.status)
            put("body", result.body)
        }
    }

    /** One page of the audit log in the owner's words, newest first. */
    private fun activity(args: JsonObject?): JsonElement {
        if (!engine.signedIn()) throw Failure("signed_out", "not signed in")
        val page = (args.long("page") ?: 1).coerceIn(1, 1000)
        val size = (args.long("pageSize") ?: 50).coerceIn(1, 100)
        val result = engine.get("/audit-logs?page=$page&pageSize=$size") ?: throw Failure("unreachable", "no answer from the server")
        if (result.status == 403) throw Failure("no_permission", "the account cannot read the audit log")
        if (!result.ok) throw Failure("server_error", "HTTP ${result.status}")
        val body = result.json()
        val entries = body.arr("items").objects()
        return buildJsonObject {
            put("page", page)
            put("total", body.long("total") ?: 0)
            put("items", buildJsonArray {
                for (entry in entries) {
                    val d = engine.describer.audit(entry)
                    add(buildJsonObject {
                        put("id", entry.long("id") ?: 0)
                        put("at", entry.str("occurredAt"))
                        put("category", d.category.id)
                        put("title", d.title)
                        put("text", d.text)
                        put("severity", entry.str("severity") ?: "info")
                        put("action", entry.str("action"))
                    })
                }
            })
        }
    }

    private fun setOptions(args: JsonObject?): JsonElement {
        args.str("lang")?.let { if (it == "sq" || it == "en") store.put(Keys.LANG, it) }
        args.obj("categories")?.forEach { (id, value) ->
            val category = Category.of(id) ?: return@forEach
            val on = (value as? JsonPrimitive)?.content == "true"
            store.put(Keys.category(category), if (on) "1" else "0")
        }
        engine.optionsChanged()
        return state()
    }

    private fun discover(): JsonElement = buildJsonObject {
        put("servers", buildJsonArray {
            for (f in Discovery.find()) {
                add(buildJsonObject {
                    put("name", f.name)
                    put("url", f.url)
                    put("version", f.version)
                })
            }
        })
    }
}
