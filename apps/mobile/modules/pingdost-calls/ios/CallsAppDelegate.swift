import ExpoModulesCore
import UIKit

/// Starts PushKit and CallKit on every launch (Phase 29, ADR 0032). A VoIP push may be what
/// launched the app, and its call must reach CallKit before JS exists.
public class CallsAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CallKitCenter.shared.start()
    return false
  }
}
