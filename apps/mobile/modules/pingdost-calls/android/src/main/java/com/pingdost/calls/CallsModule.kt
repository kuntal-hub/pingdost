package com.pingdost.calls

import android.app.Activity
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * `PingdostCalls` (Phase 26, ADR 0029): what the JS call runtime needs from Android besides
 * WebRTC (react-native-webrtc). Events: `action` ({action: decline | hangup, callId}) from
 * the notification buttons; `audioRoutes` ({available, current}) when devices come and go.
 */
class CallsModule : Module() {
  private val forward: (String, Map<String, Any?>) -> Unit = { name, body -> sendEvent(name, body) }

  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw IllegalStateException("no context")

  private fun onUi(run: (Activity) -> Unit) {
    val activity = appContext.currentActivity ?: CallBridge.activity?.get() ?: return
    activity.runOnUiThread { run(activity) }
  }

  override fun definition() = ModuleDefinition {
    Name("PingdostCalls")

    Events("action", "audioRoutes")

    OnCreate {
      CallBridge.emitter = forward
      appContext.reactContext?.let { CallNotifications.ensureChannels(it) }
    }

    OnDestroy {
      if (CallBridge.emitter === forward) CallBridge.emitter = null
    }

    Function("takePendingActions") { CallBridge.takePending() }

    Function("showIncoming") { callId: String, name: String, video: Boolean ->
      CallNotifications.showIncoming(context, callId, name, video)
    }

    Function("cancelIncoming") { CallNotifications.cancelIncoming(context) }

    Function("startOngoing") { callId: String, name: String, video: Boolean ->
      CallService.start(context, callId, name, video)
    }

    Function("stopOngoing") { CallService.stop(context) }

    Function("startAudio") { video: Boolean -> CallAudio.start(context, video) }

    Function("stopAudio") { CallAudio.stop(context) }

    Function("audioRoutes") {
      mapOf("available" to CallAudio.availableRoutes(context), "current" to CallAudio.currentRoute(context))
    }

    Function("setAudioRoute") { route: String -> CallAudio.setRoute(context, route) }

    Function("setProximityScreenOff") { on: Boolean -> CallAudio.setProximity(context, on) }

    Function("startRinging") { CallAudio.startRinging(context) }

    Function("stopRinging") { CallAudio.stopRinging(context) }

    Function("inSystemCall") { CallAudio.inSystemCall(context) }

    Function("setKeepScreenOn") { on: Boolean ->
      onUi { activity ->
        if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
      }
    }

    /** The call screen over the lock screen (an incoming call or a live one), or not. */
    Function("setShowWhenLocked") { on: Boolean -> onUi { CallLockScreen.apply(it, on) } }

    /** Android 14+: the user may turn full-screen notifications off for PingDost. */
    Function("canUseFullScreenIntent") {
      if (Build.VERSION.SDK_INT >= 34) {
        context.getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
      } else {
        true
      }
    }

    Function("openFullScreenIntentSettings") {
      val intent =
        if (Build.VERSION.SDK_INT >= 34) {
          Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
        } else {
          Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}

/** Shows the activity over the keyguard and turns the screen on (Android 8.1+), or stops. */
object CallLockScreen {
  fun apply(activity: Activity, on: Boolean) {
    CallBridge.activity = WeakReference(activity)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(on)
      activity.setTurnScreenOn(on)
    } else {
      @Suppress("DEPRECATION")
      val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
        WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
      if (on) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
    }
  }

  /** `pingdost://call…`: the incoming-call notification opened the app. */
  fun isCallIntent(intent: Intent?): Boolean {
    val data = intent?.data ?: return false
    return data.scheme == "pingdost" && data.host == "call"
  }
}
