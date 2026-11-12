package com.likapcs.live

import android.app.Application
import android.content.Context
import android.os.Build
import com.likapcs.live.core.Bridge
import com.likapcs.live.core.Engine
import com.likapcs.live.core.Http
import com.likapcs.live.core.Store

/** The app's SharedPreferences as the engine's storage: private to the app, kept across restarts. */
class PrefsStore(context: Context) : Store {
    private val prefs = context.getSharedPreferences("likalive", Context.MODE_PRIVATE)

    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(key: String, value: String?) {
        val edit = prefs.edit()
        if (value == null) edit.remove(key) else edit.putString(key, value)
        edit.apply()
    }
}

/**
 * One engine for the whole process: the screen (MainActivity), the background service and the
 * receivers all use the same link to the server.
 */
class LiveApp : Application() {
    lateinit var store: PrefsStore
        private set
    lateinit var notifier: Notifier
        private set
    lateinit var engine: Engine
        private set
    lateinit var shell: AndroidShell
        private set
    lateinit var bridge: Bridge
        private set

    override fun onCreate() {
        super.onCreate()
        val version = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "1"
        } catch (e: Exception) {
            "1"
        }
        val agent = "likalivepcs/$version (Android ${Build.VERSION.RELEASE}; ${Build.MANUFACTURER} ${Build.MODEL})"
        val http = Http(agent)
        store = PrefsStore(this)
        notifier = Notifier(this, store)
        engine = Engine(store, notifier, http, agent)
        shell = AndroidShell(this, version)
        bridge = Bridge(store, engine, http, shell)
        notifier.createChannels()
    }
}
