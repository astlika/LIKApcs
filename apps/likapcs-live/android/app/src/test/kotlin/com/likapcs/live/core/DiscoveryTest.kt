package com.likapcs.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress

/** "Find the server on Wi-Fi": the UDP question the LIKApcs server answers on port 4701. */
class DiscoveryTest {
    /** Answers every question on a free UDP port with `reply`; returns the port. */
    private fun responder(reply: String): DatagramSocket {
        val socket = DatagramSocket(0, InetAddress.getByName("127.0.0.1"))
        Thread {
            try {
                val buffer = ByteArray(256)
                while (true) {
                    val question = DatagramPacket(buffer, buffer.size)
                    socket.receive(question)
                    if (String(question.data, 0, question.length) != "LIKAPCS_DISCOVER_V1") continue
                    val bytes = reply.toByteArray(Charsets.UTF_8)
                    socket.send(DatagramPacket(bytes, bytes.size, question.address, question.port))
                }
            } catch (e: Exception) {
                // closed by the test
            }
        }.apply { isDaemon = true }.start()
        return socket
    }

    @Test
    fun aServerThatAnswersIsFoundAtTheAddressItAnsweredFrom() {
        val server = responder("""{"service":"likapcs","name":"Lokali Im","port":4700,"version":"0.33.4","installationId":"abc","urls":["http://10.0.0.5:4700"]}""")
        try {
            val found = Discovery.find(timeoutMs = 700, port = server.localPort, extraTargets = listOf("127.0.0.1"))
            assertEquals(1, found.size)
            assertEquals("Lokali Im", found[0].name)
            // Not the address the server believes it has: the one this device reached it at.
            assertEquals("http://127.0.0.1:4700", found[0].url)
            assertEquals("0.33.4", found[0].version)
        } finally {
            server.close()
        }
    }

    @Test
    fun otherThingsOnTheNetworkAreIgnored() {
        val other = responder("""{"service":"printer","name":"HP"}""")
        val garbage = responder("hello?")
        try {
            assertTrue(Discovery.find(timeoutMs = 500, port = other.localPort, extraTargets = listOf("127.0.0.1")).isEmpty())
            assertTrue(Discovery.find(timeoutMs = 500, port = garbage.localPort, extraTargets = listOf("127.0.0.1")).isEmpty())
        } finally {
            other.close()
            garbage.close()
        }
    }

    @Test
    fun nothingThereMeansAnEmptyList() {
        val free = DatagramSocket(0, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        assertTrue(Discovery.find(timeoutMs = 400, port = free, extraTargets = listOf("127.0.0.1")).isEmpty())
    }
}
