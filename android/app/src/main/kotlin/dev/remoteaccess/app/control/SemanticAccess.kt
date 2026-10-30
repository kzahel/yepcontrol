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
            .put("node", id)
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

    @Suppress("DEPRECATION")
    fun snapshot(
        owner: Any,
        root: AccessibilityNodeInfo,
    ): ByteArray? {
        clear()
        val nodes = JSONArray()
        val targets = mutableListOf<Target>()
        var truncated = false
        var visited = 0
        var lookups = 0

        fun visit(
            node: AccessibilityNodeInfo,
            parent: Int,
            path: List<Int>,
        ) {
            if (++visited > 128 || path.size > 20) {
                truncated = true
                node.recycle()
                return
            }
            if (!node.isVisibleToUser) {
                node.recycle()
                return
            }
            val id = targets.size
            nodes.put(description(node, id, parent))
            targets.add(Target(path, node, signature(node)))
            // A password container's descendants can expose its text too.
            if (node.isPassword) return
            for (index in 0 until node.childCount) {
                if (visited >= 128 || lookups++ >= 256) {
                    truncated = true
                    break
                }
                node.getChild(index)?.let { visit(it, id, path + index) }
            }
        }
        val window = root.windowId
        try {
            visit(root, -1, emptyList())
            if (targets.isEmpty()) return null
            val token = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it.toInt() and 255) }
            val payload =
                JSONObject()
                    .put(
                        "observation",
                        token,
                    ).put("expiresInMs", 30000)
                    .put("truncated", truncated)
                    .put("nodes", nodes)
                    .toString()
                    .toByteArray()
            if (payload.size > 524276) {
                targets.forEach { it.node.recycle() }
                return null
            }
            observation = Observation(owner, token, window, SystemClock.elapsedRealtime(), targets)
            return payload
        } catch (_: Exception) {
            targets.forEach { it.node.recycle() }
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
