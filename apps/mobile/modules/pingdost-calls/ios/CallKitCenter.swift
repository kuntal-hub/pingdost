import AVFoundation
import CallKit
import PushKit
import UIKit

/// PushKit and CallKit for PingDost (Phase 29, ADR 0032). One instance for the whole process,
/// started by `CallsAppDelegate` at launch: a VoIP push can launch the app before any JS runs,
/// and iOS requires every VoIP push to be reported to CallKit before its handler returns (an
/// app that does not gets killed and, after repeats, stops receiving VoIP pushes).
///
/// The push carries nothing but `{"t":"call"}`, so the call is reported as "PingDost"; the JS
/// side (`src/calls/callkit.ts`) binds it to the E2EE invite once that arrives and updates the
/// name. A push call that nobody binds within `pushSafetySeconds` is ended here, in case the JS
/// side never starts.
///
/// Calls are kept out of the Phone app's Recents (`includesCallsInRecents = false`): Recents
/// syncs through iCloud, and the call history is per device by design (ADR 0028).
final class CallKitCenter: NSObject, CXProviderDelegate, PKPushRegistryDelegate {
  static let shared = CallKitCenter()

  /// Longer than the JS invite wait (20 s), so JS normally ends unanswered calls itself.
  private let pushSafetySeconds: TimeInterval = 30

  private let provider: CXProvider
  private let controller = CXCallController()
  private let observer = CXCallObserver()
  private var registry: PKPushRegistry?

  /// Guards the state below: JS reads it synchronously from its own thread.
  private let lock = NSLock()
  private var token: String?
  private var pendingPush: [UUID] = []
  private var ours = Set<UUID>()
  private var videoCalls = Set<UUID>()
  private var safety: [UUID: DispatchWorkItem] = [:]
  /// CallKit actions and audio changes from before JS listened.
  private var queued: [[String: Any]] = []
  private var emitter: ((String, [String: Any]) -> Void)?

  private override init() {
    let configuration = CXProviderConfiguration()
    configuration.supportsVideo = true
    configuration.maximumCallGroups = 1
    configuration.maximumCallsPerCallGroup = 1
    configuration.supportedHandleTypes = [.generic]
    configuration.includesCallsInRecents = false
    provider = CXProvider(configuration: configuration)
    super.init()
    provider.setDelegate(self, queue: nil)
  }

  /// Registers for VoIP pushes. Must run on every launch, before the launch finishes.
  func start() {
    DispatchQueue.main.async {
      guard self.registry == nil else { return }
      let registry = PKPushRegistry(queue: .main)
      registry.delegate = self
      registry.desiredPushTypes = [.voIP]
      self.registry = registry
    }
  }

  // MARK: - JS-facing state

  var voipToken: String? {
    lock.lock()
    defer { lock.unlock() }
    return token
  }

  /// Set while JS observes events; events before that are queued.
  func setEmitter(_ emit: ((String, [String: Any]) -> Void)?) {
    lock.lock()
    emitter = emit
    lock.unlock()
  }

