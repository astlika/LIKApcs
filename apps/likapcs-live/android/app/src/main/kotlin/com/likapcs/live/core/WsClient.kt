package com.likapcs.live.core

import java.io.BufferedInputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * A small WebSocket client (RFC 6455) for the server's `/ws/admin` stream: text messages only,
 * no extensions. It runs on its own thread; `Listener.onEnd` is called exactly once, whatever
 * way the connection ends. The app owns the connection in a background service, so it must
 * work without a WebView: that is why this is not the browser's WebSocket.
 */
class WsClient(
    private val uri: URI,
    private val userAgent: String,
    private val listener: Listener,
    private val connectTimeoutMs: Int = 10_000,
    /** No byte from the server for this long means the link is dead (0: wait forever). */
    private val readTimeoutMs: Int = 0,
) {
    interface Listener {
        fun onOpen()
        fun onText(text: String)

        /**
         * `code`: the WebSocket close code (1006 when the link broke without one, 0 when it
         * never opened). `status`: the HTTP status when the server refused the upgrade, else 0.
         */
        fun onEnd(code: Int, reason: String, status: Int, error: Exception?)
    }

    private val random = SecureRandom()
    private val writeLock = Any()

    @Volatile private var socket: Socket? = null
    @Volatile private var output: OutputStream? = null
    @Volatile private var closedByUs = false
    @Volatile private var open = false
    private var ended = false

    val isOpen: Boolean get() = open

    fun start() {
        val thread = Thread({ run() }, "likalive-ws")
        thread.isDaemon = true
        thread.start()
    }

    fun send(text: String): Boolean = writeFrame(OP_TEXT, text.toByteArray(Charsets.UTF_8))

    /** Polite close; the server answers and the reader ends. */
    fun close(code: Int = 1000) {
        closedByUs = true
        val payload = byteArrayOf((code shr 8).toByte(), code.toByte())
        if (!writeFrame(OP_CLOSE, payload)) abort()
    }

    /** Drops the connection now. */
    fun abort() {
        closedByUs = true
        try {
            socket?.close()
        } catch (e: IOException) {
            // already closed
        }
    }

    private fun end(code: Int, reason: String, status: Int, error: Exception?) {
        synchronized(this) {
            if (ended) return
            ended = true
        }
        open = false
        try {
            socket?.close()
        } catch (e: IOException) {
            // already closed
        }
        listener.onEnd(code, reason, status, error)
    }

    private fun run() {
        val input: InputStream
        try {
            val secure = uri.scheme.equals("wss", ignoreCase = true)
            val port = if (uri.port != -1) uri.port else if (secure) 443 else 80
            val host = uri.host ?: throw IOException("no host in $uri")
            val raw = Socket()
            socket = raw
            raw.tcpNoDelay = true
            raw.keepAlive = true
            raw.connect(InetSocketAddress(host, port), connectTimeoutMs)
            raw.soTimeout = connectTimeoutMs
            var s: Socket = raw
            if (secure) {
                val ssl = (SSLSocketFactory.getDefault() as SSLSocketFactory)
                    .createSocket(raw, host, port, true) as SSLSocket
                val params = ssl.sslParameters
                params.endpointIdentificationAlgorithm = "HTTPS"
                ssl.sslParameters = params
                ssl.startHandshake()
                s = ssl
                socket = ssl
            }
            if (closedByUs) throw IOException("closed")
            val out = s.getOutputStream()
            input = BufferedInputStream(s.getInputStream(), 16 * 1024)

            val keyBytes = ByteArray(16).also { random.nextBytes(it) }
            val key = Base64.getEncoder().encodeToString(keyBytes)
            val path = (uri.rawPath?.ifEmpty { "/" } ?: "/") + (uri.rawQuery?.let { "?$it" } ?: "")
            val hostHeader = if (uri.port == -1) host else "$host:${uri.port}"
            val request = "GET $path HTTP/1.1\r\n" +
                "Host: $hostHeader\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Key: $key\r\n" +
                "Sec-WebSocket-Version: 13\r\n" +
                "User-Agent: $userAgent\r\n" +
                "\r\n"
            out.write(request.toByteArray(Charsets.ISO_8859_1))
            out.flush()

            val statusLine = readLine(input)
            val status = statusLine.split(' ').getOrNull(1)?.toIntOrNull() ?: 0
            val headers = HashMap<String, String>()
            while (true) {
                val line = readLine(input)
                if (line.isEmpty()) break
                val colon = line.indexOf(':')
                if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
            }
            if (status != 101) {
                end(0, statusLine, status, IOException("upgrade refused: $statusLine"))
                return
            }
            val expected = Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1").digest((key + GUID).toByteArray(Charsets.ISO_8859_1)),
            )
            if (headers["sec-websocket-accept"] != expected) {
                end(0, "bad accept key", 0, IOException("not a WebSocket server"))
                return
            }
            s.soTimeout = readTimeoutMs
            output = out
            open = true
        } catch (e: Exception) {
            end(0, e.message ?: e.javaClass.simpleName, 0, e)
            return
        }

        listener.onOpen()

        try {
            val message = java.io.ByteArrayOutputStream()
            var messageOp = 0
            while (true) {
                val b0 = readByte(input)
                val b1 = readByte(input)
                val fin = b0 and 0x80 != 0
                val op = b0 and 0x0f
                val masked = b1 and 0x80 != 0
                var length = (b1 and 0x7f).toLong()
                if (length == 126L) {
                    length = ((readByte(input) shl 8) or readByte(input)).toLong()
                } else if (length == 127L) {
                    length = 0
                    repeat(8) { length = (length shl 8) or readByte(input).toLong() }
                }
                if (length < 0 || length > MAX_MESSAGE) throw IOException("frame too large: $length")
                val mask = if (masked) ByteArray(4).also { readFully(input, it) } else null
                val payload = ByteArray(length.toInt())
                readFully(input, payload)
                if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()

                when (op) {
                    OP_CONTINUATION, OP_TEXT, OP_BINARY -> {
                        if (op != OP_CONTINUATION) {
                            message.reset()
                            messageOp = op
                        }
                        if (message.size() + payload.size > MAX_MESSAGE) throw IOException("message too large")
                        message.write(payload)
                        if (fin) {
                            if (messageOp == OP_TEXT) listener.onText(message.toByteArray().toString(Charsets.UTF_8))
                            message.reset()
                        }
                    }
                    OP_PING -> writeFrame(OP_PONG, payload)
                    OP_PONG -> Unit
                    OP_CLOSE -> {
                        val code = if (payload.size >= 2) ((payload[0].toInt() and 0xff) shl 8) or (payload[1].toInt() and 0xff) else 1005
                        val reason = if (payload.size > 2) String(payload, 2, payload.size - 2, Charsets.UTF_8) else ""
                        if (!closedByUs) writeFrame(OP_CLOSE, payload.copyOf(minOf(payload.size, 2)))
                        end(code, reason, 0, null)
                        return
                    }
                    else -> throw IOException("unknown frame type $op")
                }
            }
        } catch (e: Exception) {
            end(1006, e.message ?: e.javaClass.simpleName, 0, if (closedByUs) null else e)
        }
    }

    private fun writeFrame(op: Int, payload: ByteArray): Boolean {
        val out = output ?: return false
        val header = java.io.ByteArrayOutputStream(payload.size + 14)
        header.write(0x80 or op)
        when {
            payload.size < 126 -> header.write(0x80 or payload.size)
            payload.size < 65536 -> {
                header.write(0x80 or 126)
                header.write(payload.size shr 8)
                header.write(payload.size and 0xff)
            }
            else -> {
                header.write(0x80 or 127)
                val n = payload.size.toLong()
                for (shift in 56 downTo 0 step 8) header.write(((n shr shift) and 0xff).toInt())
            }
        }
        // Client frames are always masked (RFC 6455 §5.3).
        val mask = ByteArray(4).also { random.nextBytes(it) }
        header.write(mask)
        for (i in payload.indices) header.write(payload[i].toInt() xor mask[i and 3].toInt())
        return try {
            synchronized(writeLock) {
                out.write(header.toByteArray())
                out.flush()
            }
            true
        } catch (e: IOException) {
            false
        }
    }

    private fun readByte(input: InputStream): Int {
        val b = input.read()
        if (b < 0) throw EOFException("connection closed by the server")
        return b
    }

    private fun readFully(input: InputStream, into: ByteArray) {
        var done = 0
        while (done < into.size) {
            val n = input.read(into, done, into.size - done)
            if (n < 0) throw EOFException("connection closed by the server")
            done += n
        }
    }

    /** One header line, without the line end. Header lines are short; a long one is an attack or garbage. */
    private fun readLine(input: InputStream): String {
        val line = StringBuilder()
        while (true) {
            val b = readByte(input)
            if (b == '\n'.code) break
            if (b != '\r'.code) line.append(b.toChar())
            if (line.length > 8192) throw IOException("header line too long")
        }
        return line.toString()
    }

    companion object {
        private const val GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val OP_CONTINUATION = 0
        private const val OP_TEXT = 1
        private const val OP_BINARY = 2
        private const val OP_CLOSE = 8
        private const val OP_PING = 9
        private const val OP_PONG = 10

        /** The admin stream sends small JSON messages; anything larger is refused. */
        private const val MAX_MESSAGE = 4L * 1024 * 1024
    }
}
