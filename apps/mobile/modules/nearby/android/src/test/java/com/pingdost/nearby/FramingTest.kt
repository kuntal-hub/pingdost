package com.pingdost.nearby

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class FramingTest {
  private val token = ByteArray(Frames.TOKEN_BYTES) { (it * 31 + 7).toByte() }

  private fun packet(size: Int) = ByteArray(size) { (it * 13 + size).toByte() }

  private fun frames(data: ByteArray, capacity: Int, firstSeq: Int = 0): List<ByteArray> {
    val writer = PacketWriter(data)
    val out = ArrayList<ByteArray>()
    var seq = firstSeq
    while (!writer.done) out.add(writer.next(seq++, capacity))
    return out
  }

  private fun expectFailure(message: String, block: () -> Unit) {
    try {
      block()
      fail("expected a FrameException containing \"$message\"")
    } catch (error: FrameException) {
      assertTrue("${error.message}", error.message!!.contains(message))
    }
  }

  @Test
  fun controlFramesRoundTrip() {
    val hello = Frames.decodeControl(Frames.encodeHello(Hello(1, token, 131072, 8))) as Control.HelloFrame
    assertEquals(1, hello.hello.version)
    assertArrayEquals(token, hello.hello.token)
    assertEquals(131072, hello.hello.maxPacket)
    assertEquals(8, hello.hello.credits)
    assertEquals(Frames.HELLO_SIZE, Frames.encodeHello(Hello(1, token, 1, 1)).size)

    assertEquals(65535, (Frames.decodeControl(Frames.encodeCredit(65535)) as Control.Credit).packets)
    assertArrayEquals(token, (Frames.decodeControl(Frames.encodeToken(token)) as Control.Token).token)
  }

  @Test
  fun badControlFramesAreRejected() {
    expectFailure("empty") { Frames.decodeControl(ByteArray(0)) }
    expectFailure("unknown frame type") { Frames.decodeControl(byteArrayOf(0x7f)) }
    expectFailure("bad HELLO size") { Frames.decodeControl(Frames.encodeHello(Hello(1, token, 1, 1)).copyOf(10)) }
    expectFailure("CREDIT of zero") { Frames.decodeControl(byteArrayOf(Frames.CREDIT, 0, 0)) }
    expectFailure("bad TOKEN size") { Frames.decodeControl(byteArrayOf(Frames.TOKEN, 1, 2)) }
  }

  @Test
  fun packetsSurviveEveryFrameSize() {
    // 20 = the default ATT MTU (23) − 3; 514 = MTU 517 − 3.
    for (capacity in listOf(20, 100, 244, 514)) {
      val reassembler = Reassembler(Link.MAX_PACKET)
      var seq = 0
      for (size in listOf(0, 1, 11, 12, 13, 500, 4096, Link.MAX_PACKET)) {
        val data = packet(size)
        val parts = frames(data, capacity, seq)
        seq = (seq + parts.size) and 0xffff
        parts.forEach { assertTrue("frame of ${it.size} > $capacity", it.size <= capacity) }
        val results = parts.map { reassembler.accept(it) }
        results.dropLast(1).forEach { assertNull(it) }
        assertArrayEquals("size $size at capacity $capacity", data, results.last())
      }
    }
  }

  @Test
  fun firstFrameCarriesTheLength() {
    val parts = frames(packet(30), 20)
    assertEquals(Frames.FLAG_FIRST, parts[0][1].toInt())
    assertEquals(30, Frames.getInt(parts[0], Frames.DATA_HEADER))
    assertEquals(Frames.FLAG_LAST, parts.last()[1].toInt())
    // An empty packet is one frame that is both first and last.
    val empty = frames(ByteArray(0), 20).single()
    assertEquals(Frames.FLAG_FIRST or Frames.FLAG_LAST, empty[1].toInt())
  }

  @Test
  fun sequenceWrapsAt16Bits() {
    val reassembler = Reassembler(16)
    for (seq in 0 until 70_000) {
      val frame = PacketWriter(ByteArray(1)).next(seq, 20)
      assertEquals(1, reassembler.accept(frame)!!.size)
    }
  }

  @Test
  fun gapsAndRepeatsFailTheLink() {
    val parts = frames(packet(100), 20)
    val skipped = Reassembler(Link.MAX_PACKET)
    skipped.accept(parts[0])
    expectFailure("sequence gap") { skipped.accept(parts[2]) }

    val repeated = Reassembler(Link.MAX_PACKET)
    repeated.accept(parts[0])
    expectFailure("sequence gap") { repeated.accept(parts[0]) }
  }

  @Test
  fun malformedPacketsAreRejected() {
    expectFailure("over the limit") { Reassembler(10).accept(frames(packet(11), 20)[0]) }
    expectFailure("continuation without a first") { Reassembler(100).accept(frames(packet(40), 20)[1].also { it[2] = 0; it[3] = 0 }) }
    expectFailure("reserved DATA flags") {
      Reassembler(100).accept(frames(packet(5), 20)[0].also { it[1] = (it[1].toInt() or 0x80).toByte() })
    }
    expectFailure("not a DATA frame") { Reassembler(100).accept(byteArrayOf(Frames.CREDIT, 0, 1, 0)) }

    // A first fragment that announces 5 bytes but carries 6.
    val long = frames(packet(6), 20)[0].also { Frames.putInt(it, Frames.DATA_HEADER, 5) }
    expectFailure("longer than announced") { Reassembler(100).accept(long) }
    // The last fragment arrives before the announced length is complete.
    val short = frames(packet(5), 20)[0].also { Frames.putInt(it, Frames.DATA_HEADER, 9) }
    expectFailure("shorter than announced") { Reassembler(100).accept(short) }
    // A new first fragment while a packet is half received.
    val half = Reassembler(100)
    half.accept(frames(packet(40), 20)[0])
    expectFailure("before the previous one ended") { half.accept(frames(packet(4), 20, firstSeq = 1)[0]) }
  }
}
