package com.likapcs.live.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/*
 * Small, forgiving JSON access. The server's answers are read field by field and every field may
 * be missing: a newer or older server must never crash the app.
 */

internal fun parseJson(text: String?): JsonElement? =
    if (text.isNullOrBlank()) null
    else try {
        Json.parseToJsonElement(text)
    } catch (e: Exception) {
        null
    }

internal fun parseObject(text: String?): JsonObject? = parseJson(text) as? JsonObject

internal fun JsonElement?.asObj(): JsonObject? = this as? JsonObject
internal fun JsonElement?.asArr(): JsonArray? = this as? JsonArray

private fun JsonObject?.prim(key: String): JsonPrimitive? {
    val v = this?.get(key)
    return if (v is JsonPrimitive && v !is JsonNull) v else null
}

internal fun JsonObject?.obj(key: String): JsonObject? = this?.get(key) as? JsonObject
internal fun JsonObject?.arr(key: String): JsonArray? = this?.get(key) as? JsonArray
internal fun JsonObject?.str(key: String): String? = prim(key)?.content
internal fun JsonObject?.long(key: String): Long? = prim(key)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
internal fun JsonObject?.bool(key: String): Boolean? = prim(key)?.booleanOrNull

/** Objects of an array; anything else in it is skipped. */
internal fun JsonArray?.objects(): List<JsonObject> = this?.mapNotNull { it as? JsonObject } ?: emptyList()

/** A JSON string literal (quoted and escaped). */
internal fun jsonQuote(text: String): String = JsonPrimitive(text).toString()
