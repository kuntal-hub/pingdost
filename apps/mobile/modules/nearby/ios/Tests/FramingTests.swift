import XCTest

@testable import NearbyCore

/// A port of Android's `FramingTest.kt`, plus golden bytes: both platforms must put exactly
/// these bytes on the air (ADR 0023's frame table).
final class FramingTests: XCTestCase {
  private let token: [UInt8] = (0..<Frames.tokenBytes).map { UInt8(truncatingIfNeeded: $0 * 31 + 7) }

  private func packet(_ size: Int) -> [UInt8] {
    (0..<size).map { UInt8(truncatingIfNeeded: $0 * 13 + size) }
  }

  private func frames(_ data: [UInt8], _ capacity: Int, firstSeq: Int = 0) -> [[UInt8]] {
    let writer = PacketWriter(data)
    var out: [[UInt8]] = []
    var seq = firstSeq
    while !writer.done {
      out.append(writer.next(seq: seq, capacity: capacity))
      seq += 1
    }
    return out
  }

  private func expectFailure(
    _ message: String, file: StaticString = #filePath, line: UInt = #line, _ block: () throws -> Void
  ) {
    do {
      try block()
      XCTFail("expected a FrameError containing \"\(message)\"", file: file, line: line)
    } catch let error as FrameError {
      XCTAssertTrue(error.message.contains(message), error.message, file: file, line: line)
    } catch {
      XCTFail("unexpected \(error)", file: file, line: line)
    }
  }

  func testGoldenBytes() throws {
    let token: [UInt8] = [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]
    XCTAssertEqual(
      Tokens.hex(Frames.encodeHello(Hello(version: 1, token: token, maxPacket: 131_072, credits: 8))),
      "01010123456789abcdef000200000008")
    XCTAssertEqual(Tokens.hex(Frames.encodeCredit(4)), "030004")
    XCTAssertEqual(Tokens.hex(Frames.encodeToken(token)), "040123456789abcdef")
    // A 3-byte packet at seq 0x0102 in one frame: DATA, first|last, seq, length 3, bytes.
    XCTAssertEqual(
      Tokens.hex(PacketWriter([0xaa, 0xbb, 0xcc]).next(seq: 0x0102, capacity: 20)),
      "02030102" + "00000003" + "aabbcc")
  }

  func testControlFramesRoundTrip() throws {
    guard
      case .hello(let hello) = try Frames.decodeControl(
        Frames.encodeHello(Hello(version: 1, token: token, maxPacket: 131_072, credits: 8)))
    else { return XCTFail("not a HELLO") }
    XCTAssertEqual(hello.version, 1)
    XCTAssertEqual(hello.token, token)
    XCTAssertEqual(hello.maxPacket, 131_072)
    XCTAssertEqual(hello.credits, 8)
    XCTAssertEqual(
      Frames.encodeHello(Hello(version: 1, token: token, maxPacket: 1, credits: 1)).count,
      Frames.helloSize)

    guard case .credit(let packets) = try Frames.decodeControl(Frames.encodeCredit(65_535)) else {
      return XCTFail("not a CREDIT")
    }
    XCTAssertEqual(packets, 65_535)
    guard case .token(let decoded) = try Frames.decodeControl(Frames.encodeToken(token)) else {
      return XCTFail("not a TOKEN")
    }
    XCTAssertEqual(decoded, token)
  }

  func testBadControlFramesAreRejected() {
    expectFailure("empty") { _ = try Frames.decodeControl([]) }
    expectFailure("unknown frame type") { _ = try Frames.decodeControl([0x7f]) }
    expectFailure("bad HELLO size") {
      _ = try Frames.decodeControl(
        Array(Frames.encodeHello(Hello(version: 1, token: token, maxPacket: 1, credits: 1)).prefix(10)))
    }
    expectFailure("CREDIT of zero") { _ = try Frames.decodeControl([Frames.typeCredit, 0, 0]) }
    expectFailure("bad TOKEN size") { _ = try Frames.decodeControl([Frames.typeToken, 1, 2]) }
  }

