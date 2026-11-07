import XCTest

@testable import NearbyCore

/// A port of Android's `LinkTest.kt`: two links over an in-memory loopback, where every write
/// completes after its frame arrives.
final class LinkTests: XCTestCase {
  private var events: [() -> Void] = []

  private func drain() {
    var steps = 0
    var next = 0
    while next < events.count {
      events[next]()
      next += 1
      steps += 1
      precondition(steps < 5_000_000, "the loopback never went quiet")
      if next > 10_000 {
        events.removeFirst(next)
        next = 0
      }
    }
    events.removeAll()
  }

  private final class Side: LinkListener {
    let token: [UInt8]
    var link: Link!
    var received: [[UInt8]] = []
    var failure: String?
    var hellos = 0
    var takeImmediately = true
    weak var owner: LinkTests?

    init(token: [UInt8], owner: LinkTests?) {
      self.token = token
      self.owner = owner
    }

    func onHello(_ link: Link) { hellos += 1 }

    func onPacket(_ link: Link, _ packet: [UInt8]) {
      received.append(packet)
      if takeImmediately { owner?.events.append { link.returnCredits(1) } }
    }

    func onPeerToken(_ link: Link) {}

    func onFailure(_ link: Link, _ reason: String) { failure = reason }
  }

  private func token(_ seed: Int) -> [UInt8] {
    (0..<Frames.tokenBytes).map { UInt8(truncatingIfNeeded: seed + $0) }
  }

  private func pair(mtu: Int = 517, initialCredits: Int = Link.initialCredits) -> (Side, Side) {
    let a = Side(token: token(1), owner: self)
    let b = Side(token: token(100), owner: self)
    func sink(from: Side, to: Side) -> ([UInt8]) -> Bool {
      return { [unowned self, unowned from, unowned to] frame in
        self.events.append { to.link.onFrame(frame) }
        self.events.append { from.link.onWriteComplete(true) }
        return true
      }
    }
    a.link = Link(
      id: 1, role: .central, address: "b", localToken: a.token, sink: sink(from: a, to: b),
      listener: a, initialCredits: initialCredits)
    b.link = Link(
      id: 2, role: .peripheral, address: "a", localToken: b.token, sink: sink(from: b, to: a),
      listener: b, initialCredits: initialCredits)
    a.link.mtu = mtu
    b.link.mtu = mtu
    b.link.start()
    a.link.start()
    drain()
    return (a, b)
  }

  private func sendAll(_ link: Link, _ packets: [[UInt8]]) -> Results {
    let results = Results()
    for packet in packets { link.send(packet) { results.values.append($0) } }
    return results
  }

  private final class Results {
    var values: [String?] = []
  }

  private func packet(_ size: Int, _ seed: Int) -> [UInt8] {
    (0..<size).map { UInt8(truncatingIfNeeded: $0 + seed) }
  }

  func testHelloBringsBothSidesUp() {
    let (a, b) = pair()
    XCTAssertTrue(a.link.up && b.link.up)
    XCTAssertEqual(a.hellos, 1)
    XCTAssertEqual(b.hellos, 1)
    XCTAssertTrue(a.link.knowsToken(b.token))
    XCTAssertTrue(b.link.knowsToken(a.token))
    XCTAssertEqual(a.link.peerMaxPacket, Link.maxPacket)
  }

  /// Android throws for a GATT value over 512 bytes, though MTU 517 leaves room for 514.
  func testFramesStayWithinTheGattAttributeLimitAtEveryMtu() {
    XCTAssertEqual(Frames.frameCapacity(mtu: 23), 20)
    XCTAssertEqual(Frames.frameCapacity(mtu: 185), 182)
    XCTAssertEqual(Frames.frameCapacity(mtu: 515), 512)
    XCTAssertEqual(Frames.frameCapacity(mtu: 517), 512)

    var sizes: [Int] = []
    let side = Side(token: token(1), owner: self)
    side.link = Link(
      id: 1, role: .central, address: "b", localToken: side.token,
      sink: { [unowned self, unowned side] frame in
        sizes.append(frame.count)
        self.events.append { side.link.onWriteComplete(true) }
        return true
      },
      listener: side)
    side.link.mtu = 517
    side.link.start()
    drain()
    side.link.onFrame(
      Frames.encodeHello(
        Hello(version: Frames.version, token: token(2), maxPacket: Link.maxPacket, credits: 8)))
    side.link.send(packet(64 * 1024, 7)) { _ in }
    drain()
    XCTAssertEqual(sizes.max(), Frames.maxAttributeValue)
    XCTAssertNil(side.failure)
  }

  func testPacketsArriveIntactAndInOrderBothWays() {
    for mtu in [23, 185, 517] {
      let (a, b) = pair(mtu: mtu)
      let sizes = [0, 1, 500, 4096, 65_536, Link.maxPacket, 3]
      let toB = sizes.enumerated().map { packet($0.element, $0.offset) }
      let toA = sizes.reversed().enumerated().map { packet($0.element, 50 + $0.offset) }
      let sentA = sendAll(a.link, toB)
      let sentB = sendAll(b.link, toA)
      drain()
      XCTAssertTrue(sentA.values.allSatisfy { $0 == nil } && sentB.values.allSatisfy { $0 == nil })
      XCTAssertEqual(b.received.count, toB.count)
      XCTAssertEqual(b.received, toB, "mtu \(mtu)")
      XCTAssertEqual(a.received, toA, "mtu \(mtu)")
      XCTAssertEqual(a.link.bytesSent, toB.reduce(0) { $0 + $1.count })
      XCTAssertEqual(a.link.outboundBytes, 0)
      XCTAssertNil(a.failure ?? b.failure)
    }
  }

