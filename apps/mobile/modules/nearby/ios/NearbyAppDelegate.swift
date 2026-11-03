import ExpoModulesCore
import UIKit

/// State restoration (Phase 30, ADR 0033): when iOS relaunches the app for a Bluetooth event, the
/// managers must be recreated with their restore identifiers during launch.
public class NearbyAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    if launchOptions?[.bluetoothCentrals] != nil || launchOptions?[.bluetoothPeripherals] != nil {
      BleEngine.shared.restoreAfterLaunch()
    }
    return false
  }
}