  func testPacketsSurviveEveryFrameSize() throws {
    // 20 = the default ATT MTU (23) − 3; 514 = MTU 517 − 3; 182 = iOS's common MTU 185 − 3.
    for capacity in [20, 100, 182, 244, 514] {
      let reassembler = Reassembler(maxPacket: Link.maxPacket)
      var seq = 0
      for size in [0, 1, 11, 12, 13, 500, 4096, Link.maxPacket] {
        let data = packet(size)
        let parts = frames(data, capacity, firstSeq: seq)
        seq = (seq + parts.count) & 0xffff
        for part in parts { XCTAssertLessThanOrEqual(part.count, capacity) }
        let results = try parts.map { try reassembler.accept($0) }
        for result in results.dropLast() { XCTAssertNil(result) }
        XCTAssertEqual(results.last ?? nil, data, "size \(size) at capacity \(capacity)")
      }
    }
  }

  func testFirstFrameCarriesTheLength() {
    let parts = frames(packet(30), 20)
    XCTAssertEqual(parts[0][1], Frames.flagFirst)
    XCTAssertEqual(Frames.getInt(parts[0], Frames.dataHeader), 30)
    XCTAssertEqual(parts.last?[1], Frames.flagLast)
    // An empty packet is one frame that is both first and last.
    let empty = frames([], 20)
    XCTAssertEqual(empty.count, 1)
    XCTAssertEqual(empty[0][1], Frames.flagFirst | Frames.flagLast)
  }

  func testSequenceWrapsAt16Bits() throws {
    let reassembler = Reassembler(maxPacket: 16)
    for seq in 0..<70_000 {
      let frame = PacketWriter([0]).next(seq: seq, capacity: 20)
      XCTAssertEqual(try reassembler.accept(frame)?.count, 1)
    }
  }

  func testGapsAndRepeatsFailTheLink() throws {
    let parts = frames(packet(100), 20)
    let skipped = Reassembler(maxPacket: Link.maxPacket)
    _ = try skipped.accept(parts[0])
    expectFailure("sequence gap") { _ = try skipped.accept(parts[2]) }

    let repeated = Reassembler(maxPacket: Link.maxPacket)
    _ = try repeated.accept(parts[0])
    expectFailure("sequence gap") { _ = try repeated.accept(parts[0]) }
  }

  func testMalformedPacketsAreRejected() throws {
    expectFailure("over the limit") { _ = try Reassembler(maxPacket: 10).accept(frames(packet(11), 20)[0]) }
    expectFailure("continuation without a first") {
      var frame = frames(packet(40), 20)[1]
      frame[2] = 0
      frame[3] = 0
      _ = try Reassembler(maxPacket: 100).accept(frame)
    }
    expectFailure("reserved DATA flags") {
      var frame = frames(packet(5), 20)[0]
      frame[1] |= 0x80
      _ = try Reassembler(maxPacket: 100).accept(frame)
    }
    expectFailure("not a DATA frame") { _ = try Reassembler(maxPacket: 100).accept([Frames.typeCredit, 0, 1, 0]) }
    expectFailure("over the limit") {
      // A length with the top bit set is negative, as on the JVM.
      var frame = frames(packet(5), 20)[0]
      Frames.putInt(&frame, Frames.dataHeader, -1)
      _ = try Reassembler(maxPacket: 100).accept(frame)
    }

    // A first fragment that announces 5 bytes but carries 6.
    var long = frames(packet(6), 20)[0]
    Frames.putInt(&long, Frames.dataHeader, 5)
    expectFailure("longer than announced") { _ = try Reassembler(maxPacket: 100).accept(long) }
    // The last fragment arrives before the announced length is complete.
    var short = frames(packet(5), 20)[0]
    Frames.putInt(&short, Frames.dataHeader, 9)
    expectFailure("shorter than announced") { _ = try Reassembler(maxPacket: 100).accept(short) }
    // A new first fragment while a packet is half received.
    let half = Reassembler(maxPacket: 100)
    _ = try half.accept(frames(packet(40), 20)[0])
    expectFailure("before the previous one ended") {
      _ = try half.accept(frames(packet(4), 20, firstSeq: 1)[0])
    }
  }
}
