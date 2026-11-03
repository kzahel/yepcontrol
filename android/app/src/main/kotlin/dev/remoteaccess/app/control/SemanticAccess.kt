package dev.remoteaccess.app.control

import android.graphics.Rect
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import dev.remoteaccess.protocol.ControlCommand
import dev.remoteaccess.protocol.SemanticGuard
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/** Main-thread only. A short-lived observation is consumed before any node action. */
internal class SemanticAccess {
    private data class Target(
        val path: List<Int>,
        val node: AccessibilityNodeInfo,
        val signature: String?,
    )

    private data class Observation(
        val owner: Any,
        val token: String,
        val window: Int,
        val at: Long,
        val targets: List<Target>,
    )

    private var observation: Observation? = null

    @Suppress("DEPRECATION")
    fun clear(owner: Any? = null) {
        val old = observation ?: return
        if (owner != null && old.owner !== owner) return
        observation = null
        old.targets.forEach { it.node.recycle() }
    }

    @Suppress("DEPRECATION")
    private fun description(
        node: AccessibilityNodeInfo,
        id: Int,
        parent: Int,
    ): JSONObject {
        val password = node.isPassword
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        val actions = node.actionList.map { it.id }
        val usable = node.isEnabled && node.isVisibleToUser && !password
        return JSONObject()
            .put("enabled", node.isEnabled)
            .put("checked", node.isChecked)
            .put("selected", node.isSelected)
            .put("checkable", node.isCheckable)
            .put(
                "stateDescription",
                if (password) {
                    ""
                } else {
                    node.stateDescription
                        ?.toString()
                        .orEmpty()
                        .take(256)
                },
            ).put("node", id)
            .put("parent", parent)
            .put(
                "role",
                node.className
                    ?.toString()
                    .orEmpty()
                    .take(256),
            ).put(
                "text",
                if (password) {
                    ""
                } else {
                    node.text
                        ?.toString()
                        .orEmpty()
                        .take(256)
                },
            ).put(
                "label",
                if (password) {
                    ""
                } else {
                    node.contentDescription
                        ?.toString()
                        .orEmpty()
                        .take(256)
                },
            ).put("viewId", node.viewIdResourceName.orEmpty().take(256))
            .put("bounds", JSONArray(listOf(bounds.left, bounds.top, bounds.right, bounds.bottom)))
            .put("clickable", usable && AccessibilityNodeInfo.ACTION_CLICK in actions)
            .put("editable", usable && node.isEditable && AccessibilityNodeInfo.ACTION_SET_TEXT in actions)
            .put(
                "scrollable",
                usable &&
                    (AccessibilityNodeInfo.ACTION_SCROLL_FORWARD in actions || AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD in actions),
            ).put("password", password)
    }

    @Suppress("DEPRECATION")
    private fun signature(node: AccessibilityNodeInfo): String? =
        SemanticGuard.fingerprint(
            listOf(
                description(node, 0, -1).toString(),
                if (node.isPassword) "" else node.text?.toString().orEmpty(),
                if (node.isPassword) "" else node.contentDescription?.toString().orEmpty(),
                if (node.isPassword) "" else node.stateDescription?.toString().orEmpty(),
                node.viewIdResourceName.orEmpty(),
                node.className?.toString().orEmpty(),
                node.packageName?.toString().orEmpty(),
                "${node.childCount}|${node.isEnabled}|${node.isVisibleToUser}|${node.isChecked}|${node.isSelected}|${node.isCheckable}",
                node.actionList
                    .map { it.id }
                    .sorted()
                    .joinToString(","),
            ),
        )

    private fun matches(
        node: AccessibilityNodeInfo,
        selector: JSONObject,
    ): Boolean {
        if (node.isPassword) return false
        val contains = selector.optString("match", "exact") == "contains"

        fun text(
            key: String,
            vararg values: String,
        ): Boolean =
            !selector.has(key) || values.any { if (contains) it.contains(selector.getString(key)) else it == selector.getString(key) }
        if (!text("name", node.text?.toString().orEmpty(), node.contentDescription?.toString().orEmpty()) ||
            !text("text", node.text?.toString().orEmpty()) ||
            !text("label", node.contentDescription?.toString().orEmpty()) ||
            !text("viewId", node.viewIdResourceName.orEmpty()) ||
            !text("role", node.className?.toString().orEmpty())
        ) {
            return false
        }
        val flags = listOf("clickable", "editable", "scrollable", "enabled", "checked", "selected").filter { selector.has(it) }
        if (flags.isEmpty()) return true
        val descriptor = description(node, 0, -1)
        return flags.all { selector.getBoolean(it) == descriptor.getBoolean(it) }
    }

