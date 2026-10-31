package com.pingdost.nearby

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * The `connectedDevice` foreground service (ADR 0023). It does no work itself: while it runs,
 * the process stays in the foreground state, so Android neither freezes nor kills it as a
 * cached app and the [BleEngine]'s links and scans keep running with the screen off. Started
 * and stopped from JS; never restarted by the OS (START_NOT_STICKY) in this spike.
 */
class NearbyService : Service() {
  companion object {
    private const val CHANNEL = "nearby"
    private const val NOTIFICATION_ID = 0x4e42
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Nearby", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while PingDost keeps Bluetooth on to reach phones nearby"
        setShowBadge(false)
      },
    )
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val content = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    // expo-notifications' monochrome icon when present, else the launcher icon.
    @Suppress("DiscouragedApi")
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName).takeIf { it != 0 }
      ?: applicationInfo.icon
    val notification = Notification.Builder(this, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle("Nearby is on")
      .setContentText("PingDost keeps Bluetooth on to reach phones nearby.")
      .setOngoing(true)
      .setContentIntent(content)
      .build()
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
    BleEngine.onServiceState(true)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    BleEngine.onServiceState(false)
    super.onDestroy()
  }
}
