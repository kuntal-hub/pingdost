package com.pingdost.calls

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener
import java.lang.ref.WeakReference

/**
 * When the incoming-call notification opens the app (`pingdost://call`, also its full-screen
 * intent on a locked phone), the activity must show over the lock screen and turn the screen
 * on before JS runs. JS turns it off again when the call ends (`setShowWhenLocked(false)`).
 */
class CallsPackage : Package {
  override fun createReactActivityLifecycleListeners(
    activityContext: Context,
  ): List<ReactActivityLifecycleListener> = listOf(CallActivityListener())
}

class CallActivityListener : ReactActivityLifecycleListener {
  override fun onCreate(activity: Activity, savedInstanceState: Bundle?) {
    CallBridge.activity = WeakReference(activity)
    if (CallLockScreen.isCallIntent(activity.intent)) CallLockScreen.apply(activity, true)
  }

  override fun onResume(activity: Activity) {
    CallBridge.activity = WeakReference(activity)
  }

  /** Home or Recents during a video call: picture-in-picture on Android 8–11 (ADR 0037). */
  override fun onUserLeaveHint(activity: Activity) {
    CallPip.onUserLeaveHint(activity)
  }

  override fun onNewIntent(intent: Intent?): Boolean {
    if (CallLockScreen.isCallIntent(intent)) {
      CallBridge.activity?.get()?.let { activity ->
        activity.runOnUiThread { CallLockScreen.apply(activity, true) }
      }
    }
    // Expo Router still gets the URL.
    return false
  }
}
