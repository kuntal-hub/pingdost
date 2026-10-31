package com.pingdost.nearby

/**
 * Link framing (Phase 21, ADR 0023). Every GATT write or notification carries exactly one
 * frame of at most (ATT MTU − 3) bytes. Integers are big-endian.
 *
 * ```
 * HELLO  0x01 | version u8 | token 8 B | maxPacket u32 | credits u16
 * DATA   0x02 | flags u8 (bit 0 first, bit 1 last) | seq u16 | [length u32, first only] | bytes
 * CREDIT 0x03 | packets u16
 * TOKEN  0x04 | token 8 B          (the sender rotated its advertised token)
 * ```
 *
 * - `seq` counts DATA frames per link and direction from 0 and wraps at 2^16. A gap or repeat
 *   means a lost or duplicated frame: the link fails instead of delivering a corrupt packet.
 * - One packet's fragments are never interleaved with another's.
 * - Flow control is per packet: the receiver grants `credits` in HELLO and returns one CREDIT
 *   per packet the app has taken from the native inbound queue. A sender starts a packet only
 *   while it holds a credit, so a slow or suspended receiver stalls the sender instead of
 *   overflowing.
 *
 * This file has no Android dependencies, so it is unit-tested on the JVM.
 */
object Frames {
  const val VERSION = 1

  const val HELLO: Byte = 0x01
  const val DATA: Byte = 0x02
  const val CREDIT: Byte = 0x03
  const val TOKEN: Byte = 0x04

  const val FLAG_FIRST = 0x01
  const val FLAG_LAST = 0x02

  const val TOKEN_BYTES = 8
  const val HELLO_SIZE = 1 + 1 + TOKEN_BYTES + 4 + 2
  const val CREDIT_SIZE = 3
  const val TOKEN_SIZE = 1 + TOKEN_BYTES
  const val DATA_HEADER = 4
  const val FIRST_EXTRA = 4

  /** ATT opcode (1) + attribute handle (2): a write or notification carries MTU − 3 bytes. */
  const val ATT_OVERHEAD = 3
  const val DEFAULT_MTU = 23
  const val REQUESTED_MTU = 517

  fun encodeHello(hello: Hello): ByteArray {
    require(hello.token.size == TOKEN_BYTES) { "token must be $TOKEN_BYTES bytes" }
    val out = ByteArray(HELLO_SIZE)
    out[0] = HELLO
    out[1] = hello.version.toByte()
    System.arraycopy(hello.token, 0, out, 2, TOKEN_BYTES)
    putInt(out, 2 + TOKEN_BYTES, hello.maxPacket)
    putShort(out, 6 + TOKEN_BYTES, hello.credits)
    return out
  }

  fun encodeCredit(packets: Int): ByteArray {
    require(packets in 1..0xffff)
    val out = ByteArray(CREDIT_SIZE)
    out[0] = CREDIT
    putShort(out, 1, packets)
    return out
  }

  fun encodeToken(token: ByteArray): ByteArray {
    require(token.size == TOKEN_BYTES)
    val out = ByteArray(TOKEN_SIZE)
    out[0] = TOKEN
    System.arraycopy(token, 0, out, 1, TOKEN_BYTES)
    return out
  }

  /** Decodes a control frame (anything but DATA). */
  fun decodeControl(frame: ByteArray): Control {
    if (frame.isEmpty()) throw FrameException("empty frame")
    return when (frame[0]) {
      HELLO -> {
        if (frame.size != HELLO_SIZE) throw FrameException("bad HELLO size ${frame.size}")
        Control.HelloFrame(
          Hello(
            version = frame[1].toInt() and 0xff,
            token = frame.copyOfRange(2, 2 + TOKEN_BYTES),
            maxPacket = getInt(frame, 2 + TOKEN_BYTES),
            credits = getShort(frame, 6 + TOKEN_BYTES),
          ),
        )
      }
      CREDIT -> {
        if (frame.size != CREDIT_SIZE) throw FrameException("bad CREDIT size ${frame.size}")
        val packets = getShort(frame, 1)
        if (packets == 0) throw FrameException("CREDIT of zero")
        Control.Credit(packets)
      }
      TOKEN -> {
        if (frame.size != TOKEN_SIZE) throw FrameException("bad TOKEN size ${frame.size}")
        Control.Token(frame.copyOfRange(1, 1 + TOKEN_BYTES))
      }
      else -> throw FrameException("unknown frame type ${frame[0].toInt() and 0xff}")
    }
  }