    @Suppress("DEPRECATION")
    fun snapshot(
        owner: Any,
        root: AccessibilityNodeInfo,
        request: ControlCommand? = null,
    ): ByteArray? {
        clear()
        val all = mutableListOf<Target>()
        val parents = mutableListOf<Int>()
        val matched = mutableListOf<Int>()
        val reasons = linkedSetOf<String>()
        val extended = request != null
        val query = request?.op == 29
        var visited = 0
        var lookups = 0
        var stop = false
        val started = SystemClock.elapsedRealtime()
        val maxNodes = request?.values?.get(0) ?: 128
        val maxDepth = request?.values?.get(1) ?: 20
        val maxMatches = request?.values?.get(2) ?: 0
        val timeout = request?.values?.get(3) ?: 1000
        val window = root.windowId
        var traversalStarted = false

        try {
            val selector = if (query) UiSelector.parse(requireNotNull(request).text) else null

            fun visit(
                node: AccessibilityNodeInfo,
                parent: Int,
                path: List<Int>,
            ) {
                var retained = false
                try {
                    if (visited >= maxNodes) {
                        reasons.add("nodes")
                        stop = true
                        return
                    }
                    if (SystemClock.elapsedRealtime() - started >= timeout) {
                        reasons.add("time")
                        stop = true
                        return
                    }
                    visited++
                    if (!node.isVisibleToUser) return
                    val id = all.size
                    all.add(Target(path, node, null))
                    parents.add(parent)
                    retained = true
                    if (selector != null && matches(node, selector)) {
                        if (matched.size == maxMatches) {
                            reasons.add("matches")
                            stop = true
                            return
                        }
                        matched.add(id)
                    }
                    if (node.isPassword) return
                    if (path.size >= maxDepth && node.childCount > 0) {
                        reasons.add("depth")
                        return
                    }
                    for (index in 0 until node.childCount) {
                        if (stop) break
                        if (visited >= maxNodes) {
                            reasons.add("nodes")
                            stop = true
                            break
                        }
                        if (lookups++ >= maxNodes * 2) {
                            reasons.add("lookups")
                            stop = true
                            break
                        }
                        if (SystemClock.elapsedRealtime() - started >= timeout) {
                            reasons.add("time")
                            stop = true
                            break
                        }
                        val child = node.getChild(index)
                        if (child == null) reasons.add("unavailable") else visit(child, id, path + index)
                    }
                } finally {
                    if (!retained) node.recycle()
                }
            }
            traversalStarted = true
            visit(root, -1, emptyList())
            if (all.isEmpty()) return null
            val selected = linkedSetOf(0)
            if (query) {
                for (match in matched) {
                    var ancestor = match
                    while (ancestor >= 0 && selected.add(ancestor)) ancestor = parents[ancestor]
                }
            } else {
                selected.addAll(all.indices)
            }
            val nodes = JSONArray()
            val targets = mutableListOf<Target>()
            val ids = mutableMapOf<Int, Int>()
            var bytes = 4096
            for (index in all.indices) {
                if (index !in selected) continue
                val target = all[index]
                val id = targets.size
                val descriptor = description(target.node, id, if (index == 0) -1 else ids.getValue(parents[index]))
                bytes += descriptor.toString().toByteArray().size + 1
                if (bytes > 524276) {
                    reasons.add("bytes")
                    break
                }
                nodes.put(descriptor)
                targets.add(target.copy(signature = signature(target.node)))
                ids[index] = id
            }
            if (targets.isEmpty()) {
                all.forEach { it.node.recycle() }
                return null
            }
            val token = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 255) }
            val result =
                JSONObject()
                    .put("observation", token)
                    .put("expiresInMs", 30000)
                    .put("truncated", reasons.isNotEmpty())
                    .put("nodes", nodes)
            if (extended) {
                result
                    .put("scope", if (query) "query" else "window")
                    .put("windowId", window)
                    .put(
                        "packageName",
                        root.packageName
                            ?.toString()
                            .orEmpty()
                            .take(256),
                    ).put("visitedNodes", visited)
                    .put("limitReasons", JSONArray(reasons.toList()))
                if (query) result.put("matches", JSONArray(matched.mapNotNull { ids[it] }))
            }
            val payload = result.toString().toByteArray()
            if (payload.size > 524276) {
                all.forEach { it.node.recycle() }
                return null
            }
            all.forEachIndexed { index, target -> if (index !in ids) target.node.recycle() }
            observation = Observation(owner, token, window, SystemClock.elapsedRealtime(), targets)
            return payload
        } catch (_: Exception) {
            if (!traversalStarted) root.recycle()
            all.forEach { it.node.recycle() }
            return null
        }
    }

    @Suppress("DEPRECATION")
    fun act(
        owner: Any,
        command: ControlCommand,
        root: AccessibilityNodeInfo,
        allowed: () -> Boolean,
    ): Int {
        val old = observation
        observation = null // Consume even a refused action; never replay an uncertain target.
        var node: AccessibilityNodeInfo? = root
        try {
            if (old == null ||
                old.owner !== owner ||
                old.token != command.observation ||
                old.window != root.windowId ||
                SystemClock.elapsedRealtime() - old.at !in 0 until 30000
            ) {
                return 2
            }
            return SemanticGuard.perform(resolve = {
                if (!root.refresh() || root.isPassword) return 2
                val target = old.targets.getOrNull(command.values[0]) ?: return 2
                for (index in target.path) {
                    val ancestor = node ?: return 2
                    if (!ancestor.refresh() || ancestor.isPassword) return 2
                    node = ancestor.getChild(index)
                    ancestor.recycle()
                    if (node == null) return 2
                }
                val current = node ?: return 2
                if (target.signature == null ||
                    !current.refresh() ||
                    current != target.node ||
                    signature(current) != target.signature
                ) {
                    return 2
                }
                if (!current.isVisibleToUser || !current.isEnabled || current.isPassword) return 4
                val action =
                    when (command.op) {
                        21 -> AccessibilityNodeInfo.ACTION_CLICK
                        22 ->
                            if (command.values[1] ==
                                1
                            ) {
                                AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
                            } else {
                                AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                            }
                        23 -> AccessibilityNodeInfo.ACTION_SET_TEXT
                        else -> return 4
                    }
                if (current.actionList.none { it.id == action } || (command.op == 23 && !current.isEditable)) return 4
                val args =
                    if (command.op == 23) {
                        Bundle().apply {
                            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, command.text)
                        }
                    } else {
                        null
                    }
                Triple(current, action, args)
            }, allowed = allowed, action = { (current, action, args) ->
                if (current.performAction(action, args)) 0 else 4
            })
        } catch (_: Exception) {
            return 4
        } finally {
            node?.recycle()
            old?.targets?.forEach { it.node.recycle() }
        }
    }
}
