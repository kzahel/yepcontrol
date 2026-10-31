package dev.remoteaccess.protocol

/** Rotate a strided sample plane, preserving padding and the other interleaved chroma plane. */
object YuvPlane {
    fun rotate(
        source: ByteArray,
        sourceRow: Int,
        sourcePixel: Int,
        target: ByteArray,
        targetRow: Int,
        targetPixel: Int,
        width: Int,
        height: Int,
        degrees: Int,
    ) {
        require(width in 1..1280 && height in 1..1280 && degrees in listOf(0, 90, 180, 270))
        val targetWidth = if (degrees % 180 == 0) width else height
        val targetHeight = if (degrees % 180 == 0) height else width
        require(sourcePixel > 0 && sourceRow >= (width - 1) * sourcePixel + 1)
        require(targetPixel > 0 && targetRow >= (targetWidth - 1) * targetPixel + 1)
        require((height - 1L) * sourceRow + (width - 1L) * sourcePixel < source.size)
        require((targetHeight - 1L) * targetRow + (targetWidth - 1L) * targetPixel < target.size)
        for (y in 0 until height) {
            for (x in 0 until width) {
                val tx =
                    when (degrees) {
                        90 -> height - y - 1
                        180 -> width - x - 1
                        270 -> y
                        else -> x
                    }
                val ty =
                    when (degrees) {
                        90 -> x
                        180 -> height - y - 1
                        270 -> width - x - 1
                        else -> y
                    }
                target[ty * targetRow + tx * targetPixel] = source[y * sourceRow + x * sourcePixel]
            }
        }
    }
}
