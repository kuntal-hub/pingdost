import Foundation

/// Link framing (Phase 21, ADR 0023): the same bytes as Android's `Framing.kt`, so an iPhone and
/// an Android phone talk over one GATT link (Phase 30, ADR 0033). Every GATT write or
/// notification carries exactly one frame of at most (ATT MTU − 3) bytes. Integers are
/// big-endian.
///
/// ```
/// HELLO  0x01 | version u8 | token 8 B | maxPacket u32 | credits u16
/// DATA   0x02 | flags u8 (bit 0 first, bit 1 last) | seq u16 | [length u32, first only] | bytes
/// CREDIT 0x03 | packets u16
/// TOKEN  0x04 | token 8 B          (the sender rotated its token)
/// ```
///
/// - `seq` counts DATA frames per link and direction from 0 and wraps at 2^16. A gap or repeat
///   means a lost or duplicated frame: the link fails instead of delivering a corrupt packet.
/// - One packet's fragments are never interleaved with another's.
/// - Flow control is per packet: the receiver grants `credits` in HELLO and returns one CREDIT
///   per packet the app has taken from the native inbound queue.
///
/// No Apple framework is used here, so it is unit-tested on Linux (`Package.swift`).
enum Frames {
  static let version = 1

  static let typeHello: UInt8 = 0x01
  static let typeData: UInt8 = 0x02
  static let typeCredit: UInt8 = 0x03
  static let typeToken: UInt8 = 0x04

  static let flagFirst: UInt8 = 0x01
  static let flagLast: UInt8 = 0x02

  static let tokenBytes = 8
  static let helloSize = 1 + 1 + tokenBytes + 4 + 2
  static let creditSize = 3
  static let tokenSize = 1 + tokenBytes
  static let dataHeader = 4
  static let firstExtra = 4

  /// ATT opcode (1) + attribute handle (2): a write or notification carries MTU − 3 bytes.
  static let attOverhead = 3
  static let defaultMtu = 23

  static func encodeHello(_ hello: Hello) -> [UInt8] {
    precondition(hello.token.count == tokenBytes, "token must be \(tokenBytes) bytes")
    var out = [UInt8](repeating: 0, count: helloSize)
    out[0] = typeHello
    out[1] = UInt8(truncatingIfNeeded: hello.version)
    out.replaceSubrange(2..<(2 + tokenBytes), with: hello.token)
    putInt(&out, 2 + tokenBytes, hello.maxPacket)
    putShort(&out, 6 + tokenBytes, hello.credits)
    return out
  }

  static func encodeCredit(_ packets: Int) -> [UInt8] {
    precondition((1...0xffff).contains(packets), "credit out of range")
    var out = [UInt8](repeating: 0, count: creditSize)
    out[0] = typeCredit
    putShort(&out, 1, packets)
    return out
  }

  static func encodeToken(_ token: [UInt8]) -> [UInt8] {
    precondition(token.count == tokenBytes, "token must be \(tokenBytes) bytes")
    return [typeToken] + token
  }

  /// Decodes a control frame (anything but DATA).
  static func decodeControl(_ frame: [UInt8]) throws -> Control {
    guard let type = frame.first else { throw FrameError("empty frame") }
    switch type {
    case typeHello:
      guard frame.count == helloSize else { throw FrameError("bad HELLO size \(frame.count)") }
      return .hello(
        Hello(
          version: Int(frame[1]),
          token: Array(frame[2..<(2 + tokenBytes)]),
          maxPacket: getInt(frame, 2 + tokenBytes),
          credits: getShort(frame, 6 + tokenBytes)))
    case typeCredit:
      guard frame.count == creditSize else { throw FrameError("bad CREDIT size \(frame.count)") }
      let packets = getShort(frame, 1)
      guard packets != 0 else { throw FrameError("CREDIT of zero") }
      return .credit(packets)
    case typeToken:
      guard frame.count == tokenSize else { throw FrameError("bad TOKEN size \(frame.count)") }
      return .token(Array(frame[1..<(1 + tokenBytes)]))
    default:
      throw FrameError("unknown frame type \(type)")
    }
  }

  static func putInt(_ out: inout [UInt8], _ at: Int, _ value: Int) {
    let bits = UInt32(truncatingIfNeeded: value)
    out[at] = UInt8(truncatingIfNeeded: bits >> 24)
    out[at + 1] = UInt8(truncatingIfNeeded: bits >> 16)
    out[at + 2] = UInt8(truncatingIfNeeded: bits >> 8)
    out[at + 3] = UInt8(truncatingIfNeeded: bits)
  }

