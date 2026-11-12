package com.likapcs.live

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The screens: one WebView showing the pages packed into the app (assets/www). The pages never
 * reach the network themselves; every request goes through `LikaLive.call`, answered by the
 * same engine the background service uses.
 */
class MainActivity : Activity(), Notifier.Listener {
    private val live: LiveApp get() = application as LiveApp
    private var web: WebView? = null
    private var worker: ExecutorService? = null
    private var pageReady = false
    private var pendingTab: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        worker = Executors.newFixedThreadPool(3)
        live.shell.attach(this)
        pendingTab = tabOf(intent)

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true)
        val view = WebView(this)
        view.setBackgroundColor(BACKGROUND)
        view.overScrollMode = WebView.OVER_SCROLL_NEVER
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            setSupportMultipleWindows(false)
            // The phone's "font size" setting is followed, up to a size the layout still holds.
            textZoom = (resources.configuration.fontScale * 100).toInt().coerceIn(85, 130)
        }
        view.webViewClient = object : WebViewClient() {
            // Only the pages packed into the app are ever shown.
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean =
                !request.url.toString().startsWith(PAGES)

            override fun onPageFinished(v: WebView, url: String) {
                pageReady = true
                pendingTab?.let { emit("tab", buildJsonObject { put("tab", it) }.toString()) }
                pendingTab = null
            }

            // A small phone may take the page's memory back while the app is in the background:
            // build the screen again instead of letting the app die.
            override fun onRenderProcessGone(v: WebView, detail: RenderProcessGoneDetail): Boolean {
                recreate()
                return true
            }
        }
        view.addJavascriptInterface(Calls(), "LikaLive")
        setContentView(view, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        web = view
        view.loadUrl(PAGES + "index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val tab = tabOf(intent) ?: return
        if (pageReady) emit("tab", buildJsonObject { put("tab", tab) }.toString()) else pendingTab = tab
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
        live.notifier.listener = this
        if (live.engine.signedIn()) {
            // Opening the app is also what brings the service back if the phone had stopped it.
            LiveService.start(this)
            live.engine.wake("opened")
        }
        if (pageReady) emit("resume", null)
    }

    override fun onPause() {
        live.notifier.listener = null
        web?.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        live.shell.attach(null)
        worker?.shutdownNow()
        worker = null
        web?.let {
            (it.parent as? ViewGroup)?.removeView(it)
            it.removeJavascriptInterface("LikaLive")
            it.destroy()
        }
        web = null
        super.onDestroy()
    }

    @Deprecated("The back key leaves the app running; nothing else to go back to.")
    override fun onBackPressed() {
        moveTaskToBack(true)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQUEST_NOTIFICATIONS) {
            live.notifier.createChannels()
            if (live.engine.signedIn()) live.notifier.showStatus()
            onState()
        }
    }

    // ─── From the engine (its own thread) ───────────────────────────────────────────────────

    override fun onState() {
        val worker = this.worker ?: return
        try {
            worker.execute {
                val state = live.bridge.state().toString()
                runOnUiThread { emit("state", state) }
            }
        } catch (e: Exception) {
            // the screen is closing
        }
    }

    override fun onChanged(kind: String) {
        runOnUiThread { emit("changed", buildJsonObject { put("kind", kind) }.toString()) }
    }

    // ─── To and from the pages ──────────────────────────────────────────────────────────────

    private inner class Calls {
        /** Called by the pages on a WebView thread; the answer goes back with the same `id`. */
        @JavascriptInterface
        fun call(id: Int, method: String, argsJson: String?) {
            val worker = this@MainActivity.worker ?: return
            try {
                worker.execute {
                    val answer = try {
                        live.bridge.call(method, argsJson)
                    } catch (e: Throwable) {
                        """{"ok":false,"error":{"code":"internal","message":${JsonPrimitive(e.message ?: e.javaClass.simpleName)}}}"""
                    }
                    runOnUiThread { script("window.__lika&&window.__lika.resolve($id,${JsonPrimitive(answer)})") }
                }
            } catch (e: Exception) {
                // the screen is closing
            }
        }
    }

    private fun emit(type: String, json: String?) {
        script("window.__lika&&window.__lika.event(${JsonPrimitive(type)},${if (json == null) "null" else JsonPrimitive(json).toString()})")
    }

    private fun script(code: String) {
        try {
            web?.evaluateJavascript(code, null)
        } catch (e: Exception) {
            // the page is gone
        }
    }

    private fun tabOf(intent: Intent?): String? =
        if (intent?.action == ACTION_OPEN) intent.getStringExtra(EXTRA_TAB) else null

    companion object {
        const val ACTION_OPEN = "com.likapcs.live.OPEN"
        const val EXTRA_TAB = "tab"
        const val REQUEST_NOTIFICATIONS = 41
        private const val PAGES = "file:///android_asset/www/"
        private const val BACKGROUND = 0xFF0B1020.toInt()
    }
}
