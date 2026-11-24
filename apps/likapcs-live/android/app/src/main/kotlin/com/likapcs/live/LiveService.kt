package com.likapcs.live

import android.app.AlarmManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.likapcs.live.core.Engine
import com.likapcs.live.core.WakePlan

/**
 * Keeps the link to the LIKApcs server open while the app is closed and the screen is off.
 *
 * A foreground service ("special use": a connection to the owner's own server that delivers each
 * sale as it happens) with a permanent notification that doubles as the day's summary. Nothing
 * here holds the processor awake: the phone sleeps, and four things wake the engine up —
 * a message from the server on the open connection, a change of network, an alarm every few
 * minutes that checks the link and reads anything the server did not push, and the engine's own
 * appointments with the clock (a session about to end, the summary of the day).
 */
class LiveService : Service() {
    private val live: LiveApp get() = application as LiveApp
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        // Called on the engine's thread whenever the day's figures or the link change. When the
        // server no longer accepts the sign-in there is nothing left to watch: the service ends
        // and the "sign in again" notification stays.
        live.notifier.onStatus = { if (live.engine.signedIn()) live.notifier.showStatus() else stopSelf() }
        foreground()
        watchNetwork()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Always first: a service started with startForegroundService must show itself in time.
        foreground()
        if (!live.engine.signedIn()) {
            stopSelf()
            return START_NOT_STICKY
        }
        live.engine.start()
        Alarms.schedule(this)
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Swiped away from the recent apps: the link stays; the alarm brings it back if not.
        if (live.engine.signedIn()) Alarms.schedule(this)
    }

    override fun onDestroy() {
        running = false
        live.notifier.onStatus = null
        live.notifier.statusStopped()
        networkCallback?.let {
            try {
                (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(it)
            } catch (e: Exception) {
                // was never registered
            }
        }
        networkCallback = null
        super.onDestroy()
    }

    private fun foreground() {
        try {
            live.notifier.statusStarted()
            val notification = live.notifier.statusNotification()
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(Notifier.STATUS_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(Notifier.STATUS_ID, notification)
            }
        } catch (e: Exception) {
            // The phone refused (started from the background without the battery permission).
            // The service still runs for a while; the alarm keeps catching up after that.
            Log.w(Notifier.TAG, "not in the foreground: ${e.message}")
        }
    }

    private fun watchNetwork() {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                live.notifier.stayAwake(15_000)
                live.engine.wake("network")
            }

            override fun onLost(network: Network) {
                live.engine.wake("network lost")
            }
        }
        try {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: Exception) {
            Log.w(Notifier.TAG, "network changes not watched: ${e.message}")
        }
    }

    companion object {
        /** True while the service lives in this process. */
        @Volatile var running = false
            private set

        /** False when the phone does not let the service start now (from the background). */
        fun start(context: Context): Boolean = try {
            context.startForegroundService(Intent(context, LiveService::class.java))
            true
        } catch (e: Exception) {
            Log.w(Notifier.TAG, "service not started: ${e.message}")
            false
        }
    }
}

/**
 * The wake-ups. A periodic one: one alarm at a time, each one sets the next. And the engine's
 * appointment with the clock: one moment at a time, set and moved by the engine.
 */
object Alarms {
    private const val ACTION = "com.likapcs.live.WAKE"
    const val ACTION_CLOCK = "com.likapcs.live.CLOCK"
    const val EXTRA_AT = "at"
    private const val EVERY_MS = 3 * 60_000L

    /** After half an hour without the server (the owner is away from the shop's network): less often. */
    private const val EVERY_MS_AWAY = 5 * 60_000L
    private const val AWAY_AFTER_MS = 30 * 60_000L

    fun schedule(context: Context) {
        val live = context.applicationContext as LiveApp
        val delay = if (live.engine.offlineFor() > AWAY_AFTER_MS) EVERY_MS_AWAY else EVERY_MS
        try {
            // Inexact on purpose: no special permission is needed and the phone can batch it with
            // other wake-ups. "AllowWhileIdle": it still fires while the phone dozes.
            (context.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
                .setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + delay, pending(context))
        } catch (e: Exception) {
            Log.w(Notifier.TAG, "alarm not set: ${e.message}")
        }
    }

