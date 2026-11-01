package com.pingdost.nearby

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * The `connectedDevice` foreground service (ADR 0023). It does no work itself: while it runs,
 * the process stays in the foreground state, so Android neither freezes nor kills it as a
 * cached app and the [BleEngine]'s links and scans keep running with the screen off. Started
 * and stopped from JS; never restarted by the OS (START_NOT_STICKY).
 *
 * Its notification says "PingDost nearby relay active" while this phone relays for others
 * (Phase 23, ADR 0025), else "Nearby is on".
 */
class NearbyService : Service() {
  companion object {
    private const val CHANNEL = "nearby"
    private const val NOTIFICATION_ID = 0x4e42

    /** What the notification says; set from JS, also while the service runs. */
    @Volatile var relay = false
    @Volatile private var running = false

    /** Updates the running service's notification (posting under the same ID replaces it). */
    fun refresh(context: Context) {
      if (!running) return
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.notify(NOTIFICATION_ID, build(context))
    }

    private fun build(context: Context): Notification {
      val manager = context.getSystemService(NotificationManager::class.java)
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Nearby", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while PingDost keeps Bluetooth on to reach phones nearby"
          setShowBadge(false)
        },
      )
      val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val content = launch?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      // expo-notifications' monochrome icon when present, else the launcher icon.
      @Suppress("DiscouragedApi")
      val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
        .takeIf { it != 0 } ?: context.applicationInfo.icon
      val (title, text) =
        if (relay) {
          "PingDost nearby relay active" to "Passing on encrypted messages for phones nearby."
        } else {
          "Nearby is on" to "PingDost keeps Bluetooth on to reach phones nearby."
        }
      return Notification.Builder(context, CHANNEL)
        .setSmallIcon(icon)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setContentIntent(content)
        .build()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification = build(this)
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (error: RuntimeException) {
      // SecurityException (no Bluetooth permission: Android 14's prerequisite for this type) or
      // ForegroundServiceStartNotAllowedException.
      Log.w("PingdostNearby", "foreground service refused", error)
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    BleEngine.onServiceState(true)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    BleEngine.onServiceState(false)
    super.onDestroy()
  }
}
