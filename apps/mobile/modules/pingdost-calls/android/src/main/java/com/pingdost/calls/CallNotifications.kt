package com.pingdost.calls

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build

/**
 * The incoming-call notification (ADR 0029): a CallStyle notification (Android 12+) on the
 * "Incoming calls" channel, which rings with the phone's ringtone until answered, declined or
 * 45 s pass. Its full-screen intent opens `pingdost://call` over the lock screen (Android 14+
 * only while the user allows full-screen notifications; otherwise it shows as a heads-up).
 *
 * The caller's name appears only when JS passes one (it follows the "show sender" preference);
 * the push that woke the phone never carried it.
 */
object CallNotifications {
  const val INCOMING_CHANNEL = "incoming_calls"
  const val ONGOING_CHANNEL = "ongoing_calls"
  const val INCOMING_ID = 0x4341
  const val ONGOING_ID = 0x4342
  private const val RING_TIMEOUT_MS = 45_000L

  fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = context.getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(INCOMING_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Rings for PingDost calls"
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 800, 1200)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      },
    )
    manager.createNotificationChannel(
      NotificationChannel(ONGOING_CHANNEL, "Ongoing calls", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown during a PingDost call"
        setShowBadge(false)
      },
    )
  }

  fun icon(context: Context): Int {
    // expo-notifications' monochrome icon when present, else the launcher icon.
    @Suppress("DiscouragedApi")
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  /** `pingdost://call?callId=…&action=…` in this app: Expo Router opens the call screen. */
  fun openCall(context: Context, callId: String, action: String, request: Int): PendingIntent {
    val uri = Uri.parse("pingdost://call?callId=${Uri.encode(callId)}&action=$action")
    val intent = Intent(Intent.ACTION_VIEW, uri)
      .setPackage(context.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      request,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  fun broadcast(context: Context, action: String, callId: String, request: Int): PendingIntent {
    val intent = Intent(context, CallActionReceiver::class.java)
      .setAction(CallActionReceiver.ACTION)
      .putExtra(CallActionReceiver.EXTRA_ACTION, action)
      .putExtra(CallActionReceiver.EXTRA_CALL_ID, callId)
    return PendingIntent.getBroadcast(
      context,
      request,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  fun showIncoming(context: Context, callId: String, name: String, video: Boolean) {
    ensureChannels(context)
    val manager = context.getSystemService(NotificationManager::class.java)
    val text = if (video) "Incoming video call" else "Incoming voice call"
    val fullScreen = openCall(context, callId, "show", 1)
    val answer = openCall(context, callId, "answer", 2)
    val decline = broadcast(context, "decline", callId, 3)
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, INCOMING_CHANNEL)
      else @Suppress("DEPRECATION") Notification.Builder(context).setPriority(Notification.PRIORITY_MAX)
    builder
      .setSmallIcon(icon(context))
      .setContentTitle(name)
      .setContentText(text)
      .setCategory(Notification.CATEGORY_CALL)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setContentIntent(fullScreen)
      .setFullScreenIntent(fullScreen, true)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) builder.setTimeoutAfter(RING_TIMEOUT_MS)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val person = Person.Builder().setName(name).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forIncomingCall(person, decline, answer))
    } else {
      builder
        .addAction(Notification.Action.Builder(null, "Decline", decline).build())
        .addAction(Notification.Action.Builder(null, "Answer", answer).build())
    }
    val notification = builder.build()
    // The ringtone repeats until the notification goes.
    notification.flags = notification.flags or Notification.FLAG_INSISTENT
    manager.notify(INCOMING_ID, notification)
  }

  fun cancelIncoming(context: Context) {
    context.getSystemService(NotificationManager::class.java).cancel(INCOMING_ID)
  }

  /** The foreground service's notification: "Ongoing call" with Hang up. */
  fun ongoing(context: Context, callId: String, name: String, video: Boolean): Notification {
    ensureChannels(context)
    val open = openCall(context, callId, "show", 4)
    val hangUp = broadcast(context, "hangup", callId, 5)
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, ONGOING_CHANNEL)
      else @Suppress("DEPRECATION") Notification.Builder(context)
    builder
      .setSmallIcon(icon(context))
      .setContentTitle(name)
      .setContentText(if (video) "Video call" else "Voice call")
      .setCategory(Notification.CATEGORY_CALL)
      .setOngoing(true)
      .setContentIntent(open)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val person = Person.Builder().setName(name).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forOngoingCall(person, hangUp))
    } else {
      builder.addAction(Notification.Action.Builder(null, "Hang up", hangUp).build())
    }
    return builder.build()
  }
}
