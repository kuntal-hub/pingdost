import Foundation

enum Role: String {
  /// We are the GATT client: we write to the peer's RX, it notifies on its TX.
  case central
  /// We are the GATT server: the peer writes to our RX, we notify on our TX.
  case peripheral
}

protocol LinkListener: AnyObject {
  /// The peer's HELLO arrived (the link is up once ours is queued too).
  func onHello(_ link: Link)
  func onPacket(_ link: Link, _ packet: [UInt8])
  /// The peer announced a new token over the link.
  func onPeerToken(_ link: Link)
  /// A protocol or write error: the engine tears the connection down.
  func onFailure(_ link: Link, _ reason: String)
}

/// One BLE link's framing state, a port of Android's `Link.kt` (ADR 0023, 0033): outbound
/// packet queue with backpressure, per-link sequence, credit flow control and reassembly. Not
/// thread-safe: the engine calls it only on its own queue. It knows nothing about CoreBluetooth,
/// so tests drive two links over a loopback.
final class Link {
  /// Largest packet either side accepts: a 64 KiB envelope or file chunk plus headers.
  static let maxPacket = 128 * 1024
  /// Packets a sender may start before the receiver's app has taken any.
  static let initialCredits = 8
  /// Credits are returned in batches of this many (≤ initialCredits, so no deadlock).
  static let creditBatch = 4
  /// Bytes queued per link before `send` waits for room.
  static let outboundCapBytes = 512 * 1024
  /// `send` calls that may wait for room; more fail with `queue_full`.
  static let maxWaiting = 64
  private static let maxTokens = 4

  let id: Int
  let role: Role
  let address: String
  /// The token we put in our HELLO.
  let localToken: [UInt8]
  private let sink: ([UInt8]) -> Bool
  private let listener: LinkListener
  let maxPacket: Int
  private let initialCredits: Int

  var mtu = Frames.defaultMtu
  var txPhy = 1
  var rxPhy = 1
  let createdAt = Date().timeIntervalSince1970 * 1_000
  var upAt: Double = 0

  /// Tokens the peer has used on this link, newest last.
  private(set) var peerTokens: [[UInt8]] = []
  private(set) var peerMaxPacket = 0
  private(set) var helloSent = false
  private(set) var helloReceived = false
  private(set) var closed = false

  var up: Bool { helloSent && helloReceived && !closed }

  private(set) var packetsSent = 0
  private(set) var packetsReceived = 0
  private(set) var bytesSent = 0
  private(set) var bytesReceived = 0
  private(set) var framesSent = 0
  private(set) var framesReceived = 0

  private var control: [[UInt8]] = []
  private var outbound: [[UInt8]] = []
  private var waiting: [([UInt8], (String?) -> Void)] = []
  private(set) var outboundBytes = 0
  private var current: PacketWriter?
  private var txSeq = 0
  private(set) var sendCredits = 0
  private var writing = false

  private let reassembler: Reassembler
  /// Credits we granted that the peer has not used yet.
  private var grantedToPeer = 0
  private var creditsOwed = 0

  init(
    id: Int, role: Role, address: String, localToken: [UInt8],
    sink: @escaping ([UInt8]) -> Bool, listener: LinkListener,
    maxPacket: Int = Link.maxPacket, initialCredits: Int = Link.initialCredits
  ) {
    self.id = id
    self.role = role
    self.address = address
    self.localToken = localToken
    self.sink = sink
    self.listener = listener
    self.maxPacket = maxPacket
    self.initialCredits = initialCredits
    self.reassembler = Reassembler(maxPacket: maxPacket)
  }

  /// Packets accepted by `send` but not fully written.
  var unsent: Int { outbound.count + waiting.count + (current != nil ? 1 : 0) }

  /// Queues our HELLO; call once the peer can receive frames.
  func start() {
    if helloSent || closed { return }
    control.append(
      Frames.encodeHello(
        Hello(
          version: Frames.version, token: localToken, maxPacket: maxPacket,
          credits: initialCredits)))
    grantedToPeer = initialCredits
    helloSent = true
    pump()
  }

  /// Accepts a packet into the native queue. `done` gets nil once it is queued (not delivered),
  /// or an error code: `not_up`, `link_down`, `too_large`, `queue_full`.
  func send(_ packet: [UInt8], done: @escaping (String?) -> Void) {
    if closed {
      done("link_down")
    } else if !up {
      done("not_up")
    } else if packet.count > min(maxPacket, peerMaxPacket) {
      done("too_large")
    } else if waiting.isEmpty && fits(packet) {
      admit(packet)
      done(nil)
      pump()
    } else if waiting.count >= Link.maxWaiting {
      done("queue_full")
    } else {
      waiting.append((packet, done))
    }
  }

