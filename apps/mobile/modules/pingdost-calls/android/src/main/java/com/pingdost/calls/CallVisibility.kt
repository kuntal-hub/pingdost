package com.pingdost.calls

import android.app.Activity
import android.app.Application
import android.os.Bundle

/**
 * Whether PingDost's window can be seen (ADR 0037): started, which includes picture-in-picture,
 * or stopped (another app, the lock screen, the picture-in-picture window closed). JS pauses
 * the camera of a video call while nobody can see it. An event, because React Native pauses
 * JS timers in the background and the stop after closing the small window changes no app
 * state JS hears about.
 */
object CallVisibility : Application.ActivityLifecycleCallbacks {
  @Volatile var visible = true
    private set

  private var registered = false

  @Synchronized
  fun register(activity: Activity) {
    if (registered) return
    registered = true
    activity.application.registerActivityLifecycleCallbacks(this)
  }

  private fun isCallActivity(activity: Activity): Boolean = activity === CallBridge.activity?.get()

  private fun update(now: Boolean) {
    if (visible == now) return
    visible = now
    CallBridge.emit("visibility", mapOf("visible" to now))
  }

  override fun onActivityStarted(activity: Activity) {
    if (isCallActivity(activity)) update(true)
  }

  override fun onActivityStopped(activity: Activity) {
    if (isCallActivity(activity)) update(false)
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

  override fun onActivityResumed(activity: Activity) = Unit

  override fun onActivityPaused(activity: Activity) = Unit

  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

  override fun onActivityDestroyed(activity: Activity) = Unit
}
