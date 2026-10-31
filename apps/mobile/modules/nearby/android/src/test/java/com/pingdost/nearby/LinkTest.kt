package com.pingdost.nearby

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Two [Link]s over an in-memory loopback: every write completes after its frame arrives. */
class LinkTest {
  private val events = ArrayDeque<() -> Unit>()

  private fun run() {
    var steps = 0
    while (events.isNotEmpty()) {
      events.removeFirst()()
      check(++steps < 5_000_000) { "the loopback never went quiet" }
    }
  }

  private inner class Side(val name: String, val token: ByteArray) : LinkListener {
    lateinit var link: Link
    val received = ArrayList<ByteArray>()
    var failure: String? = null
    var hellos = 0
    var takeImmediately = true

    override fun onHello(link: Link) {
      hellos++
    }

    override fun onPacket(link: Link, packet: ByteArray) {
      received.add(packet)
      if (takeImmediately) events.addLast { link.returnCredits(1) }
    }

    override fun onPeerToken(link: Link) {}

    override fun onFailure(link: Link, reason: String) {
      failure = reason
    }
  }

  private fun token(seed: Int) = ByteArray(Frames.TOKEN_BYTES) { (seed + it).toByte() }

  private fun pair(mtu: Int = 517, initialCredits: Int = Link.INITIAL_CREDITS): Pair<Side, Side> {
    val a = Side("a", token(1))
    val b = Side("b", token(100))
    fun sink(from: () -> Side, to: () -> Side) = FrameSink { frame ->
      events.addLast { to().link.onFrame(frame) }
      events.addLast { from().link.onWriteComplete(true) }
      true
    }
    a.link = Link(1, Role.CENTRAL, "b", a.token, sink({ a }, { b }), a, initialCredits = initialCredits)
    b.link = Link(2, Role.PERIPHERAL, "a", b.token, sink({ b }, { a }), b, initialCredits = initialCredits)
    a.link.mtu = mtu
    b.link.mtu = mtu
    b.link.start()
    a.link.start()
    run()
    return a to b
  }

  private fun sendAll(link: Link, packets: List<ByteArray>): MutableList<String?> {
    val results = ArrayList<String?>()
    packets.forEach { link.send(it) { error -> results.add(error) } }
    return results
  }

  private fun packet(size: Int, seed: Int) = ByteArray(size) { (it + seed).toByte() }

  @Test
  fun helloBringsBothSidesUp() {
    val (a, b) = pair()
    assertTrue(a.link.up && b.link.up)
    assertEquals(1, a.hellos)
    assertEquals(1, b.hellos)
    assertTrue(a.link.knowsToken(b.token))
    assertTrue(b.link.knowsToken(a.token))
    assertEquals(Link.MAX_PACKET, a.link.peerMaxPacket)
  }

  @Test
  fun packetsArriveIntactAndInOrderBothWays() {
    for (mtu in listOf(23, 185, 517)) {
      val (a, b) = pair(mtu)
      val sizes = listOf(0, 1, 500, 4096, 65_536, Link.MAX_PACKET, 3)
      val toB = sizes.mapIndexed { i, size -> packet(size, i) }
      val toA = sizes.reversed().mapIndexed { i, size -> packet(size, 50 + i) }
      val sentA = sendAll(a.link, toB)
      val sentB = sendAll(b.link, toA)
      run()
      assertTrue(sentA.all { it == null } && sentB.all { it == null })
      assertEquals(toB.size, b.received.size)
      toB.indices.forEach { assertArrayEquals("mtu $mtu packet $it", toB[it], b.received[it]) }
      toA.indices.forEach { assertArrayEquals("mtu $mtu packet $it", toA[it], a.received[it]) }
      assertEquals(toB.sumOf { it.size }.toLong(), a.link.bytesSent)
      assertEquals(0L, a.link.outboundBytes)
      assertNull(a.failure ?: b.failure)
    }
  }

  @Test
  fun sendRefusesBeforeUpAndOverTheLimit() {
    val idle = Link(9, Role.CENTRAL, "x", token(5), { true }, Side("x", token(5)))
    var error: String? = null
    idle.send(ByteArray(1)) { error = it }
    assertEquals("not_up", error)

    val (a, _) = pair()
    a.link.send(ByteArray(Link.MAX_PACKET + 1)) { error = it }
    assertEquals("too_large", error)
  }

