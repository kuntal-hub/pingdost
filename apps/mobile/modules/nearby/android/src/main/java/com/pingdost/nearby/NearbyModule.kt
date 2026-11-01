package com.pingdost.nearby

import android.bluetooth.le.AdvertisingSetParameters
import android.bluetooth.le.ScanSettings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class StartOptions : Record {
  /** `lowLatency` | `balanced` | `lowPower`. */
  @Field val scanMode: String = "lowLatency"

  /** `low` (≈100 ms) | `medium` (≈250 ms) | `high` (≈1 s). */
  @Field val advertiseInterval: String = "low"

  /** `ultraLow` | `low` | `medium` | `high`. */
  @Field val txPower: String = "medium"

  /** How often the advertised token changes (30–3600 s). */
  @Field val rotationSeconds: Int = 600

  /** Connect to discovered peers by itself (the lower token connects). */
  @Field val autoConnect: Boolean = false
  @Field val advertise: Boolean = true
  @Field val scan: Boolean = true

  fun toConfig() = StartConfig(
    scanMode = when (scanMode) {
      "balanced" -> ScanSettings.SCAN_MODE_BALANCED
      "lowPower" -> ScanSettings.SCAN_MODE_LOW_POWER
      else -> ScanSettings.SCAN_MODE_LOW_LATENCY
    },
    advertiseInterval = when (advertiseInterval) {
      "medium" -> AdvertisingSetParameters.INTERVAL_MEDIUM
      "high" -> AdvertisingSetParameters.INTERVAL_HIGH
      else -> AdvertisingSetParameters.INTERVAL_LOW
    },
    txPower = when (txPower) {
      "ultraLow" -> AdvertisingSetParameters.TX_POWER_ULTRA_LOW
      "low" -> AdvertisingSetParameters.TX_POWER_LOW
      "high" -> AdvertisingSetParameters.TX_POWER_HIGH
      else -> AdvertisingSetParameters.TX_POWER_MEDIUM
    },
    rotationMs = rotationSeconds.coerceIn(30, 3600) * 1000L,
    autoConnect = autoConnect,
    advertise = advertise,
    scan = scan,
  )
}

/**
 * `PingdostNearby` (Phase 21, ADR 0023): the JS face of [BleEngine]. Errors reject with code
 * `ERR_NEARBY` and a short reason as the message (`permission`, `bluetooth_off`, `timeout`, …).
 */
class NearbyModule : Module() {
  private val forward: (String, Map<String, Any?>) -> Unit = { name, body -> sendEvent(name, body) }

  private fun ensure() {
    appContext.reactContext?.applicationContext?.let { BleEngine.attach(it) }
  }

  private fun reply(promise: Promise): Reply = { result, error ->
    if (error == null) promise.resolve(result) else promise.reject("ERR_NEARBY", error, null)
  }

  override fun definition() = ModuleDefinition {
    Name("PingdostNearby")

    Events("peerDiscovered", "peerLost", "linkUp", "linkDown", "packet", "stateChanged", "log")

    OnCreate {
      ensure()
      BleEngine.emitter = forward
    }

    OnDestroy {
      // The engine keeps running (links survive a JS reload); only this module's events stop.
      if (BleEngine.emitter === forward) BleEngine.emitter = null
    }

    AsyncFunction("getState") { promise: Promise ->
      ensure()
      BleEngine.state(reply(promise))
    }

    AsyncFunction("start") { options: StartOptions, promise: Promise ->
      ensure()
      BleEngine.start(options.toConfig(), reply(promise))
    }

    AsyncFunction("stop") { promise: Promise -> BleEngine.stop(reply(promise)) }

    AsyncFunction("rotateToken") { promise: Promise -> BleEngine.rotateToken(reply(promise)) }

    AsyncFunction("connect") { address: String, promise: Promise ->
      ensure()
      BleEngine.connect(address, reply(promise))
    }

    AsyncFunction("disconnect") { linkId: Int, promise: Promise -> BleEngine.disconnect(linkId, reply(promise)) }

    AsyncFunction("send") { linkId: Int, data: ByteArray, promise: Promise ->
      BleEngine.send(linkId, data, reply(promise))
    }

    Function("receive") { maxBytes: Int -> BleEngine.receive(maxBytes) }

    AsyncFunction("startForegroundService") { promise: Promise ->
      ensure()
      BleEngine.startForegroundService(reply(promise))
    }

    AsyncFunction("stopForegroundService") { promise: Promise -> BleEngine.stopForegroundService(reply(promise)) }

    // Phase 23 (ADR 0025): the notification names relaying while it runs.
    Function("setRelayNotification") { relay: Boolean ->
      NearbyService.relay = relay
      appContext.reactContext?.let { NearbyService.refresh(it.applicationContext) }
    }

    // Phase 23: the optional notification after a restart (BootReceiver).
    Function("setRestartReminder") { enabled: Boolean ->
      appContext.reactContext?.let { BootReceiver.setReminder(it.applicationContext, enabled) }
    }
  }
}
