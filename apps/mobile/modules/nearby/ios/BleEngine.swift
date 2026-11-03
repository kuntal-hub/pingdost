import CoreBluetooth
import Foundation
import UIKit

typealias Reply = (Any?, String?) -> Void

struct StartConfig: Equatable {
  var rotationSeconds = 600
  var autoConnect = false
  var advertise = true
  var scan = true
}

/// The iOS nearby engine (Phase 30, ADR 0033): CoreBluetooth in both roles with the GATT layout,
/// framing, credits and events of Android's `BleEngine.kt` (ADR 0023), so iPhones and Android
/// phones link to each other and the JS layer (`src/transport.ts`) runs unchanged.
///
/// Differences that iOS forces:
/// - iOS cannot advertise service data, so an iPhone's token travels only in the link HELLO, and
///   Android (which connects only to peers whose advertised token it sees) never connects to an
///   iPhone. The iPhone therefore connects to every PingDost peer it is not linked to yet
///   (`ConnectPolicy`); between two iPhones the duplicate rule closes one link.
/// - In the background iOS moves the service UUID to its "overflow" area: other iPhones find it
///   only while they are in the foreground, Android phones not at all. Background scanning works
///   but slower. Nothing here promises continuous background operation (REQ §11.5).
/// - State preservation and restoration: the managers use restore identifiers, so iOS can relaunch
///   the app for Bluetooth events after it was suspended or terminated by the system (not after a
///   force-quit). Link state is not restorable: restored connections are dropped and redone.
/// - There is no way to disconnect a central from the peripheral side, and no foreground service.
///
/// All state lives on `queue`; the managers deliver their callbacks there.
final class BleEngine: NSObject, CBCentralManagerDelegate, CBPeripheralManagerDelegate,
  CBPeripheralDelegate, LinkListener
{
  static let shared = BleEngine()

  static let serviceUUID = CBUUID(string: "5DD57EAF-834A-4B2D-96F6-B68A646C4A0B")
  static let rxUUID = CBUUID(string: "AA6298CF-710A-43A7-A85E-42EAE340DC5A")
  static let txUUID = CBUUID(string: "5A378FA3-6EE8-409F-BCD4-99790BC7FEEC")
  static let maxLinks = 7

  private static let connectTimeout: TimeInterval = 20
  private static let peerTtlMs: Double = 30_000
  private static let peerReportMs: Double = 2_000
  private static let watchSeconds: TimeInterval = 5
  private static let autoConnectBackoffMs: Double = 10_000
  private static let restoreCentral = "com.pingdost.nearby.central"
  private static let restorePeripheral = "com.pingdost.nearby.peripheral"
  private static let wantedKey = "pingdost.nearby.wanted"
  private static let configKey = "pingdost.nearby.config"

  private let queue = DispatchQueue(label: "com.pingdost.nearby")
  private let emitterLock = NSLock()
  private var emitter: ((String, [String: Any]) -> Void)?

  private var central: CBCentralManager?
  private var peripheralManager: CBPeripheralManager?
  private var config = StartConfig()
  private var wanted = false
  private var scanning = false
  private var advertising = false
  private var service: CBMutableService?
  private var tx: CBMutableCharacteristic?
  private var serviceReady = false
  private var token = Tokens.random()
  private var permissionWaiters: [(String) -> Void] = []

  private final class Peer {
    var peripheral: CBPeripheral
    let firstSeen: Double
    var token: [UInt8]?
    var rssi = 0
    var lastSeen: Double
    var lastReport: Double = 0

    init(peripheral: CBPeripheral, now: Double) {
      self.peripheral = peripheral
      firstSeen = now
      lastSeen = now
    }
  }

  private final class Client {
    let peripheral: CBPeripheral
    var rx: CBCharacteristic?
    var pending: [UInt8]?

    init(peripheral: CBPeripheral) { self.peripheral = peripheral }
  }

  private var peers: [String: Peer] = [:]
  private var links: [Int: Link] = [:]
  /// Our GATT client connections (central role), by link ID.
  private var clients: [Int: Client] = [:]
  private var linkByPeripheral: [UUID: Int] = [:]
  /// Remote centrals subscribed to our TX (peripheral role), by link ID.
  private var subscribers: [Int: CBCentral] = [:]
  private var linkByCentral: [UUID: Int] = [:]
  /// Notifications iOS had no room for, sent again when it is ready.
  private var pendingNotify: [(linkId: Int, frame: [UInt8])] = []
  private var pendingConnects: [Int: Reply] = [:]
  private var autoConnectTried: [String: Double] = [:]
  /// Tokens learned over earlier links, by address: a peer we are linked to is not dialled again.
  private var knownTokens: [String: [UInt8]] = [:]
  private var nextLinkId = 1
  let inbound = InboundQueue()
  private var watchTimer: DispatchSourceTimer?
  private var rotateTimer: DispatchSourceTimer?

  /// Read on the main thread, used on `queue`.
  private var power: [String: Any] = [:]
  private var appActive = false

  private override init() {
    super.init()
    if let stored = UserDefaults.standard.dictionary(forKey: BleEngine.configKey) {
      config.rotationSeconds = stored["rotationSeconds"] as? Int ?? 600
      config.autoConnect = stored["autoConnect"] as? Bool ?? false
      config.advertise = stored["advertise"] as? Bool ?? true
      config.scan = stored["scan"] as? Bool ?? true
    }
    DispatchQueue.main.async { self.observeApp() }
  }

  // MARK: - Public API (any thread)

  func setEmitter(_ emit: ((String, [String: Any]) -> Void)?) {
    emitterLock.lock()
    emitter = emit
    emitterLock.unlock()
  }

  /// Called at launch when iOS relaunched the app for a Bluetooth event: recreate the managers
  /// with the same identifiers so CoreBluetooth can hand back their state.
  func restoreAfterLaunch() {
    queue.async {
      guard UserDefaults.standard.bool(forKey: BleEngine.wantedKey) else { return }
      self.wanted = true
      self.ensureManagers()
      self.startWatch()
    }
  }

  func state(_ reply: @escaping Reply) {
    queue.async { reply(self.stateMap(), nil) }
  }

  func start(_ next: StartConfig, _ reply: @escaping Reply) {
    queue.async {
      if let reason = self.unsupportedReason() { return reply(nil, reason) }
      if self.authorizationDenied() { return reply(nil, "permission") }
      let restart = self.wanted && next != self.config
      self.config = next
      self.wanted = true
      self.persist()
      if restart { self.stopRadios() }
      self.ensureManagers()
      self.bringUp()
      self.startWatch()
      self.emitState()
      reply(nil, nil)
    }
  }

  func stop(_ reply: @escaping Reply) {
    queue.async {
      self.wanted = false
      self.persist()
      self.tearDown("stopped")
      self.watchTimer?.cancel()
      self.watchTimer = nil
      self.emitState()
      reply(nil, nil)
    }
  }

  func rotateToken(_ reply: @escaping Reply) {
    queue.async {
      self.rotate()
      reply(Tokens.hex(self.token), nil)
    }
  }

  func connect(_ address: String, _ reply: @escaping Reply) {
    queue.async { self.openClient(address, reply) }
  }

  func disconnect(_ linkId: Int, _ reply: @escaping Reply) {
    queue.async {
      if let link = self.links[linkId] { self.failLink(link, "closed") }
      reply(nil, nil)
    }
  }

  /// Resolves once the packet is in the link's queue (not when it is delivered).
  func send(_ linkId: Int, _ packet: [UInt8], _ reply: @escaping Reply) {
    queue.async {
      guard let link = self.links[linkId] else { return reply(nil, "link_down") }
      link.send(packet) { error in reply(nil, error) }
    }
  }

  /// Takes queued inbound packets (see `InboundQueue`); their credits go back to the senders.
  func receive(_ maxBytes: Int) -> [UInt8] {
    let (batch, counts) = inbound.take(maxBytes: maxBytes)
    if !counts.isEmpty {
      queue.async {
        for (id, count) in counts { self.links[id]?.returnCredits(count) }
      }
    }
    return batch
  }

  /// Shows the Bluetooth permission prompt if it was never answered: `granted`, `denied` or
  /// `blocked` (only Settings can change it now).
  func requestPermission(_ done: @escaping (String) -> Void) {
    queue.async {
      switch CBManager.authorization {
      case .allowedAlways: done("granted")
      case .denied, .restricted: done("blocked")
      default:
        self.permissionWaiters.append(done)
        self.ensureManagers()
      }
    }
  }

  // MARK: - Managers and radios

  private func ensureManagers() {
    if central == nil {
      central = CBCentralManager(
        delegate: self, queue: queue,
        options: [
          CBCentralManagerOptionRestoreIdentifierKey: BleEngine.restoreCentral,
          CBCentralManagerOptionShowPowerAlertKey: false,
        ])
    }
    if peripheralManager == nil {
      peripheralManager = CBPeripheralManager(
        delegate: self, queue: queue,
        options: [
          CBPeripheralManagerOptionRestoreIdentifierKey: BleEngine.restorePeripheral,
          CBPeripheralManagerOptionShowPowerAlertKey: false,
        ])
    }
  }

  private func persist() {
    UserDefaults.standard.set(wanted, forKey: BleEngine.wantedKey)
    UserDefaults.standard.set(
      [
        "rotationSeconds": config.rotationSeconds, "autoConnect": config.autoConnect,
        "advertise": config.advertise, "scan": config.scan,
      ], forKey: BleEngine.configKey)
  }

  private func bringUp() {
    guard wanted else { return }
    if config.advertise, peripheralManager?.state == .poweredOn { openService() }
    if config.scan, central?.state == .poweredOn { startScan() }
    scheduleRotation()
  }

  private func stopRadios() {
    stopScan()
    stopAdvertising()
  }

  private func tearDown(_ reason: String) {
    stopRadios()
    rotateTimer?.cancel()
    rotateTimer = nil
    for link in Array(links.values) { failLink(link, reason) }
    if let service { peripheralManager?.remove(service) }
    service = nil
    tx = nil
    serviceReady = false
    pendingNotify.removeAll()
    peers.removeAll()
  }

  private func openService() {
    guard let manager = peripheralManager else { return }
    if serviceReady {
      startAdvertising()
      return
    }
    if service != nil { return }  // being added
    let rx = CBMutableCharacteristic(
      type: BleEngine.rxUUID, properties: [.write, .writeWithoutResponse], value: nil,
      permissions: [.writeable])
    let notify = CBMutableCharacteristic(
      type: BleEngine.txUUID, properties: [.notify], value: nil, permissions: [.readable])
    let primary = CBMutableService(type: BleEngine.serviceUUID, primary: true)
    primary.characteristics = [rx, notify]
    service = primary
    tx = notify
    manager.add(primary)
  }

  private func startAdvertising() {
    guard let manager = peripheralManager, !manager.isAdvertising, wanted, config.advertise else {
      return
    }
    // Only the service UUID: no name, and iOS cannot advertise service data (the token).
    manager.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [BleEngine.serviceUUID]])
  }

  private func stopAdvertising() {
    peripheralManager?.stopAdvertising()
    advertising = false
  }

  private func startScan() {
    guard let central, !scanning else { return }
    // A service filter is required for background scanning; duplicates (RSSI updates) are
    // reported only in the foreground.
    central.scanForPeripherals(
      withServices: [BleEngine.serviceUUID],
      options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
    scanning = true
    log("scanning")
  }

  private func stopScan() {
    guard scanning else { return }
    central?.stopScan()
    scanning = false
  }

  private func scheduleRotation() {
    rotateTimer?.cancel()
    let seconds = Double(min(max(config.rotationSeconds, 30), 3_600))
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + seconds, repeating: seconds)
    timer.setEventHandler { [weak self] in self?.rotate() }
    timer.resume()
    rotateTimer = timer
  }

  /// A new token: only links carry it on iOS (TOKEN frames), so linked peers keep recognising us.
  private func rotate() {
    token = Tokens.random()
    for link in links.values { link.announceToken(token) }
    log("rotated the token")
    emitState()
  }

  private func startWatch() {
    guard watchTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now() + BleEngine.watchSeconds, repeating: BleEngine.watchSeconds)
    timer.setEventHandler { [weak self] in self?.watch() }
    timer.resume()
    watchTimer = timer
  }

  /// Expires peers not seen for a while.
  private func watch() {
    let now = Self.nowMs()
    for (address, peer) in peers where now - peer.lastSeen > BleEngine.peerTtlMs {
      peers.removeValue(forKey: address)
      emit("peerLost", ["address": address])
    }
    autoConnectTried = autoConnectTried.filter { now - $0.value <= BleEngine.peerTtlMs }
    DispatchQueue.main.async { self.refreshPower() }
  }

  // MARK: - CBCentralManagerDelegate

  func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
    // Link state (sequence numbers, credits) died with the process: start the links over.
    let restored = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] ?? []
    for peripheral in restored { central.cancelPeripheralConnection(peripheral) }
    log("restored by iOS (\(restored.count) connections dropped)")
  }

  func centralManagerDidUpdateState(_ central: CBCentralManager) {
    if central.state != .unknown && central.state != .resetting {
      let answer = CBManager.authorization == .allowedAlways ? "granted" : "blocked"
      let waiters = permissionWaiters
      permissionWaiters.removeAll()
      for done in waiters { done(answer) }
    }
    switch central.state {
    case .poweredOn:
      log("Bluetooth is on")
      bringUp()
    case .poweredOff:
      bluetoothLost("bluetooth_off")
      log("Bluetooth is off")
    case .unauthorized:
      bluetoothLost("permission")
    default:
      break
    }
    emitState()
  }

  private func bluetoothLost(_ reason: String) {
    scanning = false
    advertising = false
    for link in Array(links.values) { failLink(link, reason) }
    pendingNotify.removeAll()
    peers.removeAll()
  }

  func centralManager(
    _ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
    advertisementData: [String: Any], rssi RSSI: NSNumber
  ) {
    guard scanning else { return }
    let address = peripheral.identifier.uuidString.lowercased()
    // Android puts its token in the scan response as service data (foreground scans see it).
    var advertised: [UInt8]?
    if let serviceData = advertisementData[CBAdvertisementDataServiceDataKey] as? [CBUUID: Data],
      let data = serviceData[BleEngine.serviceUUID], data.count == Frames.tokenBytes
    {
      advertised = [UInt8](data)
    }
    let now = Self.nowMs()
    let known = peers[address]
    let peer = known ?? Peer(peripheral: peripheral, now: now)
    peers[address] = peer
    let tokenChanged = advertised != nil && peer.token != advertised
    if let advertised { peer.token = advertised }
    peer.peripheral = peripheral
    peer.rssi = RSSI.intValue
    peer.lastSeen = now
    if known == nil || tokenChanged || now - peer.lastReport >= BleEngine.peerReportMs {
      peer.lastReport = now
      var body = peerMap(address, peer)
      body["first"] = known == nil
      emit("peerDiscovered", body)
    }
    if config.autoConnect { maybeAutoConnect(address, peer.token, now) }
  }

  private func maybeAutoConnect(_ address: String, _ advertised: [UInt8]?, _ now: Double) {
    let connect = ConnectPolicy.shouldConnect(
      address: address, knownToken: advertised ?? knownTokens[address],
      links: Array(links.values), maxLinks: BleEngine.maxLinks,
      lastTriedMs: autoConnectTried[address], nowMs: now,
      backoffMs: BleEngine.autoConnectBackoffMs)
    guard connect else { return }
    autoConnectTried[address] = now
    log("auto-connecting to \(address)")
    openClient(address) { [weak self] _, error in
      if let error { self?.log("auto-connect to \(address) failed: \(error)") }
    }
  }

  func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
    guard linkByPeripheral[peripheral.identifier] != nil else {
      central.cancelPeripheralConnection(peripheral)
      return
    }
    peripheral.delegate = self
    peripheral.discoverServices([BleEngine.serviceUUID])
  }

  func centralManager(
    _ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?
  ) {
    if let link = clientLink(peripheral) { failLink(link, "connect failed") }
  }

  func centralManager(
    _ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?
  ) {
    if let link = clientLink(peripheral) { failLink(link, "disconnected") }
  }

  // MARK: - Central role (we connect)

  private func clientLink(_ peripheral: CBPeripheral) -> Link? {
    linkByPeripheral[peripheral.identifier].flatMap { links[$0] }
  }

  private func openClient(_ address: String, _ done: @escaping Reply) {
    if let reason = unsupportedReason() { return done(nil, reason) }
    guard let central, central.state == .poweredOn else { return done(nil, "bluetooth_off") }
    if authorizationDenied() { return done(nil, "permission") }
    if links.count >= BleEngine.maxLinks { return done(nil, "too_many_links") }
    if let existing = links.values.first(where: { $0.role == .central && $0.address == address }) {
      return existing.up ? done(linkMap(existing), nil) : done(nil, "connecting")
    }
    let peripheral =
      peers[address]?.peripheral
      ?? UUID(uuidString: address).flatMap { central.retrievePeripherals(withIdentifiers: [$0]).first }
    guard let peripheral else { return done(nil, "error") }
    let id = nextLinkId
    nextLinkId += 1
    let link = Link(
      id: id, role: .central, address: address, localToken: token,
      sink: { [weak self] frame in self?.clientWrite(id, frame) ?? false }, listener: self)
    links[id] = link
    clients[id] = Client(peripheral: peripheral)
    linkByPeripheral[peripheral.identifier] = id
    pendingConnects[id] = done
    log("link \(id): connecting to \(address)")
    central.connect(peripheral, options: nil)
    queue.asyncAfter(deadline: .now() + BleEngine.connectTimeout) { [weak self, weak link] in
      guard let self, let link, !link.closed, !link.up else { return }
      self.failLink(link, "timeout")
    }
  }

  func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
    guard let link = clientLink(peripheral) else { return }
    guard error == nil,
      let service = peripheral.services?.first(where: { $0.uuid == BleEngine.serviceUUID })
    else { return failLink(link, "not a PingDost peer") }
    peripheral.discoverCharacteristics([BleEngine.rxUUID, BleEngine.txUUID], for: service)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?
  ) {
    guard let link = clientLink(peripheral), let client = clients[link.id] else { return }
    let rx = service.characteristics?.first { $0.uuid == BleEngine.rxUUID }
    let notify = service.characteristics?.first { $0.uuid == BleEngine.txUUID }
    guard error == nil, let rx, let notify else {
      return failLink(link, "PingDost service incomplete")
    }
    client.rx = rx
    peripheral.setNotifyValue(true, for: notify)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic,
    error: Error?
  ) {
    guard let link = clientLink(peripheral), characteristic.uuid == BleEngine.txUUID else { return }
    guard error == nil, characteristic.isNotifying else { return failLink(link, "subscribe failed") }
    link.mtu = peripheral.maximumWriteValueLength(for: .withoutResponse) + Frames.attOverhead
    log("link \(link.id): subscribed (MTU \(link.mtu))")
    link.start()
    maybeUp(link)
  }

  func peripheral(
    _ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?
  ) {
    guard characteristic.uuid == BleEngine.txUUID, error == nil, let value = characteristic.value,
      let link = clientLink(peripheral)
    else { return }
    link.onFrame([UInt8](value))
  }

  func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
    guard let link = clientLink(peripheral), let client = clients[link.id],
      let frame = client.pending
    else { return }
    client.pending = nil
    writeNow(link, client, frame)
  }

  private func clientWrite(_ id: Int, _ frame: [UInt8]) -> Bool {
    guard let link = links[id], let client = clients[id], client.rx != nil else { return false }
    if client.peripheral.canSendWriteWithoutResponse {
      writeNow(link, client, frame)
    } else {
      client.pending = frame
    }
    return true
  }

  /// Writes without response have no completion: iOS took the frame once it had room.
  private func writeNow(_ link: Link, _ client: Client, _ frame: [UInt8]) {
    guard let rx = client.rx else { return link.onWriteComplete(false) }
    client.peripheral.writeValue(Data(frame), for: rx, type: .withoutResponse)
    queue.async { link.onWriteComplete(true) }
  }

  // MARK: - CBPeripheralManagerDelegate (the peer connects to us)

  func peripheralManager(_ peripheral: CBPeripheralManager, willRestoreState dict: [String: Any]) {
    let services = dict[CBPeripheralManagerRestoredStateServicesKey] as? [CBMutableService] ?? []
    if let restored = services.first(where: { $0.uuid == BleEngine.serviceUUID }) {
      service = restored
      tx = restored.characteristics?.first { $0.uuid == BleEngine.txUUID } as? CBMutableCharacteristic
      serviceReady = tx != nil
    }
  }

  func peripheralManagerDidUpdateState(_ peripheral: CBPeripheralManager) {
    if peripheral.state == .poweredOn {
      bringUp()
    } else {
      advertising = false
      if peripheral.state == .poweredOff || peripheral.state == .resetting {
        // iOS drops the service when Bluetooth goes off.
        service = nil
        tx = nil
        serviceReady = false
      }
    }
    emitState()
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didAdd service: CBService, error: Error?) {
    if let error {
      log("GATT service not added (\(error.localizedDescription))")
      self.service = nil
      tx = nil
      return
    }
    serviceReady = true
    startAdvertising()
  }

  func peripheralManagerDidStartAdvertising(_ peripheral: CBPeripheralManager, error: Error?) {
    advertising = error == nil
    log(advertising ? "advertising" : "advertising failed")
    emitState()
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager, central: CBCentral,
    didSubscribeTo characteristic: CBCharacteristic
  ) {
    guard characteristic.uuid == BleEngine.txUUID, linkByCentral[central.identifier] == nil else {
      return
    }
    let address = central.identifier.uuidString.lowercased()
    guard wanted, links.count < BleEngine.maxLinks else {
      // iOS cannot drop a central from this side; it simply gets no HELLO and times out.
      log("ignored \(address) (\(wanted ? "too many links" : "nearby is off"))")
      return
    }
    let id = nextLinkId
    nextLinkId += 1
    let link = Link(
      id: id, role: .peripheral, address: address, localToken: token,
      sink: { [weak self] frame in self?.notify(id, frame) ?? false }, listener: self)
    link.mtu = central.maximumUpdateValueLength + Frames.attOverhead
    links[id] = link
    subscribers[id] = central
    linkByCentral[central.identifier] = id
    log("link \(id): \(address) subscribed (MTU \(link.mtu))")
    link.start()
    queue.asyncAfter(deadline: .now() + BleEngine.connectTimeout) { [weak self, weak link] in
      guard let self, let link, !link.closed, !link.up else { return }
      self.failLink(link, "timeout")
    }
  }

  func peripheralManager(
    _ peripheral: CBPeripheralManager, central: CBCentral,
    didUnsubscribeFrom characteristic: CBCharacteristic
  ) {
    guard characteristic.uuid == BleEngine.txUUID,
      let link = linkByCentral[central.identifier].flatMap({ links[$0] })
    else { return }
    failLink(link, "disconnected")
  }

  func peripheralManager(_ peripheral: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
    for request in requests where request.characteristic.uuid == BleEngine.rxUUID && request.offset == 0 {
      guard let value = request.value,
        let link = linkByCentral[request.central.identifier].flatMap({ links[$0] })
      else { continue }
      link.onFrame([UInt8](value))
    }
    // Writes with response (not used by PingDost, but allowed) need exactly one answer.
    if let first = requests.first { peripheral.respond(to: first, withResult: .success) }
  }

  func peripheralManagerIsReady(toUpdateSubscribers peripheral: CBPeripheralManager) {
    while let next = pendingNotify.first {
      guard let link = links[next.linkId], let central = subscribers[next.linkId], let tx else {
        pendingNotify.removeFirst()
        continue
      }
      if !peripheral.updateValue(Data(next.frame), for: tx, onSubscribedCentrals: [central]) {
        return  // still full: wait for the next call
      }
      pendingNotify.removeFirst()
      queue.async { link.onWriteComplete(true) }
    }
  }

  private func notify(_ id: Int, _ frame: [UInt8]) -> Bool {
    guard let manager = peripheralManager, let tx, let central = subscribers[id], let link = links[id]
    else { return false }
    if pendingNotify.isEmpty && manager.updateValue(Data(frame), for: tx, onSubscribedCentrals: [central]) {
      queue.async { link.onWriteComplete(true) }
    } else {
      pendingNotify.append((id, frame))
    }
    return true
  }

  // MARK: - LinkListener

  func onHello(_ link: Link) { maybeUp(link) }

  func onPacket(_ link: Link, _ packet: [UInt8]) {
    let (notify, queued) = inbound.add(linkId: link.id, packet: packet)
    if notify { emit("packet", ["queued": queued]) }
  }

  func onPeerToken(_ link: Link) {
    if link.role == .central, let latest = link.peerTokens.last { knownTokens[link.address] = latest }
    log("link \(link.id): peer rotated its token")
  }

  func onFailure(_ link: Link, _ reason: String) { failLink(link, reason) }

  private func maybeUp(_ link: Link) {
    guard link.up, link.upAt == 0 else { return }
    if link.role == .central, let latest = link.peerTokens.last { knownTokens[link.address] = latest }
    switch ConnectPolicy.onUp(link, among: Array(links.values)) {
    case .closeNew(let existing):
      log("link \(link.id): duplicate of link \(existing.id), closing it")
      pendingConnects.removeValue(forKey: link.id)?(linkMap(existing), nil)
      failLink(link, "duplicate")
    case .keep(let duplicate):
      link.upAt = Self.nowMs()
      log("link \(link.id): up (\(link.role.rawValue), MTU \(link.mtu))")
      emit("linkUp", linkMap(link))
      pendingConnects.removeValue(forKey: link.id)?(linkMap(link), nil)
      if let duplicate {
        log("link \(duplicate.id): duplicate of link \(link.id), closing it")
        failLink(duplicate, "duplicate")
      }
    }
  }

  private func failLink(_ link: Link, _ reason: String) {
    guard links.removeValue(forKey: link.id) != nil else { return }
    let unsent = link.unsent
    let wasUp = link.upAt != 0
    link.close()
    if let client = clients.removeValue(forKey: link.id) {
      linkByPeripheral.removeValue(forKey: client.peripheral.identifier)
      central?.cancelPeripheralConnection(client.peripheral)
    }
    if let central = subscribers.removeValue(forKey: link.id) {
      linkByCentral.removeValue(forKey: central.identifier)
    }
    pendingNotify.removeAll { $0.linkId == link.id }
    pendingConnects.removeValue(forKey: link.id)?(nil, reason)
    log("link \(link.id): down (\(reason)\(unsent > 0 ? ", \(unsent) unsent" : ""))")
    if wasUp {
      emit("linkDown", ["id": link.id, "address": link.address, "reason": reason, "unsent": unsent])
    }
  }

  // MARK: - State

  private func unsupportedReason() -> String? {
    central?.state == .unsupported ? "no_ble" : nil
  }

  private func authorizationDenied() -> Bool {
    let status = CBManager.authorization
    return status == .denied || status == .restricted
  }

  private func missingPermissions() -> [String] {
    CBManager.authorization == .allowedAlways ? [] : ["bluetooth"]
  }

  /// JS `null` for a missing value.
  private func orNull(_ value: Any?) -> Any {
    value ?? NSNull()
  }

  private func stateMap() -> [String: Any] {
    let reason = unsupportedReason()
    let powerValue: Any? = power.isEmpty ? nil : power
    return [
      "supported": reason == nil,
      "unsupportedReason": orNull(reason),
      "enabled": central?.state == .poweredOn,
      "missingPermissions": missingPermissions(),
      "running": wanted,
      "advertising": advertising,
      "scanning": scanning,
      "autoConnect": config.autoConnect,
      "rotationSeconds": config.rotationSeconds,
      "token": Tokens.hex(token),
      "foregroundService": false,
      "le2MPhy": false,
      "extendedAdvertising": false,
      "multipleAdvertisement": false,
      "sdk": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
      "device": Self.deviceModel(),
      "power": orNull(powerValue),
      "inboundQueued": inbound.count,
      "links": links.values.sorted { $0.id < $1.id }.map { linkMap($0) },
      "peers": peers.map { peerMap($0.key, $0.value) },
    ]
  }

  private func linkMap(_ link: Link) -> [String: Any] {
    let peerToken: String? = link.peerTokens.last.map { Tokens.hex($0) }
    let setupMs: Double? = link.upAt != 0 ? link.upAt - link.createdAt : nil
    return [
      "id": link.id,
      "role": link.role.rawValue,
      "address": link.address,
      "peerToken": orNull(peerToken),
      "up": link.up,
      "mtu": link.mtu,
      "txPhy": link.txPhy,
      "rxPhy": link.rxPhy,
      "setupMs": orNull(setupMs),
      "upAt": link.upAt,
      "packetsSent": link.packetsSent,
      "packetsReceived": link.packetsReceived,
      "bytesSent": link.bytesSent,
      "bytesReceived": link.bytesReceived,
      "framesSent": link.framesSent,
      "framesReceived": link.framesReceived,
      "unsent": link.unsent,
      "outboundBytes": link.outboundBytes,
      "sendCredits": link.sendCredits,
    ]
  }

  private func peerMap(_ address: String, _ peer: Peer) -> [String: Any] {
    let now = Self.nowMs()
    let linked = links.values.contains { link in
      if link.address == address { return true }
      guard let token = peer.token else { return false }
      return link.knowsToken(token)
    }
    let token: String? = peer.token.map { Tokens.hex($0) }
    return [
      "address": address,
      "token": orNull(token),
      "rssi": peer.rssi,
      "seenAgoMs": now - peer.lastSeen,
      "knownForMs": now - peer.firstSeen,
      "linked": linked,
    ]
  }

  private func emitState() { emit("stateChanged", stateMap()) }

  private func log(_ message: String) {
    emit("log", ["message": message, "at": Self.nowMs()])
  }

  private func emit(_ name: String, _ body: [String: Any]) {
    emitterLock.lock()
    let emit = emitter
    emitterLock.unlock()
    emit?(name, body)
  }

  // MARK: - Main-thread facts (battery, foreground)

  private func observeApp() {
    UIDevice.current.isBatteryMonitoringEnabled = true
    let center = NotificationCenter.default
    for name in [
      UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification,
      UIDevice.batteryLevelDidChangeNotification, UIDevice.batteryStateDidChangeNotification,
      Notification.Name.NSProcessInfoPowerStateDidChange,
    ] {
      center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.refreshPower()
      }
    }
    refreshPower()
  }

  /// Main thread only.
  private func refreshPower() {
    let device = UIDevice.current
    let level = device.batteryLevel
    let active = UIApplication.shared.applicationState == .active
    let snapshot: [String: Any] = [
      "batteryPercent": level < 0 ? -1 : Int((level * 100).rounded()),
      "charging": device.batteryState == .charging || device.batteryState == .full,
      "powerSave": ProcessInfo.processInfo.isLowPowerModeEnabled,
      "deviceIdle": false,
      "ignoringBatteryOptimizations": true,
      "interactive": active,
      // Android's importance scale: 100 foreground, 400 cached.
      "importance": active ? 100 : 400,
    ]
    queue.async {
      self.power = snapshot
      self.appActive = active
    }
  }

  private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1_000 }

  private static func deviceModel() -> String {
    var info = utsname()
    uname(&info)
    let machine = withUnsafeBytes(of: &info.machine) { raw in
      String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
    }
    return "Apple \(machine)"
  }
}
