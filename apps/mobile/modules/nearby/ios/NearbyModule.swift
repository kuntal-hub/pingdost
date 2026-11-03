import ExpoModulesCore

struct StartOptions: Record {
  /// Android-only tuning (`lowLatency` | `balanced` | `lowPower`); iOS picks its own.
  @Field var scanMode: String = "lowLatency"
  @Field var advertiseInterval: String = "low"
  @Field var txPower: String = "medium"
  /// How often the token changes (30–3600 s).
  @Field var rotationSeconds: Int = 600
  /// Connect to discovered peers by itself (on iOS: every peer not linked yet; ADR 0033).
  @Field var autoConnect: Bool = false
  @Field var advertise: Bool = true
  @Field var scan: Bool = true

  func toConfig() -> StartConfig {
    StartConfig(
      rotationSeconds: min(max(rotationSeconds, 30), 3_600), autoConnect: autoConnect,
      advertise: advertise, scan: scan)
  }
}

/// `PingdostNearby` on iOS (Phase 30, ADR 0033): the JS face of `BleEngine`, with the same
/// functions and events as Android's `NearbyModule.kt`. Errors reject with code `ERR_NEARBY` and
/// a short reason as the message (`permission`, `bluetooth_off`, `timeout`, …). iOS has no
/// foreground service or restart reminder: those functions do nothing. `requestPermission` is
/// iOS-only (Android asks through `PermissionsAndroid`).
public class NearbyModule: Module {
  private func reply(_ promise: Promise) -> Reply {
    return { result, error in
      if let error {
        promise.reject("ERR_NEARBY", error)
      } else {
        promise.resolve(result)
      }
    }
  }

  public func definition() -> ModuleDefinition {
    Name("PingdostNearby")

    Events("peerDiscovered", "peerLost", "linkUp", "linkDown", "packet", "stateChanged", "log")

    OnStartObserving {
      BleEngine.shared.setEmitter { [weak self] name, body in self?.sendEvent(name, body) }
    }

    OnStopObserving {
      // The engine keeps running (links survive a JS reload); only events stop.
      BleEngine.shared.setEmitter(nil)
    }

    AsyncFunction("getState") { (promise: Promise) in
      BleEngine.shared.state(self.reply(promise))
    }

    AsyncFunction("start") { (options: StartOptions, promise: Promise) in
      BleEngine.shared.start(options.toConfig(), self.reply(promise))
    }

    AsyncFunction("stop") { (promise: Promise) in
      BleEngine.shared.stop(self.reply(promise))
    }

    AsyncFunction("rotateToken") { (promise: Promise) in
      BleEngine.shared.rotateToken(self.reply(promise))
    }

    AsyncFunction("connect") { (address: String, promise: Promise) in
      BleEngine.shared.connect(address, self.reply(promise))
    }

    AsyncFunction("disconnect") { (linkId: Int, promise: Promise) in
      BleEngine.shared.disconnect(linkId, self.reply(promise))
    }

    AsyncFunction("send") { (linkId: Int, data: Data, promise: Promise) in
      BleEngine.shared.send(linkId, [UInt8](data), self.reply(promise))
    }

    Function("receive") { (maxBytes: Int) -> Data in
      Data(BleEngine.shared.receive(maxBytes))
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      BleEngine.shared.requestPermission { promise.resolve($0) }
    }

    // Android's foreground service and reboot reminder have no iOS counterpart.
    AsyncFunction("startForegroundService") { (promise: Promise) in promise.resolve(nil) }
    AsyncFunction("stopForegroundService") { (promise: Promise) in promise.resolve(nil) }
    Function("setRelayNotification") { (_: Bool) in }
    Function("setRestartReminder") { (_: Bool) in }
  }
}