  func testSendRefusesBeforeUpAndOverTheLimit() {
    let listener = Side(token: token(5), owner: nil)
    let idle = Link(
      id: 9, role: .central, address: "x", localToken: token(5), sink: { _ in true },
      listener: listener)
    var error: String?
    idle.send([0]) { error = $0 }
    XCTAssertEqual(error, "not_up")

    let (a, _) = pair()
    a.link.send([UInt8](repeating: 0, count: Link.maxPacket + 1)) { error = $0 }
    XCTAssertEqual(error, "too_large")
  }

  func testAReceiverThatDoesNotTakePacketsStallsTheSender() {
    let (a, b) = pair()
    b.takeImmediately = false
    let results = sendAll(a.link, (0..<20).map { packet(100, $0) })
    drain()
    XCTAssertEqual(b.received.count, Link.initialCredits)
    XCTAssertEqual(results.values.count, 20)  // all fit in the outbound queue
    XCTAssertEqual(a.link.unsent, 12)

    // Fewer than a batch taken: no credit goes back yet.
    b.link.returnCredits(Link.creditBatch - 1)
    drain()
    XCTAssertEqual(b.received.count, Link.initialCredits)

    b.link.returnCredits(Link.initialCredits - Link.creditBatch + 1)
    drain()
    XCTAssertEqual(b.received.count, 16)
    b.link.returnCredits(Link.initialCredits)
    drain()
    XCTAssertEqual(b.received.count, 20)
    XCTAssertEqual(a.link.unsent, 0)
  }

  func testAFullOutboundQueueMakesSendWait() {
    let (a, b) = pair()
    b.takeImmediately = false
    let results = sendAll(a.link, (0..<14).map { packet(Link.maxPacket, $0) })
    drain()
    // 8 sent on credit; 4 × 128 KiB fill the 512 KiB queue; 2 wait for room.
    XCTAssertEqual(b.received.count, Link.initialCredits)
    XCTAssertEqual(results.values.count, 12)
    XCTAssertEqual(a.link.outboundBytes, Link.outboundCapBytes)

    b.link.returnCredits(Link.initialCredits)
    drain()
    XCTAssertEqual(results.values.count, 14)
    XCTAssertTrue(results.values.allSatisfy { $0 == nil })
    b.link.returnCredits(Link.initialCredits)
    drain()
    XCTAssertEqual(b.received.count, 14)
  }

  func testClosingFailsWaitingSends() {
    let (a, b) = pair()
    b.takeImmediately = false
    let results = sendAll(a.link, (0..<14).map { packet(Link.maxPacket, $0) })
    drain()
    a.link.close()
    XCTAssertEqual(results.values.count, 14)
    XCTAssertEqual(Array(results.values.suffix(2)), ["link_down", "link_down"])
    var after: String?
    a.link.send([0]) { after = $0 }
    XCTAssertEqual(after, "link_down")
  }

  func testAPeerThatIgnoresCreditsIsCutOff() {
    let listener = Side(token: token(7), owner: nil)
    let receiver = Link(
      id: 3, role: .peripheral, address: "rogue", localToken: listener.token, sink: { _ in true },
      listener: listener, initialCredits: 1)
    listener.link = receiver
    receiver.start()
    receiver.onFrame(
      Frames.encodeHello(
        Hello(version: Frames.version, token: token(8), maxPacket: Link.maxPacket, credits: 8)))
    receiver.onFrame(PacketWriter([0]).next(seq: 0, capacity: 20))
    XCTAssertNil(listener.failure)
    receiver.onFrame(PacketWriter([0]).next(seq: 1, capacity: 20))
    XCTAssertEqual(listener.failure, "protocol: packet without credit")
    XCTAssertTrue(receiver.closed)
  }

  func testDataBeforeHelloAndAWrongVersionFail() {
    let early = Side(token: token(9), owner: nil)
    early.link = Link(
      id: 4, role: .peripheral, address: "p", localToken: early.token, sink: { _ in true },
      listener: early)
    early.link.onFrame(PacketWriter([0]).next(seq: 0, capacity: 20))
    XCTAssertEqual(early.failure, "protocol: DATA before HELLO")

    let old = Side(token: token(10), owner: nil)
    old.link = Link(
      id: 5, role: .peripheral, address: "p", localToken: old.token, sink: { _ in true },
      listener: old)
    old.link.onFrame(
      Frames.encodeHello(Hello(version: 2, token: token(11), maxPacket: 100, credits: 1)))
    XCTAssertEqual(old.failure, "protocol: unsupported version 2")
  }

  func testARotatedTokenReachesThePeer() {
    let (a, b) = pair()
    let next = token(42)
    a.link.announceToken(next)
    drain()
    XCTAssertTrue(b.link.knowsToken(next))
    XCTAssertTrue(b.link.knowsToken(a.token))
  }
}
