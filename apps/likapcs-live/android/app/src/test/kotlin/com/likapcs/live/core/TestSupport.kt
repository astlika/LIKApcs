package com.likapcs.live.core

import kotlinx.serialization.json.JsonElement

/** A store that lives in memory, for tests. */
class MemoryStore : Store {
    val values = HashMap<String, String>()
    override fun get(key: String): String? = values[key]
    override fun put(key: String, value: String?) {
        if (value == null) values.remove(key) else values[key] = value
    }
}

/** A clock the test moves by hand. */
class TestClock(var now: Long) {
    fun plus(ms: Long) {
        now += ms
    }
}

/** API answers by path, as JSON text; a missing path is "no answer". Remembers what was asked. */
class FakeApi {
    val answers = HashMap<String, String>()
    val asked = ArrayList<String>()

    /** Runs while a question is on its way: a test lets time pass here. */
    var onFetch: (() -> Unit)? = null

    fun fetch(path: String): JsonElement? {
        asked += path
        onFetch?.invoke()
        // A query string may vary (dates): the path before it is enough to find the answer.
        return (answers[path] ?: answers[path.substringBefore('?')])?.let { parseJson(it) }
    }
}
