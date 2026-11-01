package com.pingdost.nearby

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build

/**
 * The optional, best-effort "after a restart" step (Phase 23, ADR 0025). The relay's logic
 * runs in the app's JavaScript, which Android does not start at boot, so a service started
 * here would keep Bluetooth busy without relaying anything. Instead, when the user asked for
 * it, a notification offers to open PingDost, which then turns nearby (and relaying) back on.
 */
class BootReceiver : BroadcastReceiver() {
  companion object {
    private const val PREFS = "pingdost_nearby"
    private const val KEY = "remind_after_boot"
    private const val CHANNEL = "nearby_restart"
    private const val NOTIFICATION_ID = 0x4e43

    fun setReminder(context: Context, enabled: Boolean) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY, enabled).apply()
    }
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
    if (!context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY, false)) return
    if (
      Build.VERSION.SDK_INT >= 33 &&
      context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      return
    }
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Nearby after restart", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Offers to turn nearby messaging and relaying back on after the phone restarts"
      },
    )
    val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    val content =
      PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    @Suppress("DiscouragedApi")
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
      .takeIf { it != 0 } ?: context.applicationInfo.icon
    val notification = Notification.Builder(context, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle("Nearby is paused since the restart")
      .setContentText("Open PingDost to turn nearby messaging and relaying back on.")
      .setContentIntent(content)
      .setAutoCancel(true)
      .build()
    manager.notify(NOTIFICATION_ID, notification)
  }
}