  @Test
  fun aReceiverThatDoesNotTakePacketsStallsTheSender() {
    val (a, b) = pair()
    b.takeImmediately = false
    val results = sendAll(a.link, List(20) { packet(100, it) })
    run()
    assertEquals(Link.INITIAL_CREDITS, b.received.size)
    assertEquals(20, results.size) // all fit in the outbound queue
    assertEquals(12, a.link.unsent)

    // Fewer than a batch taken: no credit goes back yet.
    b.link.returnCredits(Link.CREDIT_BATCH - 1)
    run()
    assertEquals(Link.INITIAL_CREDITS, b.received.size)

    b.link.returnCredits(Link.INITIAL_CREDITS - Link.CREDIT_BATCH + 1)
    run()
    assertEquals(16, b.received.size)
    b.link.returnCredits(Link.INITIAL_CREDITS)
    run()
    assertEquals(20, b.received.size)
    assertEquals(0, a.link.unsent)
  }

  @Test
  fun aFullOutboundQueueMakesSendWait() {
    val (a, b) = pair()
    b.takeImmediately = false
    val results = sendAll(a.link, List(14) { packet(Link.MAX_PACKET, it) })
    run()
    // 8 sent on credit; 4 × 128 KiB fill the 512 KiB queue; 2 wait for room.
    assertEquals(Link.INITIAL_CREDITS, b.received.size)
    assertEquals(12, results.size)
    assertEquals(Link.OUTBOUND_CAP_BYTES, a.link.outboundBytes)

    b.link.returnCredits(Link.INITIAL_CREDITS)
    run()
    assertEquals(14, results.size)
    assertTrue(results.all { it == null })
    b.link.returnCredits(Link.INITIAL_CREDITS)
    run()
    assertEquals(14, b.received.size)
  }

  @Test
  fun closingFailsWaitingSends() {
    val (a, b) = pair()
    b.takeImmediately = false
    val results = sendAll(a.link, List(14) { packet(Link.MAX_PACKET, it) })
    run()
    a.link.close()
    assertEquals(14, results.size)
    assertEquals(listOf("link_down", "link_down"), results.takeLast(2))
    var after: String? = null
    a.link.send(ByteArray(1)) { after = it }
    assertEquals("link_down", after)
  }

  @Test
  fun aPeerThatIgnoresCreditsIsCutOff() {
    val listener = Side("rx", token(7))
    val receiver = Link(3, Role.PERIPHERAL, "rogue", listener.token, { true }, listener, initialCredits = 1)
    listener.link = receiver
    receiver.start()
    receiver.onFrame(Frames.encodeHello(Hello(Frames.VERSION, token(8), Link.MAX_PACKET, 8)))
    receiver.onFrame(PacketWriter(ByteArray(1)).next(0, 20))
    assertNull(listener.failure)
    receiver.onFrame(PacketWriter(ByteArray(1)).next(1, 20))
    assertEquals("protocol: packet without credit", listener.failure)
    assertTrue(receiver.closed)
  }

  @Test
  fun dataBeforeHelloAndAWrongVersionFail() {
    val early = Side("e", token(9))
    early.link = Link(4, Role.PERIPHERAL, "p", early.token, { true }, early)
    early.link.onFrame(PacketWriter(ByteArray(1)).next(0, 20))
    assertEquals("protocol: DATA before HELLO", early.failure)

    val old = Side("o", token(10))
    old.link = Link(5, Role.PERIPHERAL, "p", old.token, { true }, old)
    old.link.onFrame(Frames.encodeHello(Hello(2, token(11), 100, 1)))
    assertEquals("protocol: unsupported version 2", old.failure)
  }

  @Test
  fun aRotatedTokenReachesThePeer() {
    val (a, b) = pair()
    val next = token(42)
    a.link.announceToken(next)
    run()
    assertTrue(b.link.knowsToken(next))
    assertTrue(b.link.knowsToken(a.token))
  }
}
