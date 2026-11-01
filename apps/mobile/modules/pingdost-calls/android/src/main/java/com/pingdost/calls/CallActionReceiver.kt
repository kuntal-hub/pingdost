package com.pingdost.calls

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** "Decline" and "Hang up" from the call notifications: handed to JS (ADR 0029). */
class CallActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION = "com.pingdost.calls.ACTION"
    const val EXTRA_ACTION = "action"
    const val EXTRA_CALL_ID = "callId"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION) return
    val action = intent.getStringExtra(EXTRA_ACTION) ?: return
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
    // The ring stops at once, before JS answers the caller.
    if (action == "decline") CallNotifications.cancelIncoming(context)
    CallBridge.dispatch(action, callId)
  }
}
