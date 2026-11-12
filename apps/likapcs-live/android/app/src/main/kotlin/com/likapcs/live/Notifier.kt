package com.likapcs.live

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.likapcs.live.core.Category
import com.likapcs.live.core.Conn
import com.likapcs.live.core.EngineState
import com.likapcs.live.core.Host
import com.likapcs.live.core.Keys
import com.likapcs.live.core.Note
import com.likapcs.live.core.Store
import com.likapcs.live.core.Summary
import com.likapcs.live.core.Texts

/**
 * The engine's hands on the phone: system notifications (one channel per kind, so the owner can
 * set sound and importance for each in the phone's settings), the permanent notification with the
 * day's figures, and the short wake lock that lets a message be handled while the screen is off.
 */
class Notifier(private val app: Context, private val store: Store) : Host {
    /** The open screen, when there is one. Called on the engine's thread. */
    interface Listener {
        fun onState()
        fun onChanged(kind: String)
    }

    private val manager = app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    private val wakeLock: PowerManager.WakeLock =
        (app.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "likalivepcs:link")
            .apply { setReferenceCounted(false) }

    @Volatile var listener: Listener? = null

    /** The running service: it redraws the permanent notification. */
    @Volatile var onStatus: (() -> Unit)? = null

    @Volatile private var summary: Summary? = null
    @Volatile private var state: EngineState = EngineState()
    @Volatile private var cachedTexts: Texts? = null

    /** False once the service is gone: a late update must not bring the permanent notification back. */
    private var statusOn = false

    /** What the permanent notification shows now: it is redrawn only when this changes. */
    private var statusShown: String? = null

    /** The language the channel names were written in. */
    @Volatile private var channelsLang: String? = null

    /** When the wake lock lets go (elapsed real time, ms). */
    private var awakeUntil = 0L

    private fun texts(): Texts {
        val lang = store.get(Keys.LANG) ?: "sq"
        cachedTexts?.let { if (it.lang == lang) return it }
        return Texts(lang).also { cachedTexts = it }
    }

    /** Safe to call again: an existing channel only gets its name and description updated. */
    fun createChannels() {
        val x = texts()
        channelsLang = x.lang
        val saleSound = Uri.parse("android.resource://${app.packageName}/${R.raw.likalive_sale}")
        val audio = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()

        fun channel(id: String, importance: Int, name: String, about: String, sound: Uri? = null) =
            NotificationChannel(id, name, importance).apply {
                description = about
                setShowBadge(id != STATUS_CHANNEL)
                if (importance >= NotificationManager.IMPORTANCE_DEFAULT) enableVibration(true)
                if (sound != null) setSound(sound, audio)
            }

        manager.createNotificationChannels(
            listOf(
                channel(
                    STATUS_CHANNEL, NotificationManager.IMPORTANCE_LOW,
                    x.t("Dita deri tani", "The day so far"),
                    x.t("Njoftimi i përhershëm: qarkullimi i ditës dhe sa ka shitur secili.", "The permanent notification: the day's turnover and how much each person sold."),
                ),
                channel(
                    Category.SALES.id, NotificationManager.IMPORTANCE_HIGH,
                    x.t("Shitjet", "Sales"),
                    x.t("Çdo shitje: kush shiti, çfarë dhe sa.", "Every sale: who sold, what and how much."),
                    saleSound,
                ),
                channel(
                    Category.ALERTS.id, NotificationManager.IMPORTANCE_HIGH,
                    x.t("Gjëra për t'u parë", "Things to look at"),
                    x.t("Rimbursime, anulime, ndryshime çmimi, minuta falas, hyrje të dështuara.", "Refunds, voids, price changes, free minutes, failed sign-ins."),
                ),
                channel(
                    Category.PCS.id, NotificationManager.IMPORTANCE_DEFAULT,
                    x.t("Kompjuterët", "The PCs"),
                    x.t("Sesione, kërkesa dhe porosi nga PC-të, rezervime.", "Sessions, requests and orders from the PCs, reservations."),
                ),
                channel(
                    Category.MONEY.id, NotificationManager.IMPORTANCE_DEFAULT,
                    x.t("Paratë", "Money"),
                    x.t("Arka, shpenzimet, blerjet, borxhet.", "The drawer, expenses, purchases, debts."),
                ),
                channel(
                    Category.STOCK.id, NotificationManager.IMPORTANCE_LOW,
                    x.t("Stoku dhe çmimet", "Stock and prices"),
                    x.t("Stok i ulët, rregullime stoku, produkte.", "Low stock, stock adjustments, products."),
                ),
                channel(
                    Category.PEOPLE.id, NotificationManager.IMPORTANCE_LOW,
                    x.t("Punonjësit", "Staff"),
                    x.t("Kush u kyç, llogari, klientë.", "Who signed in, accounts, customers."),
                ),
                channel(
                    Category.SYSTEM.id, NotificationManager.IMPORTANCE_LOW,
                    x.t("Sistemi", "System"),
                    x.t("Cilësime, kopje rezervë, pajisje.", "Settings, backups, devices."),
                ),
                channel(
                    Category.CONNECTION.id, NotificationManager.IMPORTANCE_DEFAULT,
                    x.t("Lidhja me serverin", "The link to the server"),
                    x.t("Kur lidhja mungon gjatë ose duhet hyrë përsëri.", "When the link is down for long or a new sign-in is needed."),
                ),
            ),
        )
    }

