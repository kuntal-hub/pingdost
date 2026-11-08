package com.pingdost.calls

import android.app.Activity
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.drawable.Icon
import android.os.Build
import android.util.Log
import android.util.Rational
import androidx.annotation.RequiresApi

/**
 * Picture-in-picture for video calls (ADR 0037). While JS enables it (a live video call, or the
 * other side's shared screen), leaving the app shrinks the call into a small window: Android
 * 12+ by itself (auto-enter), Android 8–11 from the activity's user-leave hint. The window has
 * Mute/Unmute and Hang up; they reach JS as notification `action`s.
 *
 * The main activity declares `supportsPictureInPicture` (plugins/with-call-pip.js).
 */
object CallPip {
  private const val TAG = "PingdostCalls"

  @Volatile var enabled = false
  @Volatile var muted = false
  @Volatile var callId = ""

  fun supported(context: Context): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)

  fun isActive(activity: Activity?): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && activity?.isInPictureInPictureMode == true

  /** Applies the current state to the activity (aspect, buttons, auto-enter). UI thread. */
  fun apply(activity: Activity) {
    if (!supported(activity) || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    try {
      activity.setPictureInPictureParams(params(activity))
    } catch (error: RuntimeException) {
      Log.w(TAG, "picture-in-picture not set: ${error.javaClass.simpleName}")
    }
  }

  /** Android 8–11 have no auto-enter: the user left the app (Home, Recents). UI thread. */
  fun onUserLeaveHint(activity: Activity) {
    if (!enabled || !supported(activity)) return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return
    if (activity.isInPictureInPictureMode) return
    try {
      activity.enterPictureInPictureMode(params(activity))
    } catch (error: RuntimeException) {
      // E.g. the user turned picture-in-picture off for PingDost.
      Log.w(TAG, "picture-in-picture not entered: ${error.javaClass.simpleName}")
    }
  }

  /** The call ended in the small window: close it rather than leave an empty one. UI thread. */
  fun exit(activity: Activity) {
    if (isActive(activity)) activity.moveTaskToBack(false)
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun params(activity: Activity): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder()
      // The phone's portrait call screen.
      .setAspectRatio(Rational(9, 16))
      .setActions(actions(activity))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) builder.setAutoEnterEnabled(enabled)
    return builder.build()
  }

  @RequiresApi(Build.VERSION_CODES.O)
  private fun actions(context: Context): List<RemoteAction> {
    val mute =
      RemoteAction(
        Icon.createWithResource(context, if (muted) R.drawable.pd_mic_off else R.drawable.pd_mic),
        if (muted) "Unmute" else "Mute",
        if (muted) "Turn your microphone on" else "Turn your microphone off",
        CallNotifications.broadcast(context, if (muted) "unmute" else "mute", callId, 6),
      )
    val hangUp =
      RemoteAction(
        Icon.createWithResource(context, R.drawable.pd_call_end),
        "Hang up",
        "End the call",
        CallNotifications.broadcast(context, "hangup", callId, 7),
      )
    return listOf(mute, hangUp)
  }
}
