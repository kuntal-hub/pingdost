package com.pingdost.calls

import android.app.Activity
import java.lang.ref.WeakReference

/**
 * Shared state between the module (JS), the notification actions and the activity listener
 * (ADR 0029). Actions from notification buttons go to JS as `action` events; while no module
 * listens (JS reloading), they wait here for `takePendingActions`.
 */
object CallBridge {
  @Volatile var emitter: ((String, Map<String, Any?>) -> Unit)? = null
  @Volatile var activity: WeakReference<Activity>? = null

  private val pending = ArrayDeque<Map<String, Any?>>()

  fun dispatch(action: String, callId: String) {
    val body = mapOf("action" to action, "callId" to callId)
    val send = emitter
    if (send != null) {
      send("action", body)
      return
    }
    synchronized(pending) {
      if (pending.size >= 8) pending.removeFirst()
      pending.addLast(body)
    }
  }

  fun takePending(): List<Map<String, Any?>> = synchronized(pending) {
    val all = pending.toList()
    pending.clear()
    all
  }

  fun emit(name: String, body: Map<String, Any?>) {
    emitter?.invoke(name, body)
  }
}
