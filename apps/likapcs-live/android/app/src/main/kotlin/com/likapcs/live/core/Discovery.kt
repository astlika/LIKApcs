package com.likapcs.live.core

import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * Finds LIKApcs servers on the same Wi-Fi: the same UDP question the gaming PCs ask
 * ("LIKAPCS_DISCOVER_V1" to port 4701). It only works on the shop's own network; over Tailscale
 * the address is typed by hand.
 */
object Discovery {
    class Found(val name: String, val url: String, val version: String)

    private const val REQUEST = "LIKAPCS_DISCOVER_V1"
    const val PORT = 4701

    fun find(timeoutMs: Int = 1800, port: Int = PORT, extraTargets: List<String> = emptyList()): List<Found> {
        val found = LinkedHashMap<String, Found>()
        var socket: DatagramSocket? = null
        try {
            socket = DatagramSocket()
            socket.broadcast = true
            socket.soTimeout = 300
            val payload = REQUEST.toByteArray(Charsets.US_ASCII)
            val targets = LinkedHashSet<InetAddress>()
            try {
                targets += InetAddress.getByName("255.255.255.255")
                for (nic in NetworkInterface.getNetworkInterfaces()) {
                    if (!nic.isUp || nic.isLoopback) continue
                    for (address in nic.interfaceAddresses) address.broadcast?.let { targets += it }
                }
                for (t in extraTargets) targets += InetAddress.getByName(t)
            } catch (e: Exception) {
                // an interface that cannot be read is skipped
            }
            for (target in targets) {
                try {
                    socket.send(DatagramPacket(payload, payload.size, target, port))
                } catch (e: Exception) {
                    // no route on this interface
                }
            }
            val deadline = System.currentTimeMillis() + timeoutMs
            val buffer = ByteArray(4096)
            while (System.currentTimeMillis() < deadline) {
                val packet = DatagramPacket(buffer, buffer.size)
                try {
                    socket.receive(packet)
                } catch (e: SocketTimeoutException) {
                    continue
                }
                val reply = parseObject(String(packet.data, 0, packet.length, Charsets.UTF_8)) ?: continue
                if (reply.str("service") != "likapcs") continue
                val from = packet.address.hostAddress ?: continue
                val httpPort = reply.long("port") ?: 4700
                // The address the answer came from is the one this phone can reach.
                val url = "http://$from:$httpPort"
                val id = reply.str("installationId") ?: url
                found[id] = Found(reply.str("name") ?: "LIKApcs", url, reply.str("version") ?: "")
            }
        } catch (e: Exception) {
            // no network: nothing found
        } finally {
            socket?.close()
        }
        return found.values.toList()
    }
}