  /// One frame from the peer (a GATT write or notification).
  func onFrame(_ frame: [UInt8]) {
    if closed { return }
    framesReceived += 1
    do {
      if frame.first == Frames.typeData {
        if !helloReceived { throw FrameError("DATA before HELLO") }
        guard let packet = try reassembler.accept(frame) else { return }
        grantedToPeer -= 1
        if grantedToPeer < 0 { throw FrameError("packet without credit") }
        packetsReceived += 1
        bytesReceived += packet.count
        listener.onPacket(self, packet)
        return
      }
      switch try Frames.decodeControl(frame) {
      case .hello(let hello):
        if helloReceived { throw FrameError("second HELLO") }
        if hello.version != Frames.version {
          throw FrameError("unsupported version \(hello.version)")
        }
        if hello.maxPacket <= 0 || hello.credits <= 0 { throw FrameError("bad HELLO limits") }
        peerMaxPacket = hello.maxPacket
        sendCredits = hello.credits
        rememberToken(hello.token)
        helloReceived = true
        listener.onHello(self)
        pump()
      case .credit(let packets):
        sendCredits += packets
        if sendCredits > 0xffff { throw FrameError("credit overflow") }
        pump()
      case .token(let token):
        rememberToken(token)
        listener.onPeerToken(self)
      }
    } catch let error as FrameError {
      fail("protocol: \(error.message)")
    } catch {
      fail("protocol: \(error)")
    }
  }

  /// The app took `count` of this link's packets from the inbound queue.
  func returnCredits(_ count: Int) {
    if closed || count <= 0 { return }
    creditsOwed += count
    if creditsOwed < Link.creditBatch { return }
    control.append(Frames.encodeCredit(creditsOwed))
    grantedToPeer += creditsOwed
    creditsOwed = 0
    pump()
  }

  /// Tells the peer our new token, so it does not connect to us twice.
  func announceToken(_ token: [UInt8]) {
    if !up { return }
    control.append(Frames.encodeToken(token))
    pump()
  }

  /// The stack is ready for the next frame.
  func onWriteComplete(_ ok: Bool) {
    writing = false
    if closed { return }
    if !ok {
      fail("write failed")
      return
    }
    pump()
  }

  func knowsToken(_ token: [UInt8]) -> Bool {
    peerTokens.contains(token)
  }

  /// Marks the link closed and fails every waiting `send`. No listener call.
  func close() {
    if closed { return }
    closed = true
    let failed = waiting
    waiting.removeAll()
    for (_, done) in failed { done("link_down") }
  }

  private func fail(_ reason: String) {
    if closed { return }
    listener.onFailure(self, reason)
    close()
  }

  private func rememberToken(_ token: [UInt8]) {
    if knowsToken(token) { return }
    peerTokens.append(token)
    if peerTokens.count > Link.maxTokens { peerTokens.removeFirst() }
  }

  private func fits(_ packet: [UInt8]) -> Bool {
    outboundBytes == 0 || outboundBytes + packet.count <= Link.outboundCapBytes
  }

  private func admit(_ packet: [UInt8]) {
    outbound.append(packet)
    outboundBytes += packet.count
  }

  private func admitWaiting() {
    while let first = waiting.first, fits(first.0) {
      waiting.removeFirst()
      admit(first.0)
      first.1(nil)
    }
  }

  private func pump() {
    if writing || closed { return }
    let frame: [UInt8]
    if !control.isEmpty {
      frame = control.removeFirst()
    } else if let data = nextDataFrame() {
      frame = data
    } else {
      return
    }
    writing = true
    framesSent += 1
    if !sink(frame) {
      writing = false
      fail("write refused")
    }
  }

  private func nextDataFrame() -> [UInt8]? {
    if !helloReceived { return nil }
    var writer = current
    if writer == nil {
      if sendCredits == 0 || outbound.isEmpty { return nil }
      let packet = outbound.removeFirst()
      sendCredits -= 1
      writer = PacketWriter(packet)
      current = writer
    }
    guard let active = writer else { return nil }
    let frame = active.next(seq: txSeq, capacity: Frames.frameCapacity(mtu: mtu))
    txSeq = (txSeq + 1) & 0xffff
    if active.done {
      current = nil
      packetsSent += 1
      bytesSent += active.data.count
      outboundBytes -= active.data.count
      admitWaiting()
    }
    return frame
  }
}
