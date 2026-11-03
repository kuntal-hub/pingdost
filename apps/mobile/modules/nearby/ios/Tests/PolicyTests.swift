import XCTest

@testable import NearbyCore

/// Who connects, which duplicate closes, and the inbound batch format (ADR 0023, 0033).
final class PolicyTests: XCTestCase {
  private final class Quiet: LinkListener {
    func onHello(_ link: Link) {}
    func onPacket(_ link: Link, _ packet: [UInt8]) {}
    func onPeerToken(_ link: Link) {}
    func onFailure(_ link: Link, _ reason: String) {}
  }

  private let quiet = Quiet()

  private func token(_ seed: UInt8) -> [UInt8] { [UInt8](repeating: seed, count: 8) }

  /// A link that is up, with the peer's HELLO token.
  private func upLink(
    id: Int, role: Role, address: String, local: [UInt8], peer: [UInt8]
  ) -> Link {
    let link = Link(
      id: id, role: role, address: address, localToken: local, sink: { _ in true },
      listener: quiet)
    link.start()
    link.onFrame(
      Frames.encodeHello(
        Hello(version: Frames.version, token: peer, maxPacket: Link.maxPacket, credits: 8)))
    link.onWriteComplete(true)
    return link
  }

  func testAnIPhoneConnectsToEveryPeerItIsNotLinkedTo() {
    let linked = upLink(id: 1, role: .peripheral, address: "central-A", local: token(9), peer: token(1))
    let decide = { (address: String, known: [UInt8]?, tried: Double?) in
      ConnectPolicy.shouldConnect(
        address: address, knownToken: known, links: [linked], maxLinks: 7, lastTriedMs: tried,
        nowMs: 100_000, backoffMs: 10_000)
    }
    // An Android phone (token advertised) or an iPhone (none): both get a connection.
    XCTAssertTrue(decide("peripheral-B", token(2), nil))
    XCTAssertTrue(decide("peripheral-C", nil, nil))
    // Already linked: by address, or by a token the link has seen (Android connected to us).
    XCTAssertFalse(decide("central-A", nil, nil))
    XCTAssertFalse(decide("peripheral-A", token(1), nil))
    // Tried a moment ago.
    XCTAssertFalse(decide("peripheral-C", nil, 95_000))
    XCTAssertTrue(decide("peripheral-C", nil, 80_000))
    // Full.
    let full = (0..<7).map {
      upLink(id: 10 + $0, role: .central, address: "x\($0)", local: token(9), peer: token(UInt8(20 + $0)))
    }
    XCTAssertFalse(
      ConnectPolicy.shouldConnect(
        address: "y", knownToken: nil, links: full, maxLinks: 7, lastTriedMs: nil, nowMs: 0,
        backoffMs: 10_000))
  }

  func testBothPhonesCloseTheSameDuplicate() {
    // Phone A (token 1) and phone B (token 2) connected to each other at once.
    // On A: link 1 is A's central link (central token 1), link 2 is B's (central token 2).
    let aCentral = upLink(id: 1, role: .central, address: "B", local: token(1), peer: token(2))
    aCentral.upAt = 1
    let aPeripheral = upLink(id: 2, role: .peripheral, address: "B'", local: token(1), peer: token(2))
    // On B: the mirror image.
    let bCentral = upLink(id: 1, role: .central, address: "A", local: token(2), peer: token(1))
    bCentral.upAt = 1
    let bPeripheral = upLink(id: 2, role: .peripheral, address: "A'", local: token(2), peer: token(1))

    // A: its peripheral link (central token 2) loses to the central link (central token 1).
    guard case .closeNew(let keptOnA) = ConnectPolicy.onUp(aPeripheral, among: [aCentral, aPeripheral])
    else { return XCTFail("A should close the new link") }
    XCTAssertTrue(keptOnA === aCentral)
    // B: its new peripheral link (central token 1) wins; B closes its central link (token 2).
    guard case .keep(let closeOnB) = ConnectPolicy.onUp(bPeripheral, among: [bCentral, bPeripheral])
    else { return XCTFail("B should keep the new link") }
    XCTAssertTrue(closeOnB === bCentral)
    // Both kept the link whose central is A (token 1).
    XCTAssertEqual(ConnectPolicy.centralToken(keptOnA), token(1))
    XCTAssertEqual(ConnectPolicy.centralToken(bPeripheral), token(1))
  }

  func testANewPeerIsNoDuplicate() {
    let first = upLink(id: 1, role: .central, address: "B", local: token(1), peer: token(2))
    first.upAt = 1
    let other = upLink(id: 2, role: .central, address: "C", local: token(1), peer: token(3))
    guard case .keep(let duplicate) = ConnectPolicy.onUp(other, among: [first, other]) else {
      return XCTFail("expected keep")
    }
    XCTAssertNil(duplicate)
  }

  func testTokens() {
    XCTAssertLessThan(Tokens.compare([0x01, 0xff], [0x02, 0x00]), 0)
    XCTAssertGreaterThan(Tokens.compare([0x80], [0x7f]), 0)  // unsigned, unlike a JVM byte
    XCTAssertEqual(Tokens.compare([1, 2], [1, 2]), 0)
    XCTAssertEqual(Tokens.hex([0x00, 0x0f, 0xa5, 0xff]), "000fa5ff")
    let a = Tokens.random()
    XCTAssertEqual(a.count, 8)
    XCTAssertNotEqual(a, Tokens.random())
  }

  func testTheInboundBatchIsWhatParseInboundReads() {
    let queue = InboundQueue()
    XCTAssertEqual(queue.add(linkId: 7, packet: [0xaa, 0xbb]).notify, true)
    XCTAssertEqual(queue.add(linkId: 7, packet: []).notify, false)
    XCTAssertEqual(queue.add(linkId: 0x0102_0304, packet: [0xcc]).queued, 3)

    // At least one packet, then only what fits in maxBytes.
    let first = queue.take(maxBytes: 1)
    XCTAssertEqual(Tokens.hex(first.batch), "00000007" + "00000002" + "aabb")
    XCTAssertEqual(first.counts, [7: 1])

    let rest = queue.take(maxBytes: 1_000)
    XCTAssertEqual(Tokens.hex(rest.batch), "00000007" + "00000000" + "01020304" + "00000001" + "cc")
    XCTAssertEqual(rest.counts, [7: 1, 0x0102_0304: 1])
    XCTAssertEqual(queue.take(maxBytes: 1_000).batch, [])
    // Emptied: the next packet notifies again.
    XCTAssertEqual(queue.add(linkId: 1, packet: [1]).notify, true)
  }
}