  fun putInt(out: ByteArray, at: Int, value: Int) {
    out[at] = (value ushr 24).toByte()
    out[at + 1] = (value ushr 16).toByte()
    out[at + 2] = (value ushr 8).toByte()
    out[at + 3] = value.toByte()
  }

  fun getInt(data: ByteArray, at: Int): Int =
    ((data[at].toInt() and 0xff) shl 24) or
      ((data[at + 1].toInt() and 0xff) shl 16) or
      ((data[at + 2].toInt() and 0xff) shl 8) or
      (data[at + 3].toInt() and 0xff)

  fun putShort(out: ByteArray, at: Int, value: Int) {
    out[at] = (value ushr 8).toByte()
    out[at + 1] = value.toByte()
  }

  fun getShort(data: ByteArray, at: Int): Int =
    ((data[at].toInt() and 0xff) shl 8) or (data[at + 1].toInt() and 0xff)
}

class FrameException(message: String) : Exception(message)

class Hello(val version: Int, val token: ByteArray, val maxPacket: Int, val credits: Int)

sealed interface Control {
  class HelloFrame(val hello: Hello) : Control
  class Credit(val packets: Int) : Control
  class Token(val token: ByteArray) : Control
}

/** Cuts one packet into DATA frames, one at a time, so a large packet is never copied twice. */
class PacketWriter(val data: ByteArray) {
  private var offset = 0
  private var started = false

  val done: Boolean
    get() = started && offset >= data.size

  /** The next DATA frame, at most [capacity] bytes (the link's MTU − 3). */
  fun next(seq: Int, capacity: Int): ByteArray {
    check(!done) { "packet already written" }
    val first = !started
    val header = Frames.DATA_HEADER + if (first) Frames.FIRST_EXTRA else 0
    require(capacity > header) { "frame capacity $capacity too small" }
    val take = minOf(capacity - header, data.size - offset)
    val last = offset + take >= data.size
    val frame = ByteArray(header + take)
    frame[0] = Frames.DATA
    frame[1] = ((if (first) Frames.FLAG_FIRST else 0) or (if (last) Frames.FLAG_LAST else 0)).toByte()
    Frames.putShort(frame, 2, seq and 0xffff)
    if (first) Frames.putInt(frame, Frames.DATA_HEADER, data.size)
    System.arraycopy(data, offset, frame, header, take)
    offset += take
    started = true
    return frame
  }
}

/** Rebuilds packets from DATA frames and enforces the per-link sequence and size limit. */
class Reassembler(private val maxPacket: Int) {
  private var expectedSeq = 0
  private var buffer: ByteArray? = null
  private var filled = 0

  /** True while a packet is half received. */
  val partial: Boolean
    get() = buffer != null

  /** Feeds one DATA frame; returns the packet it completes, or null. */
  fun accept(frame: ByteArray): ByteArray? {
    if (frame.size < Frames.DATA_HEADER || frame[0] != Frames.DATA) {
      throw FrameException("not a DATA frame")
    }
    val flags = frame[1].toInt() and 0xff
    if (flags and (Frames.FLAG_FIRST or Frames.FLAG_LAST).inv() != 0) {
      throw FrameException("reserved DATA flags $flags")
    }
    val seq = Frames.getShort(frame, 2)
    if (seq != expectedSeq) throw FrameException("sequence gap: expected $expectedSeq, got $seq")
    expectedSeq = (seq + 1) and 0xffff

    var offset = Frames.DATA_HEADER
    if (flags and Frames.FLAG_FIRST != 0) {
      if (buffer != null) throw FrameException("packet started before the previous one ended")
      if (frame.size < Frames.DATA_HEADER + Frames.FIRST_EXTRA) throw FrameException("short first fragment")
      val length = Frames.getInt(frame, Frames.DATA_HEADER)
      if (length < 0 || length > maxPacket) throw FrameException("packet of $length bytes over the limit")
      buffer = ByteArray(length)
      filled = 0
      offset += Frames.FIRST_EXTRA
    } else if (buffer == null) {
      throw FrameException("continuation without a first fragment")
    }

    val target = buffer!!
    val count = frame.size - offset
    if (filled + count > target.size) throw FrameException("packet longer than announced")
    System.arraycopy(frame, offset, target, filled, count)
    filled += count
    if (flags and Frames.FLAG_LAST == 0) return null
    if (filled != target.size) throw FrameException("packet shorter than announced")
    buffer = null
    return target
  }
}
