package com.likapcs.live

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import com.likapcs.live.core.Category
import com.likapcs.live.core.Note
import com.likapcs.live.core.Shell
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.lang.ref.WeakReference

/** What the screens can ask of the phone: permissions, settings pages, the background service. */
class AndroidShell(private val app: LiveApp, private val version: String) : Shell {
    private var screen = WeakReference<Activity>(null)
    private val prefs = app.getSharedPreferences("likalive.shell", Context.MODE_PRIVATE)

    fun attach(activity: Activity?) {
        screen = WeakReference(activity)
    }

    override fun appVersion(): String = version

    override fun notifications(): String {
        if (Build.VERSION.SDK_INT >= 33) {
            if (app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
                return if (app.notifier.allowed()) "granted" else "blocked"
            }
            // Android stops showing its question after two refusals: then only the settings help.
            val activity = screen.get()
            val asked = prefs.getBoolean(ASKED, false)
            val canAsk = !asked || (activity != null && activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS))
            return if (canAsk) "denied" else "blocked"
        }
        return if (app.notifier.allowed()) "granted" else "blocked"
    }

    override fun batteryFree(): Boolean =
        (app.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(app.packageName)

    override fun device(): JsonObject = buildJsonObject {
        put("platform", "android")
        put("sdk", Build.VERSION.SDK_INT)
        put("release", Build.VERSION.RELEASE)
        put("brand", Build.BRAND)
        put("model", Build.MODEL)
    }

    override fun askNotifications() {
        val activity = screen.get() ?: return
        if (Build.VERSION.SDK_INT >= 33 && notifications() == "denied") {
            prefs.edit().putBoolean(ASKED, true).apply()
            activity.runOnUiThread {
                activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), MainActivity.REQUEST_NOTIFICATIONS)
            }
        } else if (notifications() != "granted") {
            openSettings("notifications")
        }
    }

    override fun askBattery() {
        if (batteryFree()) return
        val pkg = Uri.parse("package:${app.packageName}")
        // The system's own yes/no question; the list of all apps and the app's page are fallbacks.
        launch(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg),
            Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg),
        )
    }

    override fun openSettings(page: String) {
        val pkg = Uri.parse("package:${app.packageName}")
        val details = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkg)
        when (page) {
            "notifications" -> launch(
                Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName),
                details,
            )
            "battery" -> launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS), details)
            else -> launch(details)
        }
    }

    override fun testNotification() {
        val x = app.engine.texts()
        app.notifier.post(
            Note(
                key = "test:${System.currentTimeMillis()}",
                category = Category.SALES,
                title = x.t("Arta shiti 3.50 €", "Arta sold 3.50 €"),
                text = x.t("Provë · Coca-Cola 0.33l ×2 · fitimi 1.20 €", "Test · Coca-Cola 0.33l ×2 · profit 1.20 €"),
                at = System.currentTimeMillis(),
                tab = "sales",
            ),
        )
    }

    override fun startMonitoring() {
        app.notifier.createChannels()
        LiveService.start(app)
    }

    override fun stopMonitoring() {
        Alarms.cancel(app)
        app.stopService(Intent(app, LiveService::class.java))
        app.notifier.clearAll()
    }

    /** Opens the first of these pages the phone has (makers remove or rename some of them). */
    private fun launch(vararg intents: Intent) {
        val from: Context = screen.get() ?: app
        for (intent in intents) {
            try {
                if (from !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                from.startActivity(intent)
                return
            } catch (e: Exception) {
                Log.w(Notifier.TAG, "settings page not opened: ${e.message}")
            }
        }
    }

    private companion object {
        const val ASKED = "asked.notifications"
    }
}
