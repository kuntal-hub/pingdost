import Foundation

/// Rotating random tokens (ADR 0023): 8 bytes, never an identity.
enum Tokens {
  static func random() -> [UInt8] {
    var generator = SystemRandomNumberGenerator()
    return (0..<Frames.tokenBytes).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
  }

  /// Unsigned byte-wise comparison, as Android's `compareTokens`.
  static func compare(_ a: [UInt8], _ b: [UInt8]) -> Int {
    for (x, y) in zip(a, b) where x != y {
      return Int(x) - Int(y)
    }
    return a.count - b.count
  }

  static func hex(_ bytes: [UInt8]) -> String {
    let digits = Array("0123456789abcdef")
    var out = ""
    out.reserveCapacity(bytes.count * 2)
    for byte in bytes {
      out.append(digits[Int(byte >> 4)])
      out.append(digits[Int(byte & 0x0f)])
    }
    return out
  }
}

/// Who opens a link (ADR 0033). Android connects only to peers whose advertised token is higher
/// than its own (ADR 0023). An iPhone cannot advertise a token (iOS advertises only a name and
/// service UUIDs), so Android never connects to it: the iPhone must connect to every PingDost
/// peer it discovers. Two iPhones both connect; the duplicate rule below closes one.
enum ConnectPolicy {
  static func shouldConnect(
    address: String,
    /// From the peer's advert (Android), or remembered from an earlier link to this address.
    knownToken: [UInt8]?,
    links: [Link],
    maxLinks: Int,
    lastTriedMs: Double?,
    nowMs: Double,
    backoffMs: Double
  ) -> Bool {
    if links.count >= maxLinks { return false }
    if links.contains(where: { $0.address == address }) { return false }
    if let token = knownToken, links.contains(where: { $0.knowsToken(token) }) { return false }
    if let tried = lastTriedMs, nowMs - tried < backoffMs { return false }
    return true
  }

  /// The HELLO token of a link's central side.
  static func centralToken(_ link: Link) -> [UInt8] {
    link.role == .central ? link.localToken : (link.peerTokens.first ?? [])
  }

  enum UpDecision {
    /// Keep the new link; close `duplicate` if there is one.
    case keep(duplicate: Link?)
    /// Close the new link: `existing` connects the same two phones.
    case closeNew(existing: Link)
  }

  /// Both phones may have connected to each other. Both keep the link whose central had the lower
  /// HELLO token, so they close the same one (Android's `maybeUp`).
  static func onUp(_ link: Link, among links: [Link]) -> UpDecision {
    let duplicate = links.first { other in
      other !== link && other.upAt != 0 && link.peerTokens.contains { other.knowsToken($0) }
    }
    guard let duplicate else { return .keep(duplicate: nil) }
    if Tokens.compare(centralToken(duplicate), centralToken(link)) < 0 {
      return .closeNew(existing: duplicate)
    }
    return .keep(duplicate: duplicate)
  }
}

/// The native inbound queue (ADR 0023): packets wait here until JS takes them in batches of
/// `linkId u32 | length u32 | bytes` (`parseInbound` in `src/inbound.ts`). Credits go back only
/// when JS takes them, so a suspended JS stalls the sender instead of losing packets.
final class InboundQueue {
  private let lock = NSLock()
  private var packets: [(linkId: Int, data: [UInt8])] = []
  private var notified = false

  var count: Int {
    lock.lock()
    defer { lock.unlock() }
    return packets.count
  }

  /// Adds a packet. `notify`: the first since JS last emptied the queue, so JS must be told.
  func add(linkId: Int, packet: [UInt8]) -> (notify: Bool, queued: Int) {
    lock.lock()
    defer { lock.unlock() }
    packets.append((linkId, packet))
    let notify = !notified
    notified = true
    return (notify, packets.count)
  }

  /// Takes packets oldest first, up to `maxBytes` (at least one). Empty when nothing waits.
  /// `counts`: packets taken per link, for the credits to return.
  func take(maxBytes: Int) -> (batch: [UInt8], counts: [Int: Int]) {
    lock.lock()
    var taken: [(linkId: Int, data: [UInt8])] = []
    var total = 0
    while let first = packets.first {
      let size = 8 + first.data.count
      if !taken.isEmpty && total + size > maxBytes { break }
      taken.append(packets.removeFirst())
      total += size
    }
    if packets.isEmpty { notified = false }
    lock.unlock()

    var batch = [UInt8](repeating: 0, count: total)
    var counts: [Int: Int] = [:]
    var at = 0
    for packet in taken {
      Frames.putInt(&batch, at, packet.linkId)
      Frames.putInt(&batch, at + 4, packet.data.count)
      batch.replaceSubrange((at + 8)..<(at + 8 + packet.data.count), with: packet.data)
      at += 8 + packet.data.count
      counts[packet.linkId, default: 0] += 1
    }
    return (batch, counts)
  }

  func clear() {
    lock.lock()
    packets.removeAll()
    notified = false
    lock.unlock()
  }
}
