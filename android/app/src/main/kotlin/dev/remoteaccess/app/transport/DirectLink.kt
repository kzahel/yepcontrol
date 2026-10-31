package dev.remoteaccess.app.transport

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import dev.remoteaccess.app.control.ControlSession
import dev.remoteaccess.protocol.Authority
import dev.remoteaccess.protocol.Channel
import dev.remoteaccess.protocol.ControlCommand
import dev.remoteaccess.protocol.Identity
import dev.remoteaccess.protocol.PhoneHandshake
import dev.remoteaccess.protocol.RecordAssembler
import dev.remoteaccess.protocol.RecordFraming
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Single worker owns native WebRTC and a fresh cryptographic lane. Never dispose inside an RTC callback. */
internal class DirectLink(
    private val context: Context,
    private val identity: Identity,
    private val grant: JSONObject,
    private val current: () -> Boolean,
    private val activated: () -> Unit,
) {
    private val active = AtomicBoolean(true)
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var peer: PeerConnection? = null
    private var data: DataChannel? = null
    private var handshake: PhoneHandshake? = null
    private var channel: Channel? = null
    private var control: ControlSession? = null
    private val assembler = RecordAssembler()
    private var answer: ((String?) -> Unit)? = null
    private var localReady = false

    @Volatile private var established = false

    private fun valid() = active.get() && current()

    private fun post(work: () -> Unit) {
        enqueue(work)
    }

    private fun enqueue(work: () -> Unit): Boolean =
        runCatching {
            worker.execute {
                if (active.get()) {
                    try {
                        work()
                    } catch (_: Exception) {
                        close()
                    } catch (_: LinkageError) {
                        close()
                    }
                }
            }
        }.isSuccess

    fun offer(
        sdp: String,
        reply: (String?) -> Unit,
    ) = post {
        check(valid() && sdp.length in 1..32768 && sdp.startsWith("v=0\r\n"))
        answer = reply
        val configuration =
            PeerConnection.RTCConfiguration(
                listOf(PeerConnection.IceServer.builder("stun:stun.l.google.com:19302").createIceServer()),
            )
        val observer =
            object : PeerConnection.Observer {
                override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

                override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
                    if (state == PeerConnection.IceConnectionState.FAILED || state == PeerConnection.IceConnectionState.CLOSED) close()
                }

                override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

                override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                    if (state == PeerConnection.IceGatheringState.COMPLETE) post { finishAnswer() }
                }

                override fun onIceCandidate(candidate: IceCandidate) = Unit

                override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit

                override fun onAddStream(stream: MediaStream) = Unit

                override fun onRemoveStream(stream: MediaStream) = Unit

                override fun onRenegotiationNeeded() = Unit

                override fun onDataChannel(channel: DataChannel) = post { attach(channel) }
            }
        val connection = checkNotNull(factory(context).createPeerConnection(configuration, observer))
        peer = connection
        connection.setRemoteDescription(
            sdpObserver(set = {
                connection.createAnswer(
                    sdpObserver(created = { description ->
                        connection.setLocalDescription(
                            sdpObserver(set = {
                                localReady = true
                                if (connection.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) finishAnswer()
                            }),
                            description,
                        )
                    }),
                    MediaConstraints(),
                )
            }),
            SessionDescription(SessionDescription.Type.OFFER, sdp),
        )
        main.postDelayed({ post { finishAnswer() } }, 1800)
        main.postDelayed({ if (!established) close() }, 7000)
        main.postDelayed(
            object : Runnable {
                override fun run() {
                    if (!active.get()) return
                    post { if (!valid() || assembler.expired(SystemClock.elapsedRealtime())) close() }
                    main.postDelayed(this, 500)
                }
            },
            500,
        )
    }

    private fun sdpObserver(
        created: (SessionDescription) -> Unit = {},
        set: () -> Unit = {},
    ) = object : SdpObserver {
        override fun onCreateSuccess(sdp: SessionDescription) = post { created(sdp) }

        override fun onSetSuccess() = post(set)

        override fun onCreateFailure(error: String) {
            close()
        }

        override fun onSetFailure(error: String) {
            close()
        }
    }

    private fun finishAnswer() {
        if (!localReady) return
        val callback = answer ?: return
        answer = null
        val sdp = peer?.localDescription?.description
        if (sdp == null || sdp.length > 32768 || !valid()) {
            callback(null)
            close()
        } else {
            callback(sdp)
        }
    }

    private fun attach(dc: DataChannel) {
        check(data == null && dc.label() == "remote-records" && valid())
        data = dc
        dc.registerObserver(
            object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit

                override fun onStateChange() {
                    if (dc.state() == DataChannel.State.CLOSED || dc.state() == DataChannel.State.CLOSING) close()
                }

                override fun onMessage(buffer: DataChannel.Buffer) {
                    if (!buffer.binary || buffer.data.remaining() !in 13..16396) {
                        close()
                        return
                    }
                    val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                    post { assembler.accept(bytes, SystemClock.elapsedRealtime())?.let(::receive) }
                }
            },
        )
    }

    private fun send(bytes: ByteArray) {
        check(valid())
        val dc = checkNotNull(data)
        check(dc.state() == DataChannel.State.OPEN && dc.bufferedAmount() + bytes.size <= 1048640)
        RecordFraming.fragment(bytes).forEach { check(dc.send(DataChannel.Buffer(ByteBuffer.wrap(it), true))) }
    }

    private fun receive(record: ByteArray) {
        check(valid())
        val secure = channel
        if (secure == null) {
            val pending = handshake
            if (pending == null) {
                val auth =
                    Authority(
                        hex(grant.getString("id")),
                        1,
                        android.util.Base64.decode(grant.getString("viewer"), android.util.Base64.NO_WRAP),
                    ) {
                        valid()
                    }
                handshake = PhoneHandshake.start(identity, auth, record).also { send(it.offer) }
            } else {
                val result = pending.finish(record)
                channel = result.second
                send(result.first)
                established = true
                activated()
            }
        } else {
            val plaintext = secure.open(record)
            try {
                if (control == null) {
                    check(ControlCommand.decode(plaintext).op == 1)
                    control =
                        ControlSession(
                            context,
                            grant.getString("id"),
                            ::valid,
                            { bytes -> send(secure.seal(bytes)) },
                            scheduler = ::enqueue,
                            onOutputFailure = ::close,
                        )
                }
                checkNotNull(control).receive(plaintext)
            } finally {
                plaintext.fill(0)
            }
        }
    }

    fun close() {
        if (!active.compareAndSet(true, false)) return
        runCatching {
            worker.execute {
                answer?.invoke(null)
                answer = null
                control?.close()
                channel?.close()
                handshake?.close()
                data?.unregisterObserver()
                data?.close()
                data?.dispose()
                peer?.dispose()
                main.removeCallbacksAndMessages(null)
                worker.shutdown()
            }
        }
    }

    companion object {
        private var factory: PeerConnectionFactory? = null

        @Synchronized private fun factory(context: Context): PeerConnectionFactory {
            factory?.let { return it }
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions
                    .builder(context.applicationContext)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
            org.webrtc.Logging.enableLogToDebugOutput(org.webrtc.Logging.Severity.LS_ERROR)
            return PeerConnectionFactory.builder().createPeerConnectionFactory().also { factory = it }
        }

        private fun hex(value: String) = value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
}