    fun cancel(context: Context) {
        try {
            val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            manager.cancel(pending(context))
            manager.cancel(clock(context, 0))
        } catch (e: Exception) {
            // nothing was set
        }
    }

    /**
     * The engine's appointment with the clock (`Host.wakeAt`): wake it at `epochMs`, also while
     * the phone sleeps. 0 takes the appointment back.
     *
     * To the minute when the phone allows exact alarms — which it does for an app that may run
     * in the background, the question this app asks in its setup; no further permission is asked
     * for. Otherwise the phone may deliver an alarm late by up to three quarters of the wait, so
     * the wait is taken in steps (`WakePlan`), each short enough that even a late one is not past
     * the moment.
     */
    fun at(context: Context, epochMs: Long) {
        try {
            val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (epochMs <= 0) {
                manager.cancel(clock(context, 0))
                return
            }
            val operation = clock(context, epochMs)
            if (Build.VERSION.SDK_INT < 31 || manager.canScheduleExactAlarms()) {
                try {
                    manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, epochMs, operation)
                    return
                } catch (e: SecurityException) {
                    // The allowance went away between the question and the call.
                }
            }
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, WakePlan.step(System.currentTimeMillis(), epochMs), operation)
        } catch (e: Exception) {
            Log.w(Notifier.TAG, "clock alarm not set: ${e.message}")
        }
    }

    /** A clock alarm went off. True: it was an early step, and the next one is set. */
    fun onward(context: Context, target: Long): Boolean {
        if (!WakePlan.early(System.currentTimeMillis(), target)) return false
        at(context, target)
        return true
    }

    private fun pending(context: Context): PendingIntent = PendingIntent.getBroadcast(
        context, 1,
        Intent(context, WakeReceiver::class.java).setAction(ACTION),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** The one clock alarm: setting it again replaces it, whatever moment it carried. */
    private fun clock(context: Context, epochMs: Long): PendingIntent = PendingIntent.getBroadcast(
        context, 2,
        Intent(context, WakeReceiver::class.java).setAction(ACTION_CLOCK).putExtra(EXTRA_AT, epochMs),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
}

/**
 * An alarm. The periodic one: check the link, read what was missed, and bring the service back if
 * the phone stopped it. The clock one: say what is due now (and the same care for the service).
 */
class WakeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val live = context.applicationContext as LiveApp
        if (!live.engine.signedIn()) return
        val clock = intent?.action == Alarms.ACTION_CLOCK
        // An early step towards a moment the phone would not promise to keep: only the next step.
        if (clock && Alarms.onward(context, intent?.getLongExtra(Alarms.EXTRA_AT, 0) ?: 0)) return
        val reason = if (clock) Engine.WAKE_CLOCK else Engine.WAKE_ALARM
        live.notifier.stayAwake(15_000)
        Alarms.schedule(context)
        if (LiveService.running) {
            live.engine.wake(reason)
            return
        }
        val started = LiveService.start(context)
        // The engine is started here as well (the service does the same a moment later): what is
        // due by the clock is said at once, with or without the server.
        live.engine.start()
        live.engine.wake(reason)
        if (started) return
        // The phone does not let the service start from the background. Use the receiver's own
        // few seconds instead: connect, announce what was missed, and try again at the next alarm.
        val pending = goAsync()
        Handler(Looper.getMainLooper()).postDelayed({
            try {
                pending.finish()
            } catch (e: Exception) {
                // already finished
            }
        }, 9_000)
    }
}

/** After the phone restarts, or the app is updated: start watching again without being opened. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val live = context.applicationContext as LiveApp
        if (!live.engine.signedIn()) return
        LiveService.start(context)
        Alarms.schedule(context)
    }
}
