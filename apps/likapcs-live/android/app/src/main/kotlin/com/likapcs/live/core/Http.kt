package com.likapcs.live.core

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

class HttpResult(val status: Int, val body: String) {
    val ok: Boolean get() = status in 200..299
    fun json() = parseObject(body)

    /** The server's own error text (`{error: {code, message}}`), when it sent one. */
    val errorCode: String? get() = json().obj("error").str("code")
    val errorMessage: String? get() = json().obj("error").str("message")
}

/**
 * Plain HTTP to the LIKApcs server. No `Origin` header is sent, so the server treats the app like
 * its other native clients (no CORS entry is needed). Throws IOException when the server cannot
 * be reached; an HTTP error status is returned, not thrown.
 */
class Http(private val userAgent: String) {
    @Throws(IOException::class)
    fun request(
        method: String,
        url: String,
        token: String? = null,
        body: String? = null,
        connectTimeoutMs: Int = 8_000,
        readTimeoutMs: Int = 15_000,
    ): HttpResult {
        val conn = URI(url).toURL().openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = connectTimeoutMs
            conn.readTimeout = readTimeoutMs
            conn.useCaches = false
            conn.instanceFollowRedirects = false
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("User-Agent", userAgent)
            // One request per connection: a pooled connection can be dead after the phone slept.
            conn.setRequestProperty("Connection", "close")
            if (token != null) conn.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                val bytes = body.toByteArray(Charsets.UTF_8)
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setFixedLengthStreamingMode(bytes.size)
                conn.outputStream.use { it.write(bytes) }
            }
            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
            return HttpResult(status, text)
        } finally {
            conn.disconnect()
        }
    }
}

/**
 * `192.168.1.10`, `192.168.1.10:4700`, `http://100.64.0.1:4700/` → `http://host:port`.
 * Plain addresses get `http://` and the server's default port 4700. Null when it is not an address.
 */
fun normalizeServer(input: String): String? {
    var value = input.trim()
    if (value.isEmpty() || value.any { it.isWhitespace() }) return null
    if (!value.contains("://")) value = "http://$value"
    value = value.trimEnd('/')
    return try {
        val url = URI(value)
        val scheme = url.scheme?.lowercase() ?: return null
        if (scheme != "http" && scheme != "https") return null
        val host = url.host
        if (host.isNullOrEmpty()) return null
        if (url.userInfo != null) return null
        val port = if (url.port != -1) url.port else if (scheme == "http") 4700 else 443
        if (port !in 1..65535) return null
        val shown = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        if (scheme == "https" && port == 443) "https://$shown" else "$scheme://$shown:$port"
    } catch (e: Exception) {
        null
    }
}
