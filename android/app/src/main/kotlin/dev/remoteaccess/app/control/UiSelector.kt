package dev.remoteaccess.app.control

import org.json.JSONObject

internal object UiSelector {
    fun parse(text: String): JSONObject {
        val selector = JSONObject(text)
        val strings = setOf("name", "text", "label", "viewId", "role")
        val flags = setOf("clickable", "editable", "scrollable", "enabled", "checked", "selected")
        val fields = selector.keys().asSequence().toSet()
        require(fields.any { it in strings || it in flags })
        require(fields.all { it in strings || it in flags || it == "match" })
        fields.forEach { key ->
            val value = selector.get(key)
            when (key) {
                in strings -> require(value is String && value.length in 1..256)
                in flags -> require(value is Boolean)
                "match" -> require(value == "exact" || value == "contains")
            }
        }
        return selector
    }
}
