import AVFoundation
import ExpoModulesCore
import UIKit

/// `PingdostCalls` on iOS (Phase 29, ADR 0032). The same module name and Android-shaped
/// functions as `modules/pingdost-calls/android`, so the call runtime is shared; what CallKit
/// does on iOS (ringing, the incoming-call screen, the ongoing-call indicator, the lock screen)
/// is a no-op here. The CallKit functions are iOS-only (see `src/index.ts`).
public class CallsModule: Module {
  private var routeObserver: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("PingdostCalls")

    Events("action", "audioRoutes", "callkit", "voipToken")

    OnCreate {
      CallKitCenter.shared.start()
      self.routeObserver = NotificationCenter.default.addObserver(
        forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("audioRoutes", CallKitCenter.shared.audioRoutes())
      }
    }

    OnDestroy {
      if let observer = self.routeObserver { NotificationCenter.default.removeObserver(observer) }
      CallKitCenter.shared.setEmitter(nil)
    }

    OnStartObserving("callkit") {
      CallKitCenter.shared.setEmitter { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnStopObserving("callkit") {
      CallKitCenter.shared.setEmitter(nil)
    }

    // CallKit and PushKit (iOS only).
    Function("voipToken") { () -> String? in CallKitCenter.shared.voipToken }
    Function("takePendingCallKitEvents") { CallKitCenter.shared.takeQueuedEvents() }
    Function("pendingPushCalls") { CallKitCenter.shared.pendingPushCalls() }
    Function("reportIncoming") { (uuid: String, name: String, video: Bool) in
      CallKitCenter.shared.reportIncoming(uuid: uuid, name: name, video: video)
    }
    Function("updateCall") { (uuid: String, name: String, video: Bool) in
      CallKitCenter.shared.updateCall(uuid: uuid, name: name, video: video)
    }
    Function("startOutgoing") { (uuid: String, name: String, video: Bool) in
      CallKitCenter.shared.startOutgoing(uuid: uuid, name: name, video: video)
    }
    Function("reportConnected") { (uuid: String) in
      CallKitCenter.shared.reportConnected(uuid: uuid)
    }
    Function("endCall") { (uuid: String, reason: String) in
      CallKitCenter.shared.endCall(uuid: uuid, reason: reason)
    }
    Function("bindPushCall") { (uuid: String) in
      CallKitCenter.shared.bindPushCall(uuid: uuid)
    }

    // The shared surface. Android's notification actions do not exist here: CallKit reports
    // its actions as `callkit` events.
    Function("takePendingActions") { () -> [[String: String]] in [] }
    Function("showIncoming") { (_: String, _: String, _: Bool) in }
    Function("cancelIncoming") {}
    Function("startOngoing") { (_: String, _: String, _: Bool) in }
    Function("stopOngoing") {}
    Function("startAudio") { (video: Bool) in
      CallKitCenter.shared.configureAudioSession(video: video)
    }
    Function("stopAudio") {
      try? AVAudioSession.sharedInstance().overrideOutputAudioPort(.none)
    }
    Function("audioRoutes") { CallKitCenter.shared.audioRoutes() }
    Function("setAudioRoute") { (route: String) -> Bool in
      CallKitCenter.shared.setAudioRoute(route)
    }
    Function("setProximityScreenOff") { (on: Bool) in
      DispatchQueue.main.async { UIDevice.current.isProximityMonitoringEnabled = on }
    }
    Function("startRinging") {}
    Function("stopRinging") {}
    Function("inSystemCall") { CallKitCenter.shared.inSystemCall() }
    Function("setKeepScreenOn") { (on: Bool) in
      DispatchQueue.main.async { UIApplication.shared.isIdleTimerDisabled = on }
    }
    Function("setShowWhenLocked") { (_: Bool) in }
    Function("canUseFullScreenIntent") { true }
    Function("openFullScreenIntentSettings") {}
  }
}