    // ─── Host ───────────────────────────────────────────────────────────────────────────────

    override fun post(note: Note) {
        try {
            if (channelsLang != texts().lang) createChannels()
            val notification = Notification.Builder(app, note.category.id)
                .setSmallIcon(R.drawable.ic_stat_live)
                .setColor(ACCENT)
                .setContentTitle(note.title)
                .setContentText(note.text)
                .setStyle(Notification.BigTextStyle().bigText(note.text))
                .setWhen(note.at)
                .setShowWhen(true)
                .setAutoCancel(true)
                .setCategory(if (note.category == Category.CONNECTION) Notification.CATEGORY_STATUS else Notification.CATEGORY_EVENT)
                .setContentIntent(open(note.tab))
                .build()
            manager.notify(note.category.id, note.key.hashCode(), notification)
            trim()
        } catch (e: Exception) {
            Log.w(TAG, "notification not shown: ${e.message}")
        }
    }

    override fun cancel(key: String) {
        try {
            val id = key.hashCode()
            for (shown in notes()) {
                if (shown.id == id) manager.cancel(shown.tag, shown.id)
            }
        } catch (e: Exception) {
            Log.w(TAG, "notification not removed: ${e.message}")
        }
    }

    override fun summary(summary: Summary?) {
        this.summary = summary
        onStatus?.invoke()
    }

    override fun stateChanged(state: EngineState) {
        this.state = state
        onStatus?.invoke()
        listener?.onState()
    }

    override fun changed(kind: String) {
        listener?.onChanged(kind)
    }

    override fun stayAwake(ms: Long) {
        try {
            synchronized(wakeLock) {
                // Not reference counted: a new call replaces the release time of the one before.
                // So only a call that reaches further is passed on; a shorter one changes nothing.
                val until = SystemClock.elapsedRealtime() + ms
                if (until <= awakeUntil) return
                awakeUntil = until
                wakeLock.acquire(ms)
            }
        } catch (e: Exception) {
            Log.w(TAG, "wake lock: ${e.message}")
        }
    }

    override fun log(line: String) {
        Log.i(TAG, line)
    }

    // ─── The permanent notification ─────────────────────────────────────────────────────────

    /** The day at a glance without opening the app: turnover, and who sold how much. */
    fun statusNotification(): Notification = buildStatus().second

