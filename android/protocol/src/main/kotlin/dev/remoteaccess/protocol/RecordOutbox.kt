package dev.remoteaccess.protocol

/** Plaintext stays bounded before the lane's sole cryptographic writer. Control never queues behind media. */
class RecordOutbox {
    private data class Entry(
        val bytes: ByteArray,
        val stream: Int = 0,
    )

    private val priority = ArrayDeque<Entry>()
    private val media = ArrayDeque<Entry>()
    private var priorityBytes = 0
    private var mediaBytes = 0
    private var closed = false

    @Synchronized fun control(bytes: ByteArray): Boolean {
        if (closed || bytes.size > 1048576 || priority.size >= 16 || priorityBytes + bytes.size > 2097152) return false
        priority.addLast(Entry(bytes))
        priorityBytes += bytes.size
        return true
    }

    @Synchronized fun media(record: MediaRecord): Boolean {
        if (closed) return false
        val bytes = record.encode()
        if (record.kind == 4) {
            if (record.data[0].toInt() >= 2) {
                val iterator = media.iterator()
                while (iterator.hasNext()) {
                    val entry = iterator.next()
                    if (entry.stream == record.stream) {
                        mediaBytes -= entry.bytes.size
                        entry.bytes.fill(0)
                        iterator.remove()
                    }
                }
            }
            return control(bytes)
        }
        if (media.size >= 12 || mediaBytes + bytes.size > 1048576) {
            bytes.fill(0)
            return false
        }
        media.addLast(Entry(bytes, record.stream))
        mediaBytes += bytes.size
        return true
    }

    @Synchronized fun poll(): ByteArray? {
        priority.removeFirstOrNull()?.let {
            priorityBytes -= it.bytes.size
            return it.bytes
        }
        media.removeFirstOrNull()?.let {
            mediaBytes -= it.bytes.size
            return it.bytes
        }
        return null
    }

    @Synchronized fun pending() = priority.isNotEmpty() || media.isNotEmpty()

    @Synchronized fun close() {
        closed = true
        priority.forEach { it.bytes.fill(0) }
        media.forEach { it.bytes.fill(0) }
        priority.clear()
        media.clear()
        priorityBytes = 0
        mediaBytes = 0
    }
}
