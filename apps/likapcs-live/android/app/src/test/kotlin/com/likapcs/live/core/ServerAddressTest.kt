package com.likapcs.live.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What the owner may type into "server address", and what the app makes of it. */
class ServerAddressTest {
    @Test
    fun aBareAddressGetsHttpAndTheServersPort() {
        assertEquals("http://192.168.1.10:4700", normalizeServer("192.168.1.10"))
        assertEquals("http://192.168.1.10:4700", normalizeServer("192.168.1.10:4700"))
        assertEquals("http://192.168.1.10:4800", normalizeServer("192.168.1.10:4800"))
        assertEquals("http://192.168.1.10:4700", normalizeServer("  192.168.1.10:4700  "))
    }

    @Test
    fun aPastedAddressIsCleaned() {
        assertEquals("http://100.64.0.1:4700", normalizeServer("http://100.64.0.1:4700/"))
        assertEquals("http://100.64.0.1:4700", normalizeServer("HTTP://100.64.0.1:4700"))
        assertEquals("http://100.64.0.1:4700", normalizeServer("http://100.64.0.1"))
    }

    @Test
    fun namesWork() {
        assertEquals("http://pc-kryesor.tailnet-1234.ts.net:4700", normalizeServer("pc-kryesor.tailnet-1234.ts.net"))
        assertEquals("http://likapcs:4700", normalizeServer("likapcs"))
    }

    @Test
    fun httpsKeepsItsOwnPort() {
        assertEquals("https://shop.example.com", normalizeServer("https://shop.example.com"))
        assertEquals("https://shop.example.com", normalizeServer("https://shop.example.com:443/"))
        assertEquals("https://shop.example.com:8443", normalizeServer("https://shop.example.com:8443"))
    }

    @Test
    fun ipv6InBrackets() {
        assertEquals("http://[fd7a:115c:a1e0::1]:4700", normalizeServer("[fd7a:115c:a1e0::1]"))
        assertEquals("http://[fd7a:115c:a1e0::1]:4700", normalizeServer("http://[fd7a:115c:a1e0::1]:4700"))
    }

    @Test
    fun whatIsNotAnAddressIsRefused() {
        assertNull(normalizeServer(""))
        assertNull(normalizeServer("   "))
        assertNull(normalizeServer("http://"))
        assertNull(normalizeServer("192.168.1.10 4700"))
        assertNull(normalizeServer("ftp://192.168.1.10"))
        assertNull(normalizeServer("owner:secret@192.168.1.10"))
        assertNull(normalizeServer("192.168.1.10:99999"))
        assertNull(normalizeServer("192.168.1.10:0"))
    }
}
