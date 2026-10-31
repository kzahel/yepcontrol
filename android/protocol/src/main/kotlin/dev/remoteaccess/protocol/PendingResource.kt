package dev.remoteaccess.protocol

/** Worker-confined ownership of an asynchronous open. Release waits for the actual close callback. */
class PendingResource<T : Any>(
    private val close: (T) -> Unit,
) {
    private var pending = false
    private var handle: T? = null
    private var closing = false
    private var closeRequested = false
    private var complete = false
    private var finished: (() -> Unit)? = null

    fun starting() {
        check(!pending && handle == null && !closing && !complete)
        pending = true
    }

    fun arrived(
        value: T,
        allowed: Boolean,
    ): Boolean {
        if (complete) {
            close(value)
            return false
        }
        check(handle == null || handle === value)
        pending = false
        handle = value
        if (closing || !allowed) {
            requestClose()
            return false
        }
        return true
    }

    fun failed() {
        pending = false
        finishIfReleased()
    }

    fun closed(value: T) {
        if (handle !== value) return
        handle = null
        finishIfReleased()
    }

    fun release(done: () -> Unit) {
        check(!closing)
        closing = true
        finished = done
        requestClose()
        finishIfReleased()
    }

    private fun requestClose() {
        val value = handle ?: return
        if (!closeRequested) {
            closeRequested = true
            close(value)
        }
    }

    private fun finishIfReleased() {
        if (closing && !pending && handle == null && !complete) {
            complete = true
            finished?.let {
                finished = null
                it()
            }
        }
    }
}
