package com.pingdost.nearby

enum class Role(val label: String) {
  /** We are the GATT client: we write to the peer's RX, it notifies on its TX. */
  CENTRAL("central"),

  /** We are the GATT server: the peer writes to our RX, we notify on our TX. */
  PERIPHERAL("peripheral"),
}

/** Puts one frame on the air. Returns false if it could not be started at all. */
fun interface FrameSink {
  fun write(frame: ByteArray): Boolean
}

interface LinkListener {
  /** The peer's HELLO arrived (the link is up once ours is queued too). */
  fun onHello(link: Link)

  fun onPacket(link: Link, packet: ByteArray)

  /** The peer announced a new advertised token over the link. */
  fun onPeerToken(link: Link)

  /** A protocol or write error: the engine tears the connection down. */
  fun onFailure(link: Link, reason: String)
}

/**
 * One BLE link's framing state: outbound packet queue with backpressure, per-link sequence,
 * credit flow control and reassembly (see [Frames]). Not thread-safe: the engine calls it only
 * on its own handler thread. It knows nothing about GATT, so tests drive two links over a
 * loopback.
 */
class Link(
  val id: Int,
  val role: Role,
  val address: String,
  /** The token we put in our HELLO (the advertised one at link start). */
  val localToken: ByteArray,
  private val sink: FrameSink,
  private val listener: LinkListener,
  val maxPacket: Int = MAX_PACKET,
  private val initialCredits: Int = INITIAL_CREDITS,
) {
  companion object {
    /** Largest packet either side accepts: a 64 KiB envelope or file chunk plus headers. */
    const val MAX_PACKET = 128 * 1024

    /** Packets a sender may start before the receiver's app has taken any. */
    const val INITIAL_CREDITS = 8

    /** Credits are returned in batches of this many (≤ [INITIAL_CREDITS], so no deadlock). */
    const val CREDIT_BATCH = 4

    /** Bytes queued per link before `send` waits for room. */
    const val OUTBOUND_CAP_BYTES = 512L * 1024

    /** `send` calls that may wait for room; more fail with `queue_full`. */
    const val MAX_WAITING = 64

    private const val MAX_TOKENS = 4
  }

  var mtu = Frames.DEFAULT_MTU
  var txPhy = 1
  var rxPhy = 1
  val createdAt: Long = System.currentTimeMillis()
  var upAt = 0L

  /** Tokens the peer has used on this link, newest last. */
  val peerTokens = ArrayList<ByteArray>()
  var peerMaxPacket = 0
    private set

  var helloSent = false
    private set
  var helloReceived = false
    private set
  var closed = false
    private set

  val up: Boolean
    get() = helloSent && helloReceived && !closed

  // Statistics (payload bytes of whole packets, and frames on the air).
  var packetsSent = 0L
    private set
  var packetsReceived = 0L
    private set
  var bytesSent = 0L
    private set
  var bytesReceived = 0L
    private set
  var framesSent = 0L
    private set
  var framesReceived = 0L
    private set

  private val control = ArrayDeque<ByteArray>()
  private val outbound = ArrayDeque<ByteArray>()
  private val waiting = ArrayDeque<Pair<ByteArray, (String?) -> Unit>>()
  var outboundBytes = 0L
    private set
  private var current: PacketWriter? = null
  private var txSeq = 0
  var sendCredits = 0
    private set
  private var writing = false

  private val reassembler = Reassembler(maxPacket)
  /** Credits we granted that the peer has not used yet. */
  private var grantedToPeer = 0
  private var creditsOwed = 0

  /** Packets accepted by `send` but not fully written. */
  val unsent: Int
    get() = outbound.size + waiting.size + (if (current != null) 1 else 0)

  /** Queues our HELLO; call once the peer can receive frames. */
  fun start() {
    if (helloSent || closed) return
    control.addLast(Frames.encodeHello(Hello(Frames.VERSION, localToken, maxPacket, initialCredits)))
    grantedToPeer = initialCredits
    helloSent = true
    pump()
  }

  /**
   * Accepts a packet into the native queue. [done] gets null once it is queued (not delivered),
   * or an error code: `not_up`, `link_down`, `too_large`, `queue_full`.
   */
  fun send(packet: ByteArray, done: (String?) -> Unit) {
    when {
      closed -> done("link_down")
      !up -> done("not_up")
      packet.size > minOf(maxPacket, peerMaxPacket) -> done("too_large")
      waiting.isEmpty() && fits(packet) -> {
        admit(packet)
        done(null)
        pump()
      }
      waiting.size >= MAX_WAITING -> done("queue_full")
      else -> waiting.addLast(packet to done)
    }
  }

  /** One frame from the peer (a GATT write or notification). */
  fun onFrame(frame: ByteArray) {
    if (closed) return
    framesReceived++
    try {
      if (frame.isNotEmpty() && frame[0] == Frames.DATA) {
        if (!helloReceived) throw FrameException("DATA before HELLO")
        val packet = reassembler.accept(frame) ?: return
        if (--grantedToPeer < 0) throw FrameException("packet without credit")
        packetsReceived++
        bytesReceived += packet.size
        listener.onPacket(this, packet)
        return
      }
      when (val parsed = Frames.decodeControl(frame)) {
        is Control.HelloFrame -> {
          val hello = parsed.hello
          if (helloReceived) throw FrameException("second HELLO")
          if (hello.version != Frames.VERSION) throw FrameException("unsupported version ${hello.version}")
          if (hello.maxPacket <= 0 || hello.credits <= 0) throw FrameException("bad HELLO limits")
          peerMaxPacket = hello.maxPacket
          sendCredits = hello.credits
          rememberToken(hello.token)
          helloReceived = true
          listener.onHello(this)
          pump()
        }
        is Control.Credit -> {
          sendCredits += parsed.packets
          if (sendCredits > 0xffff) throw FrameException("credit overflow")
          pump()
        }
        is Control.Token -> {
          rememberToken(parsed.token)
          listener.onPeerToken(this)
        }
      }
    } catch (error: FrameException) {
      fail("protocol: ${error.message}")
    }
  }

  /** The app took [count] of this link's packets from the inbound queue. */
  fun returnCredits(count: Int) {
    if (closed || count <= 0) return
    creditsOwed += count
    if (creditsOwed < CREDIT_BATCH) return
    control.addLast(Frames.encodeCredit(creditsOwed))
    grantedToPeer += creditsOwed
    creditsOwed = 0
    pump()
  }

  /** Tells the peer our new advertised token, so it does not connect to us twice. */
  fun announceToken(token: ByteArray) {
    if (!up) return
    control.addLast(Frames.encodeToken(token))
    pump()
  }

  /** The stack is ready for the next frame (write or notification callback). */
  fun onWriteComplete(ok: Boolean) {
    writing = false
    if (closed) return
    if (!ok) {
      fail("write failed")
      return
    }
    pump()
  }

  fun knowsToken(token: ByteArray): Boolean = peerTokens.any { it.contentEquals(token) }

  /** Marks the link closed and fails every waiting `send`. No listener call. */
  fun close() {
    if (closed) return
    closed = true
    while (waiting.isNotEmpty()) waiting.removeFirst().second("link_down")
  }

  private fun fail(reason: String) {
    if (closed) return
    listener.onFailure(this, reason)
    close()
  }

  private fun rememberToken(token: ByteArray) {
    if (knowsToken(token)) return
    peerTokens.add(token)
    if (peerTokens.size > MAX_TOKENS) peerTokens.removeAt(0)
  }

  private fun fits(packet: ByteArray) =
    outboundBytes == 0L || outboundBytes + packet.size <= OUTBOUND_CAP_BYTES

  private fun admit(packet: ByteArray) {
    outbound.addLast(packet)
    outboundBytes += packet.size
  }

  private fun admitWaiting() {
    while (waiting.isNotEmpty() && fits(waiting.first().first)) {
      val (packet, done) = waiting.removeFirst()
      admit(packet)
      done(null)
    }
  }

  private fun pump() {
    if (writing || closed) return
    val frame = control.removeFirstOrNull() ?: nextDataFrame() ?: return
    writing = true
    framesSent++
    // The stack can refuse by throwing: without this the link would stay up and never send again.
    val started = try {
      sink.write(frame)
    } catch (_: RuntimeException) {
      false
    }
    if (!started) {
      writing = false
      fail("write refused")
    }
  }

  private fun nextDataFrame(): ByteArray? {
    if (!helloReceived) return null
    var writer = current
    if (writer == null) {
      if (sendCredits == 0) return null
      val packet = outbound.removeFirstOrNull() ?: return null
      sendCredits--
      writer = PacketWriter(packet)
      current = writer
    }
    val frame = writer.next(txSeq, Frames.frameCapacity(mtu))
    txSeq = (txSeq + 1) and 0xffff
    if (writer.done) {
      current = null
      packetsSent++
      bytesSent += writer.data.size
      outboundBytes -= writer.data.size
      admitWaiting()
    }
    return frame
  }
}