  func takeQueuedEvents() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    let events = queued
    queued.removeAll()
    return events
  }

  func pendingPushCalls() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return pendingPush.map { $0.uuidString.lowercased() }
  }

  private func emit(_ name: String, _ body: [String: Any], queueIfUnheard: Bool) {
    lock.lock()
    let emit = emitter
    if emit == nil && queueIfUnheard { queued.append(body) }
    lock.unlock()
    emit?(name, body)
  }

  private func callKitEvent(_ body: [String: Any]) {
    emit("callkit", body, queueIfUnheard: true)
  }

  private func id(_ uuid: UUID) -> String {
    uuid.uuidString.lowercased()
  }

  // MARK: - Calls from JS

  func reportIncoming(uuid: String, name: String, video: Bool) {
    guard let uuid = UUID(uuidString: uuid) else { return }
    track(uuid, video: video)
    provider.reportNewIncomingCall(with: uuid, update: update(name: name, video: video)) {
      [weak self] error in
      guard let self, error != nil else { return }
      // Do Not Disturb, a blocked caller or a system call: CallKit refused it.
      self.finished(uuid)
      self.callKitEvent(["type": "end", "uuid": self.id(uuid)])
    }
  }

  func updateCall(uuid: String, name: String, video: Bool) {
    guard let uuid = UUID(uuidString: uuid) else { return }
    lock.lock()
    if video { videoCalls.insert(uuid) } else { videoCalls.remove(uuid) }
    lock.unlock()
    provider.reportCall(with: uuid, updated: update(name: name, video: video))
  }

  func bindPushCall(uuid: String) {
    guard let uuid = UUID(uuidString: uuid) else { return }
    lock.lock()
    pendingPush.removeAll { $0 == uuid }
    let timer = safety.removeValue(forKey: uuid)
    lock.unlock()
    timer?.cancel()
  }

  func startOutgoing(uuid: String, name: String, video: Bool) {
    guard let uuid = UUID(uuidString: uuid) else { return }
    track(uuid, video: video)
    let action = CXStartCallAction(call: uuid, handle: CXHandle(type: .generic, value: name))
    action.isVideo = video
    action.contactIdentifier = name
    controller.request(CXTransaction(action: action)) { [weak self] error in
      guard let self, error != nil else { return }
      self.finished(uuid)
    }
  }

  func reportConnected(uuid: String) {
    guard let uuid = UUID(uuidString: uuid) else { return }
    provider.reportOutgoingCall(with: uuid, connectedAt: nil)
  }

  /// `local`: the user hung up in the app (an end action); anything else: the call ended
  /// elsewhere, with that reason.
  func endCall(uuid: String, reason: String) {
    guard let uuid = UUID(uuidString: uuid) else { return }
    if reason == "local" {
      controller.request(CXTransaction(action: CXEndCallAction(call: uuid))) { [weak self] error in
        guard let self, error != nil else { return }
        self.provider.reportCall(with: uuid, endedAt: nil, reason: .remoteEnded)
        self.finished(uuid)
      }
      return
    }
    let ended: CXCallEndedReason
    switch reason {
    case "unanswered": ended = .unanswered
    case "answeredElsewhere": ended = .answeredElsewhere
    case "declinedElsewhere": ended = .declinedElsewhere
    case "failed": ended = .failed
    default: ended = .remoteEnded
    }
    provider.reportCall(with: uuid, endedAt: nil, reason: ended)
    finished(uuid)
  }

  /// Another app's or a phone call is going on (PingDost then answers invites busy).
  func inSystemCall() -> Bool {
    lock.lock()
    let mine = ours
    lock.unlock()
    return observer.calls.contains { !$0.hasEnded && !mine.contains($0.uuid) }
  }

  // MARK: - Audio

  /// Before CallKit activates the session: voice chat (earpiece) or video chat (speaker).
  func configureAudioSession(video: Bool) {
    let session = AVAudioSession.sharedInstance()
    try? session.setCategory(
      .playAndRecord,
      mode: video ? .videoChat : .voiceChat,
      options: [.allowBluetooth])
  }

  func audioRoutes() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    var available = ["earpiece", "speaker"]
    let inputs = session.availableInputs ?? []
    let outputs = session.currentRoute.outputs
    if inputs.contains(where: { $0.portType == .headsetMic })
      || outputs.contains(where: { $0.portType == .headphones })
    {
      available.append("headset")
    }
    let bluetoothPorts: [AVAudioSession.Port] = [.bluetoothHFP, .bluetoothA2DP, .bluetoothLE]
    if inputs.contains(where: { $0.portType == .bluetoothHFP })
      || outputs.contains(where: { bluetoothPorts.contains($0.portType) })
    {
      available.append("bluetooth")
    }
    var current: Any = NSNull()
    if let port = outputs.first?.portType {
      if port == .builtInReceiver {
        current = "earpiece"
      } else if port == .builtInSpeaker {
        current = "speaker"
      } else if port == .headphones || port == .headsetMic {
        current = "headset"
      } else if bluetoothPorts.contains(port) {
        current = "bluetooth"
      }
    }
    return ["available": available, "current": current]
  }

  func setAudioRoute(_ route: String) -> Bool {
    let session = AVAudioSession.sharedInstance()
    let inputs = session.availableInputs ?? []
    do {
      switch route {
      case "speaker":
        try session.overrideOutputAudioPort(.speaker)
      case "earpiece":
        try session.overrideOutputAudioPort(.none)
        if let mic = inputs.first(where: { $0.portType == .builtInMic }) {
          try session.setPreferredInput(mic)
        }
      case "headset":
        guard let headset = inputs.first(where: { $0.portType == .headsetMic }) else { return false }
        try session.overrideOutputAudioPort(.none)
        try session.setPreferredInput(headset)
      case "bluetooth":
        guard let bluetooth = inputs.first(where: { $0.portType == .bluetoothHFP }) else {
          return false
        }
        try session.overrideOutputAudioPort(.none)
        try session.setPreferredInput(bluetooth)
      default:
        return false
      }
      return true
    } catch {
      return false
    }
  }

  // MARK: - PKPushRegistryDelegate

  func pushRegistry(
    _ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType
  ) {
    guard type == .voIP else { return }
    let value = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
    lock.lock()
    token = value
    lock.unlock()
    emit("voipToken", ["token": value], queueIfUnheard: false)
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    guard type == .voIP else { return }
    lock.lock()
    token = nil
    lock.unlock()
    emit("voipToken", ["token": NSNull()], queueIfUnheard: false)
  }

  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }
    // Reported before returning, whatever the payload says (iOS 13+ rule).
    let uuid = UUID()
    track(uuid, video: false)
    provider.reportNewIncomingCall(with: uuid, update: update(name: "PingDost", video: false)) {
      [weak self] error in
      DispatchQueue.main.async {
        defer { completion() }
        guard let self else { return }
        if error != nil {
          self.finished(uuid)
          return
        }
        self.awaitInvite(uuid)
        self.emit("callkit", ["type": "push", "uuid": self.id(uuid)], queueIfUnheard: false)
      }
    }
  }

  private func awaitInvite(_ uuid: UUID) {
    let timer = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.lock.lock()
      let waiting = self.pendingPush.contains(uuid)
      self.lock.unlock()
      guard waiting else { return }
      self.provider.reportCall(with: uuid, endedAt: nil, reason: .unanswered)
      self.finished(uuid)
    }
    lock.lock()
    pendingPush.append(uuid)
    safety[uuid] = timer
    lock.unlock()
    DispatchQueue.main.asyncAfter(deadline: .now() + pushSafetySeconds, execute: timer)
  }

  // MARK: - CXProviderDelegate

  func providerDidReset(_ provider: CXProvider) {
    lock.lock()
    let calls = ours
    lock.unlock()
    for uuid in calls {
      finished(uuid)
      callKitEvent(["type": "end", "uuid": id(uuid)])
    }
  }

  func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
    lock.lock()
    let video = videoCalls.contains(action.callUUID)
    lock.unlock()
    configureAudioSession(video: video)
    callKitEvent(["type": "answer", "uuid": id(action.callUUID)])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
    finished(action.callUUID)
    callKitEvent(["type": "end", "uuid": id(action.callUUID)])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
    configureAudioSession(video: action.isVideo)
    provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
    callKitEvent(["type": "mute", "uuid": id(action.callUUID), "muted": action.isMuted])
    action.fulfill()
  }

  func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
    // No hold: PingDost has one call at a time.
    action.fail()
  }

  func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
    callKitEvent(["type": "audio", "active": true])
  }

  func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
    callKitEvent(["type": "audio", "active": false])
  }

  // MARK: - Bookkeeping

  private func update(name: String, video: Bool) -> CXCallUpdate {
    let update = CXCallUpdate()
    update.remoteHandle = CXHandle(type: .generic, value: name)
    update.localizedCallerName = name
    update.hasVideo = video
    update.supportsHolding = false
    update.supportsGrouping = false
    update.supportsUngrouping = false
    update.supportsDTMF = false
    return update
  }

  private func track(_ uuid: UUID, video: Bool) {
    lock.lock()
    ours.insert(uuid)
    if video { videoCalls.insert(uuid) }
    lock.unlock()
  }

  private func finished(_ uuid: UUID) {
    lock.lock()
    ours.remove(uuid)
    videoCalls.remove(uuid)
    pendingPush.removeAll { $0 == uuid }
    let timer = safety.removeValue(forKey: uuid)
    lock.unlock()
    timer?.cancel()
  }
}