    /** The text of the permanent notification (to see whether it changed) and the notification. */
    private fun buildStatus(): Pair<String, Notification> {
        val x = texts()
        if (channelsLang != x.lang) createChannels()
        val s = summary
        val conn = state.conn
        val title: String
        val lines = ArrayList<String>()
        val brief = ArrayList<String>()
        when {
            conn == Conn.UNAUTHORIZED -> {
                title = x.t("Hyni përsëri në likalivepcs", "Sign in to likalivepcs again")
                lines += x.t("Kyçja ka skaduar: njoftimet janë ndalur.", "The sign-in expired: notifications have stopped.")
            }
            s != null -> {
                title = x.t("Sot ${x.money(s.turnoverCents)} · ${s.salesCount} shitje", "Today ${x.money(s.turnoverCents)} · ${s.salesCount} sales")
                for (p in s.staff.take(6)) {
                    lines += "${p.name}: ${x.money(p.salesCents)} · ${p.salesCount} ${x.t("shitje", "sales")}"
                    brief += "${p.name} ${x.money(p.salesCents)}"
                }
                if (lines.isEmpty()) lines += x.t("Ende asnjë shitje sot.", "No sales yet today.")
            }
            else -> {
                title = x.t("likalivepcs po punon", "likalivepcs is running")
                lines += x.t("Po pres shitjen e parë.", "Waiting for the first sale.")
            }
        }
        val status = when (conn) {
            Conn.ONLINE -> x.t("live", "live")
            Conn.CONNECTING -> x.t("po lidhet", "connecting")
            Conn.OFFLINE -> x.t("pa lidhje që nga ${x.time(state.since)}", "offline since ${x.time(state.since)}")
            Conn.UNAUTHORIZED -> x.t("pa kyçje", "signed out")
            Conn.STOPPED -> x.t("ndalur", "stopped")
        }
        val inbox = Notification.InboxStyle()
        for (line in lines) inbox.addLine(line)
        val builder = Notification.Builder(app, STATUS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_live)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(if (brief.isEmpty()) lines.joinToString(" ") else brief.joinToString("  ·  "))
            .setSubText(status)
            .setStyle(inbox)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            // A group of its own: Android bundles an app's other notifications once there are
            // four of them, and the day's figures must stay visible outside that bundle.
            .setGroup(STATUS_GROUP)
            .setCategory(Notification.CATEGORY_STATUS)
            .setContentIntent(open(if (conn == Conn.UNAUTHORIZED) "settings" else "sales"))
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return (title + "\n" + lines.joinToString("\n") + "\n" + status) to builder.build()
    }

    /** The service is (again) in the foreground: its notification may be updated. */
    @Synchronized
    fun statusStarted() {
        statusOn = true
        statusShown = null
    }

    @Synchronized
    fun statusStopped() {
        statusOn = false
        statusShown = null
    }

    @Synchronized
    fun showStatus() {
        if (!statusOn) return
        try {
            val (text, notification) = buildStatus()
            if (text == statusShown) return
            manager.notify(STATUS_ID, notification)
            statusShown = text
        } catch (e: Exception) {
            Log.w(TAG, "status not shown: ${e.message}")
        }
    }

    /** After a sign-out nothing about the shop stays in the notification shade. */
    @Synchronized
    fun clearAll() {
        statusOn = false
        statusShown = null
        summary = null
        try {
            manager.cancelAll()
        } catch (e: Exception) {
            Log.w(TAG, "notifications not cleared: ${e.message}")
        }
    }

    fun allowed(): Boolean = manager.areNotificationsEnabled()

    // ─── Helpers ────────────────────────────────────────────────────────────────────────────

    private fun open(tab: String): PendingIntent {
        val intent = Intent(app, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN)
            .putExtra(MainActivity.EXTRA_TAB, tab)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // One PendingIntent per tab: the request code keeps their extras apart.
        return PendingIntent.getActivity(app, tab.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /**
     * Android shows at most 50 notifications of one app and silently drops any further one. So
     * the oldest are removed first: the newest sale must always get through.
     */
    private fun trim() {
        val shown = notes().sortedBy { it.postTime }
        for (old in shown.take(maxOf(0, shown.size - MAX_SHOWN))) manager.cancel(old.tag, old.id)
    }

    /** The notes this class posted: tagged with their kind (not the permanent one, not the system's bundle header). */
    private fun notes() = manager.activeNotifications.filter { shown ->
        shown.tag != null && Category.of(shown.tag) != null && (shown.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0
    }

    companion object {
        const val TAG = "likalive"
        const val STATUS_CHANNEL = "status"
        const val STATUS_ID = 1
        private const val STATUS_GROUP = "likalive.status"
        private const val MAX_SHOWN = 24
        private const val ACCENT = 0xFF2563EB.toInt()
    }
}
