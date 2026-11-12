package com.likapcs.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URI
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * The app's own WebSocket client against a small server written out by hand here, frame by frame
 * (RFC 6455): every length form, a message in pieces, ping/pong, masking and the close codes the
 * LIKApcs server uses.
 */
class WsClientTest {
    private class Events : WsClient.Listener {
        val queue = LinkedBlockingQueue<String>()
        override fun onOpen() { queue += "open" }
        override fun onText(text: String) { queue += "text:$text" }
        override fun onEnd(code: Int, reason: String, status: Int, error: Exception?) { queue += "end:$code:$status:$reason" }
        fun next(): String = queue.poll(5, TimeUnit.SECONDS) ?: throw AssertionError("nothing happened within 5 s")
    }

    /** Accepts one connection, answers the upgrade (or `refuseWith`), then runs `script`. */
    private fun server(refuseWith: String? = null, script: (InputStream, OutputStream) -> Unit): ServerSocket {
        val listener = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        Thread {
            try {
                listener.accept().use { socket: Socket ->
                    socket.soTimeout = 5000
                    val input = socket.getInputStream()
                    val output = socket.getOutputStream()
                    var key = ""
                    while (true) {
                        val line = readLine(input)
                        if (line.isEmpty()) break
                        if (line.startsWith("Sec-WebSocket-Key:", ignoreCase = true)) key = line.substringAfter(':').trim()
                    }
                    if (refuseWith != null) {
                        output.write("HTTP/1.1 $refuseWith\r\nContent-Length: 0\r\n\r\n".toByteArray())
                        output.flush()
                        return@use
                    }
                    val accept = Base64.getEncoder().encodeToString(
                        MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()),
                    )
                    output.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray())
                    output.flush()
                    script(input, output)
                }
            } catch (e: Exception) {
                // the test's own asserts report what went wrong
            } finally {
                listener.close()
            }
        }.apply { isDaemon = true }.start()
        return listener
    }

    private fun readLine(input: InputStream): String {
        val line = StringBuilder()
        while (true) {
            val b = input.read()
            if (b < 0 || b == '\n'.code) break
            if (b != '\r'.code) line.append(b.toChar())
        }
        return line.toString()
    }

    /** A server frame (never masked). */
    private fun frame(op: Int, payload: ByteArray, fin: Boolean = true): ByteArray {
        val out = ByteArrayOutputStream()
        out.write((if (fin) 0x80 else 0) or op)
        when {
            payload.size < 126 -> out.write(payload.size)
            payload.size < 65536 -> { out.write(126); out.write(payload.size shr 8); out.write(payload.size and 0xff) }
            else -> { out.write(127); for (shift in 56 downTo 0 step 8) out.write(((payload.size.toLong() shr shift) and 0xff).toInt()) }
        }
        out.write(payload)
        return out.toByteArray()
    }

    private fun text(s: String) = frame(1, s.toByteArray(Charsets.UTF_8))

    /** Reads one client frame: (opcode, payload, was it masked). */
    private fun readFrame(input: InputStream): Triple<Int, ByteArray, Boolean> {
        val b0 = input.read()
        val b1 = input.read()
        var length = b1 and 0x7f
        if (length == 126) length = (input.read() shl 8) or input.read()
        val masked = b1 and 0x80 != 0
        val mask = ByteArray(4)
        if (masked) input.readNBytes(mask, 0, 4)
        val payload = input.readNBytes(length)
        if (masked) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        return Triple(b0 and 0x0f, payload, masked)
    }

    private fun client(port: Int, events: Events, path: String = "/ws/admin") =
        WsClient(URI("ws://127.0.0.1:$port$path"), "likalivepcs-test", events, connectTimeoutMs = 3000).also { it.start() }

    @Test
    fun messagesOfEverySizeAndInPieces() {
        val medium = "m".repeat(300)        // 16-bit length
        val large = "ë€".repeat(20_000)     // 64-bit length, multi-byte characters
        val s = server { _, out ->
            out.write(text("""{"type":"server.welcome"}"""))
            out.write(text(medium))
            out.write(text(large))
            // One message in three frames, with a ping in between (allowed by the protocol).
            out.write(frame(1, "Kasjere ".toByteArray(), fin = false))
            out.write(frame(9, "p".toByteArray()))
            out.write(frame(0, "shiti ".toByteArray(), fin = false))
            out.write(frame(0, "5.80 €".toByteArray(Charsets.UTF_8)))
            out.write(frame(8, byteArrayOf(0x03, 0xE8.toByte())))
            out.flush()
            Thread.sleep(300)
        }
        val events = Events()
        client(s.localPort, events)
        assertEquals("open", events.next())
        assertEquals("""text:{"type":"server.welcome"}""", events.next())
        assertEquals("text:$medium", events.next())
        assertEquals("text:$large", events.next())
        assertEquals("text:Kasjere shiti 5.80 €", events.next())
        assertEquals("end:1000:0:", events.next())
    }

    @Test
    fun whatTheClientSendsIsMaskedAndPingsAreAnswered() {
        val got = LinkedBlockingQueue<Triple<Int, ByteArray, Boolean>>()
        val s = server { input, out ->
            got += readFrame(input)                  // the hello
            out.write(frame(9, "are you there".toByteArray()))
            out.flush()
            got += readFrame(input)                  // the pong
            got += readFrame(input)                  // a long message (16-bit length)
            out.write(frame(8, byteArrayOf(0x0F, 0xA1.toByte()) + "session expired".toByteArray()))
            out.flush()
            got += readFrame(input)                  // the close is echoed
        }
        val events = Events()
        val ws = client(s.localPort, events)
        assertEquals("open", events.next())
        assertTrue(ws.isOpen)
        assertTrue(ws.send("""{"type":"admin.hello","token":"çelësi"}"""))

        val hello = got.poll(5, TimeUnit.SECONDS)!!
        assertEquals(1, hello.first)
        assertEquals("""{"type":"admin.hello","token":"çelësi"}""", String(hello.second, Charsets.UTF_8))
        assertTrue("client frames must be masked", hello.third)

        val pong = got.poll(5, TimeUnit.SECONDS)!!
        assertEquals(10, pong.first)
        assertEquals("are you there", String(pong.second))
        assertTrue(pong.third)

        val long = "x".repeat(1000)
        assertTrue(ws.send(long))
        assertEquals(long, String(got.poll(5, TimeUnit.SECONDS)!!.second))

        // 4001: the LIKApcs server's "sign in again".
        assertEquals("end:4001:0:session expired", events.next())
        val echo = got.poll(5, TimeUnit.SECONDS)!!
        assertEquals(8, echo.first)
        assertFalse(ws.isOpen)
        assertFalse("nothing can be sent after the end", ws.send("late"))
    }

    @Test
    fun aRefusedUpgradeReportsTheHttpStatus() {
        val s = server(refuseWith = "404 Not Found") { _, _ -> }
        val events = Events()
        client(s.localPort, events, "/nowhere")
        val end = events.next()
        assertTrue(end, end.startsWith("end:0:404:"))
        assertNull("it never opened", events.queue.poll(200, TimeUnit.MILLISECONDS))
    }

    @Test
    fun noServerAtAll() {
        val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort } // free, and closed again
        val events = Events()
        client(port, events)
        val end = events.next()
        assertTrue(end, end.startsWith("end:0:0:"))
    }

    @Test
    fun aLinkThatBreaksIsReportedOnce() {
        val s = server { _, out ->
            out.write(text("one"))
            out.flush()
            // …and the connection drops without a close frame.
        }
        val events = Events()
        client(s.localPort, events)
        assertEquals("open", events.next())
        assertEquals("text:one", events.next())
        val end = events.next()
        assertTrue(end, end.startsWith("end:1006:0:"))
        assertNull(events.queue.poll(300, TimeUnit.MILLISECONDS))
    }

    @Test
    fun aSilentServerIsGivenUpAfterTheReadTimeout() {
        val s = server { _, _ -> Thread.sleep(3000) }
        val events = Events()
        WsClient(URI("ws://127.0.0.1:${s.localPort}/ws/admin"), "likalivepcs-test", events, connectTimeoutMs = 3000, readTimeoutMs = 400).start()
        assertEquals("open", events.next())
        val end = events.next()
        assertTrue(end, end.startsWith("end:1006:0:"))
    }

    @Test
    fun abortEndsItFromOurSide() {
        val s = server { input, _ -> input.read() }
        val events = Events()
        val ws = client(s.localPort, events)
        assertEquals("open", events.next())
        ws.abort()
        assertNotNull(events.next())
        assertFalse(ws.isOpen)
    }
}
