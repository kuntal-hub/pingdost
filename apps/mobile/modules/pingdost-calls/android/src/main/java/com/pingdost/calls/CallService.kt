package com.pingdost.calls

import android.Manifest
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * The foreground service of a live call (ADR 0029). It keeps the process in the foreground
 * state (Android neither freezes nor kills it, and the microphone and camera stay usable with
 * the screen off or the app in the background) and shows "Ongoing call" with Hang up.
 *
 * Types: `phoneCall` (Android 14+ requires MANAGE_OWN_CALLS, declared), plus `microphone` and
 * `camera` (video calls) when those permissions are granted. Started from the foreground (the
 * user dialled or answered), never restarted by the OS. A switch to video (ADR 0037) starts it
 * again, from the foreground, so the `camera` type is added while the call goes on.
 *
 * It also holds a partial wake lock and a Wi-Fi lock for the call (ADR 0037): with the screen
 * off or the app in the background, the CPU and Wi-Fi stay awake for the media and signaling.
 */
class CallService : Service() {
  companion object {
    private const val TAG = "PingdostCalls"
    private const val EXTRA_CALL_ID = "callId"
    private const val EXTRA_NAME = "name"
    private const val EXTRA_VIDEO = "video"
    /** A safety net: a lock never outlives a forgotten call by more than this. */
    private const val LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000L

    fun start(context: Context, callId: String, name: String, video: Boolean) {
      val intent = Intent(context, CallService::class.java)
        .putExtra(EXTRA_CALL_ID, callId)
        .putExtra(EXTRA_NAME, name)
        .putExtra(EXTRA_VIDEO, video)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
      else context.startService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, CallService::class.java))
    }

    private fun granted(context: Context, permission: String) =
      context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
  }

  private var wakeLock: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  private fun holdLocks() {
    try {
      if (wakeLock == null) {
        wakeLock =
          getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "pingdost:call")
            .apply {
              setReferenceCounted(false)
              acquire(LOCK_TIMEOUT_MS)
            }
      }
      if (wifiLock == null) {
        val mode =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
          else @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
        wifiLock =
          (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
            .createWifiLock(mode, "pingdost:call")
            .apply {
              setReferenceCounted(false)
              acquire()
            }
      }
    } catch (error: RuntimeException) {
      Log.w(TAG, "call locks not held: ${error.javaClass.simpleName}")
    }
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    wifiLock?.let { if (it.isHeld) it.release() }
    wifiLock = null
    super.onDestroy()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val callId = intent?.getStringExtra(EXTRA_CALL_ID) ?: ""
    val name = intent?.getStringExtra(EXTRA_NAME) ?: "PingDost"
    val video = intent?.getBooleanExtra(EXTRA_VIDEO, false) ?: false
    val notification = CallNotifications.ongoing(this, callId, name, video)
    try {
      when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> {
          var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
          if (granted(this, Manifest.permission.RECORD_AUDIO)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
          }
          if (video && granted(this, Manifest.permission.CAMERA)) {
            types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
          }
          startForeground(CallNotifications.ONGOING_ID, notification, types)
        }
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
          startForeground(
            CallNotifications.ONGOING_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
          )
        else -> startForeground(CallNotifications.ONGOING_ID, notification)
      }
      holdLocks()
    } catch (error: Exception) {
      // E.g. started while the app was not in the foreground: the call goes on without it.
      Log.w(TAG, "call service not started: ${error.javaClass.simpleName}")
      stopSelf()
    }
    return START_NOT_STICKY
  }
}
