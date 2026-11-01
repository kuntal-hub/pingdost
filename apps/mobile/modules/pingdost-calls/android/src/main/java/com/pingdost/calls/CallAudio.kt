package com.pingdost.calls

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator

/**
 * Call audio on Android's AudioManager (ADR 0029):
 * - during a call: communication mode, audio focus, and a route: the earpiece for voice calls
 *   and the speaker for video, unless a headset or Bluetooth device is there (it wins);
 * - routes: Android 12+ `setCommunicationDevice`; older versions the speakerphone and SCO
 *   switches;
 * - the proximity sensor turns the screen off on the earpiece;
 * - the ring for an incoming call while PingDost is on screen (the notification rings
 *   otherwise);
 * - whether a phone (GSM) call is going on, read from the audio mode (no phone permission).
 */
object CallAudio {
  private var focus: AudioFocusRequest? = null
  private var proximity: PowerManager.WakeLock? = null
  private var ringtone: Ringtone? = null
  private var vibrating = false
  private var callback: AudioDeviceCallback? = null
  private var savedMode = AudioManager.MODE_NORMAL
  private var active = false

  private fun audio(context: Context) = context.getSystemService(AudioManager::class.java)

  fun start(context: Context, video: Boolean) {
    val manager = audio(context)
    if (!active) savedMode = manager.mode
    active = true
    manager.mode = AudioManager.MODE_IN_COMMUNICATION
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .build()
      focus = request
      manager.requestAudioFocus(request)
    }
    val routes = availableRoutes(context)
    val preferred = when {
      "bluetooth" in routes -> "bluetooth"
      "headset" in routes -> "headset"
      video -> "speaker"
      else -> "earpiece"
    }
    setRoute(context, preferred)
    watchDevices(context)
  }

  fun stop(context: Context) {
    if (!active) return
    active = false
    val manager = audio(context)
    unwatchDevices(context)
    setProximity(context, false)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      manager.clearCommunicationDevice()
    } else {
      @Suppress("DEPRECATION")
      manager.isSpeakerphoneOn = false
      @Suppress("DEPRECATION")
      if (manager.isBluetoothScoOn) manager.stopBluetoothSco()
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) focus?.let { manager.abandonAudioFocusRequest(it) }
    focus = null
    manager.mode = savedMode
  }

  /** The routes there are now: earpiece, speaker, headset, bluetooth. */
  fun availableRoutes(context: Context): List<String> {
    val manager = audio(context)
    val found = linkedSetOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      for (device in manager.availableCommunicationDevices) routeOf(device.type)?.let { found.add(it) }
    } else {
      found.add("speaker")
      if (context.packageManager.hasSystemFeature("android.hardware.telephony")) found.add("earpiece")
      for (device in manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
        routeOf(device.type)?.takeIf { it == "headset" || it == "bluetooth" }?.let { found.add(it) }
      }
    }
    return found.toList()
  }

  fun currentRoute(context: Context): String? {
    val manager = audio(context)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      return manager.communicationDevice?.let { routeOf(it.type) }
    }
    @Suppress("DEPRECATION")
    return when {
      manager.isBluetoothScoOn -> "bluetooth"
      manager.isSpeakerphoneOn -> "speaker"
      manager.isWiredHeadsetOn -> "headset"
      else -> "earpiece"
    }
  }

  fun setRoute(context: Context, route: String): Boolean {
    val manager = audio(context)
    val done =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val device = manager.availableCommunicationDevices.firstOrNull { routeOf(it.type) == route }
        device != null && manager.setCommunicationDevice(device)
      } else {
        @Suppress("DEPRECATION")
        when (route) {
          "speaker" -> {
            if (manager.isBluetoothScoOn) manager.stopBluetoothSco()
            manager.isSpeakerphoneOn = true
          }
          "bluetooth" -> {
            manager.isSpeakerphoneOn = false
            manager.startBluetoothSco()
            manager.isBluetoothScoOn = true
          }
          else -> {
            if (manager.isBluetoothScoOn) manager.stopBluetoothSco()
            manager.isSpeakerphoneOn = false
          }
        }
        true
      }
    emitRoutes(context)
    return done
  }

  /** Screen off while the phone is at the ear (voice calls on the earpiece). */
  fun setProximity(context: Context, on: Boolean) {
    if (on) {
      if (proximity?.isHeld == true) return
      val power = context.getSystemService(PowerManager::class.java)
      if (!power.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK)) return
      proximity = power.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "pingdost:call").also {
        it.setReferenceCounted(false)
        it.acquire(4 * 60 * 60 * 1000L)
      }
    } else {
      proximity?.let { if (it.isHeld) it.release() }
      proximity = null
    }
  }

  fun startRinging(context: Context) {
    if (ringtone?.isPlaying == true) return
    val tone = RingtoneManager.getRingtone(context, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE))
    tone?.audioAttributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) tone?.isLooping = true
    // Silent and vibrate-only modes are respected.
    val manager = audio(context)
    if (manager.ringerMode == AudioManager.RINGER_MODE_NORMAL) tone?.play()
    ringtone = tone
    if (manager.ringerMode != AudioManager.RINGER_MODE_SILENT) {
      val vibrator = context.getSystemService(Vibrator::class.java)
      if (vibrator?.hasVibrator() == true && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 800, 1200), 0))
        vibrating = true
      }
    }
  }

  fun stopRinging(context: Context) {
    ringtone?.stop()
    ringtone = null
    if (vibrating) {
      context.getSystemService(Vibrator::class.java)?.cancel()
      vibrating = false
    }
  }

  /** A phone call (or the phone's ringing for one) is going on. */
  fun inSystemCall(context: Context): Boolean {
    val mode = audio(context).mode
    return mode == AudioManager.MODE_IN_CALL || mode == AudioManager.MODE_RINGTONE
  }

  private fun routeOf(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_WIRED_HEADSET,
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
    AudioDeviceInfo.TYPE_USB_HEADSET -> "headset"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    26 /* TYPE_BLE_HEADSET */,
    23 /* TYPE_HEARING_AID */ -> "bluetooth"
    else -> null
  }

  private fun emitRoutes(context: Context) {
    CallBridge.emit(
      "audioRoutes",
      mapOf("available" to availableRoutes(context), "current" to currentRoute(context)),
    )
  }

  private fun watchDevices(context: Context) {
    if (callback != null) return
    val cb = object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
        // A headset or Bluetooth device that appears mid-call takes over, as on a phone call.
        val routes = addedDevices?.mapNotNull { routeOf(it.type) } ?: emptyList()
        when {
          "bluetooth" in routes -> setRoute(context, "bluetooth")
          "headset" in routes -> setRoute(context, "headset")
          else -> emitRoutes(context)
        }
      }

      override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
        emitRoutes(context)
      }
    }
    callback = cb
    audio(context).registerAudioDeviceCallback(cb, Handler(Looper.getMainLooper()))
  }

  private fun unwatchDevices(context: Context) {
    callback?.let { audio(context).unregisterAudioDeviceCallback(it) }
    callback = null
  }
}