  /// Signed 32 bits, like the JVM's `Int`: a length with the top bit set reads as negative.
  static func getInt(_ data: [UInt8], _ at: Int) -> Int {
    let bits =
      UInt32(data[at]) << 24 | UInt32(data[at + 1]) << 16 | UInt32(data[at + 2]) << 8
      | UInt32(data[at + 3])
    return Int(Int32(bitPattern: bits))
  }

  static func putShort(_ out: inout [UInt8], _ at: Int, _ value: Int) {
    out[at] = UInt8(truncatingIfNeeded: value >> 8)
    out[at + 1] = UInt8(truncatingIfNeeded: value)
  }

  static func getShort(_ data: [UInt8], _ at: Int) -> Int {
    Int(data[at]) << 8 | Int(data[at + 1])
  }
}

struct FrameError: Error, CustomStringConvertible {
  let message: String
  init(_ message: String) { self.message = message }
  var description: String { message }
}

struct Hello {
  let version: Int
  let token: [UInt8]
  let maxPacket: Int
  let credits: Int
}

enum Control {
  case hello(Hello)
  case credit(Int)
  case token([UInt8])
}

/// Cuts one packet into DATA frames, one at a time.
final class PacketWriter {
  let data: [UInt8]
  private var offset = 0
  private var started = false

  init(_ data: [UInt8]) {
    self.data = data
  }

  var done: Bool { started && offset >= data.count }

  /// The next DATA frame, at most `capacity` bytes (the link's MTU − 3).
  func next(seq: Int, capacity: Int) -> [UInt8] {
    precondition(!done, "packet already written")
    let first = !started
    let header = Frames.dataHeader + (first ? Frames.firstExtra : 0)
    precondition(capacity > header, "frame capacity \(capacity) too small")
    let take = min(capacity - header, data.count - offset)
    let last = offset + take >= data.count
    var frame = [UInt8](repeating: 0, count: header + take)
    frame[0] = Frames.typeData
    frame[1] = (first ? Frames.flagFirst : 0) | (last ? Frames.flagLast : 0)
    Frames.putShort(&frame, 2, seq & 0xffff)
    if first { Frames.putInt(&frame, Frames.dataHeader, data.count) }
    frame.replaceSubrange(header..<(header + take), with: data[offset..<(offset + take)])
    offset += take
    started = true
    return frame
  }
}

/// Rebuilds packets from DATA frames and enforces the per-link sequence and size limit.
final class Reassembler {
  private let maxPacket: Int
  private var expectedSeq = 0
  private var buffer: [UInt8]?
  private var announced = 0

  init(maxPacket: Int) {
    self.maxPacket = maxPacket
  }

  /// True while a packet is half received.
  var partial: Bool { buffer != nil }

  /// Feeds one DATA frame; returns the packet it completes, or nil.
  func accept(_ frame: [UInt8]) throws -> [UInt8]? {
    guard frame.count >= Frames.dataHeader, frame[0] == Frames.typeData else {
      throw FrameError("not a DATA frame")
    }
    let flags = frame[1]
    if flags & ~(Frames.flagFirst | Frames.flagLast) != 0 {
      throw FrameError("reserved DATA flags \(flags)")
    }
    let seq = Frames.getShort(frame, 2)
    guard seq == expectedSeq else {
      throw FrameError("sequence gap: expected \(expectedSeq), got \(seq)")
    }
    expectedSeq = (seq + 1) & 0xffff

    var offset = Frames.dataHeader
    if flags & Frames.flagFirst != 0 {
      if buffer != nil { throw FrameError("packet started before the previous one ended") }
      guard frame.count >= Frames.dataHeader + Frames.firstExtra else {
        throw FrameError("short first fragment")
      }
      let length = Frames.getInt(frame, Frames.dataHeader)
      if length < 0 || length > maxPacket {
        throw FrameError("packet of \(length) bytes over the limit")
      }
      var fresh = [UInt8]()
      fresh.reserveCapacity(length)
      buffer = fresh
      announced = length
      offset += Frames.firstExtra
    } else if buffer == nil {
      throw FrameError("continuation without a first fragment")
    }

    guard var target = buffer else { return nil }
    buffer = nil  // keeps `target` uniquely referenced, so appending does not copy
    let count = frame.count - offset
    if target.count + count > announced { throw FrameError("packet longer than announced") }
    target.append(contentsOf: frame[offset...])
    if flags & Frames.flagLast == 0 {
      buffer = target
      return nil
    }
    if target.count != announced { throw FrameError("packet shorter than announced") }
    return target
  }
}
