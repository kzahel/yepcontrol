package dev.remoteaccess.app

import android.content.Context
import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet

@Entity(tableName = "devices")
internal data class Device(
    @PrimaryKey val id: String,
    val grant: String,
    val nickname: String,
    val pairedAt: Long,
    val lastConnected: Long = 0,
    val enabled: Boolean = true,
    val revoked: Boolean = false,
    val generation: String = generation(),
    val synced: Boolean = false,
    val wakeReady: Boolean = false,
    @ColumnInfo(defaultValue = "0") val unlockAllowed: Boolean = false,
) {
    fun authority() = JSONObject(grant).also { Website.requireConfigured(it.getString("origin")) }

    val originAllowed: Boolean get() = runCatching { authority() }.isSuccess
}

internal fun generation(): String = UUID.randomUUID().toString().replace("-", "")

@Entity(tableName = "settings")
internal data class HostSettings(
    @PrimaryKey val id: Int = 1,
    val armed: Boolean = true,
    val automatic: Boolean = false,
    @ColumnInfo(defaultValue = "0") val unrestrictedRemoteControl: Boolean = false,
    @ColumnInfo(defaultValue = "0") val unrestrictedInitialized: Boolean = false,
    @ColumnInfo(defaultValue = "0") val unrestrictedUpgradeNotice: Boolean = false,
)

@Entity(tableName = "activity")
internal data class ActivityEvent(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val at: Long,
    val deviceId: String?,
    val deviceName: String?,
    val kind: String,
)

@Dao
internal interface HostDao {
    @Query("SELECT * FROM devices ORDER BY pairedAt, id")
    fun devices(): List<Device>

    @Query("SELECT * FROM settings WHERE id = 1")
    fun settings(): HostSettings?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(device: Device)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun put(settings: HostSettings)

    @Insert
    fun event(event: ActivityEvent)

    @Query("DELETE FROM activity WHERE at < :cutoff OR id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT 10000)")
    fun prune(cutoff: Long)

    @Query("SELECT * FROM activity ORDER BY id DESC LIMIT :limit")
    fun events(limit: Int): List<ActivityEvent>

    @Query("DELETE FROM devices WHERE id = :id")
    fun deleteDevice(id: String)
}

@Database(entities = [Device::class, HostSettings::class, ActivityEvent::class], version = 4, exportSchema = true)
internal abstract class HostDatabase : RoomDatabase() {
    abstract fun dao(): HostDao
}

internal data class HostSnapshot(
    val settings: HostSettings = HostSettings(armed = false),
    val devices: List<Device> = emptyList(),
)

/** All disk operations run off the UI thread; record authority reads use an immutable snapshot. */
internal class HostStore private constructor(
    private val legacy: android.content.SharedPreferences,
    internal val database: HostDatabase,
    private val versionCode: Int = BuildConfig.VERSION_CODE,
) {
    private val dao = database.dao()

    @Volatile private var loaded = false

    @Volatile var snapshot = HostSnapshot()
        private set
    val listeners = CopyOnWriteArraySet<() -> Unit>()

    @Synchronized
    fun load(): HostStore {
        if (loaded) return this
        // Import and policy initialization commit together, before any authority is published.
        database.runInTransaction {
            if (dao.settings() == null) {
                dao.put(HostSettings(automatic = legacy.getBoolean("wakeEnabled", false)))
                legacy.getString("grant", null)?.let { raw ->
                    val grant = JSONObject(raw)
                    val device =
                        Device(
                            grant.getString("id"),
                            raw,
                            "Paired device",
                            System.currentTimeMillis(),
                            revoked = legacy.getBoolean("revoked", false),
                        )
                    dao.put(device)
                    append("Previous pairing imported", device)
                }
            }
            val settings = requireNotNull(dao.settings())
            if (!settings.unrestrictedInitialized) {
                val enabled = versionCode == UNRESTRICTED_UPGRADE_VERSION_CODE && dao.devices().any { !it.revoked }
                dao.put(
                    settings.copy(
                        unrestrictedRemoteControl = enabled,
                        unrestrictedInitialized = true,
                        unrestrictedUpgradeNotice = enabled,
                    ),
                )
                if (enabled) append("Unrestricted remote control enabled by update")
            }
        }
        // The transaction is the migration marker. A crash before this cleanup cannot reimport.
        legacy.save { remove("grant").remove("revoked").remove("wakeEnabled") }
        dao.prune(System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000)
        loaded = true
        publish()
        return this
    }

    private fun publish() {
        snapshot = HostSnapshot(requireNotNull(dao.settings()), dao.devices())
        listeners.forEach { it() }
    }

    fun device(id: String) = snapshot.devices.find { it.id == id }

    fun allowed(
        id: String,
        generation: String,
        automatic: Boolean = false,
    ): Boolean {
        val state = snapshot
        val device = state.devices.find { it.id == id } ?: return false
        return device.originAllowed &&
            state.settings.armed &&
            (!automatic || state.settings.automatic) &&
            device.enabled &&
            !device.revoked &&
            device.generation == generation
    }

    @Synchronized
    fun pair(
        grant: JSONObject,
        name: String? = null,
    ): Device {
        Website.requireConfigured(grant.getString("origin"))
        load()
        check(snapshot.devices.size < 32) { "Remove an unused device before adding another" }
        val id = grant.getString("id")
        check(device(id) == null) { "Device already paired" }
        val taken = snapshot.devices.map { it.nickname }.toSet()
        val nickname =
            if (name != null && name !in taken) {
                name
            } else {
                generateSequence(if (name == null) 1 else 2) { it + 1 }.map { "${name ?: "Device"} $it" }.first { it !in taken }
            }
        val device = Device(id, grant.toString(), nickname, System.currentTimeMillis())
        database.runInTransaction {
            dao.put(device)
            append("Device paired", device)
        }
        publish()
        return device
    }

    @Synchronized
    fun rename(
        id: String,
        value: String,
    ) {
        val name = value.trim()
        require(name.isNotEmpty() && name.length <= 60 && name.none { it.isISOControl() }) { "Use a name between 1 and 60 characters" }
        val device = requireNotNull(device(id))
        database.runInTransaction {
            dao.put(device.copy(nickname = name))
            append("Device renamed", device.copy(nickname = name))
        }
        publish()
    }

    @Synchronized
    fun settings(
        armed: Boolean = snapshot.settings.armed,
        automatic: Boolean = snapshot.settings.automatic,
    ) {
        val before = snapshot.settings
        if (before.armed == armed && before.automatic == automatic) return
        database.runInTransaction {
            dao.put(before.copy(armed = armed, automatic = automatic))
            snapshot.devices.forEach { dao.put(it.copy(generation = generation(), synced = false, wakeReady = false)) }
            if (before.armed != armed) append(if (armed) "Remote access enabled" else "Remote access disabled")
            if (before.automatic != automatic) append(if (automatic) "Automatic requests enabled" else "Automatic requests disabled")
        }
        publish()
    }

    @Synchronized
    fun unrestrictedRemoteControl(enabled: Boolean) {
        load()
        if (snapshot.settings.unrestrictedRemoteControl == enabled) return
        database.runInTransaction {
            dao.put(snapshot.settings.copy(unrestrictedRemoteControl = enabled))
            append(if (enabled) "Unrestricted remote control enabled" else "Unrestricted remote control disabled")
        }
        publish()
    }

    @Synchronized
    fun dismissUnrestrictedUpgradeNotice() {
        load()
        if (!snapshot.settings.unrestrictedUpgradeNotice) return
        dao.put(snapshot.settings.copy(unrestrictedUpgradeNotice = false))
        publish()
    }

    @Synchronized
    fun enable(
        id: String,
        enabled: Boolean,
    ) {
        val device = requireNotNull(device(id))
        if (device.enabled == enabled || device.revoked) return
        database.runInTransaction {
            dao.put(device.copy(enabled = enabled, generation = generation(), synced = false, wakeReady = false))
            append(if (enabled) "Device enabled" else "Device disabled", device)
        }
        publish()
    }

    @Synchronized
    fun revoke(id: String) {
        val device = requireNotNull(device(id))
        if (device.revoked) return
        database.runInTransaction {
            dao.put(device.copy(revoked = true, enabled = false, generation = generation(), synced = false, wakeReady = false))
            append("Device removed locally", device)
        }
        publish()
    }

    @Synchronized
    fun removed(id: String) {
        val device = device(id) ?: return
        check(device.revoked)
        database.runInTransaction {
            dao.deleteDevice(id)
            append("Device removal confirmed", device)
        }
        publish()
    }

    @Synchronized
    fun synced(
        id: String,
        generation: String,
        wakeReady: Boolean,
    ) {
        val device = device(id) ?: return
        if (device.generation != generation || device.revoked) return
        dao.put(device.copy(synced = true, wakeReady = wakeReady))
        publish()
    }

    @Synchronized
    fun allowUnlock(
        id: String,
        enabled: Boolean,
    ) {
        val device = requireNotNull(device(id))
        check(!device.revoked)
        if (device.unlockAllowed == enabled) return
        database.runInTransaction {
            dao.put(device.copy(unlockAllowed = enabled, generation = generation(), synced = false, wakeReady = false))
            append("Device unlock access changed", device)
        }
        publish()
    }

    @Synchronized
    fun connected(id: String) {
        val device = device(id) ?: return
        database.runInTransaction {
            dao.put(device.copy(lastConnected = System.currentTimeMillis()))
            append("Device connected", device)
        }
        publish()
    }

    @Synchronized
    fun record(
        kind: String,
        id: String? = null,
    ) {
        require(kind in EVENT_KINDS)
        database.runInTransaction { append(kind, id?.let(::device)) }
        listeners.forEach { it() }
    }

    private fun append(
        kind: String,
        device: Device? = null,
    ) {
        val now = System.currentTimeMillis()
        dao.event(ActivityEvent(at = now, deviceId = device?.id, deviceName = device?.nickname, kind = kind))
        dao.prune(now - 30L * 24 * 60 * 60 * 1000)
    }

    @Synchronized
    fun events(limit: Int = 100): List<ActivityEvent> {
        dao.prune(System.currentTimeMillis() - 30L * 24 * 60 * 60 * 1000)
        return dao.events(limit.coerceIn(1, 10000))
    }

    companion object {
        // A fixed exception for this release, never a comparison with the current version.
        const val UNRESTRICTED_UPGRADE_VERSION_CODE = 11

        private val EVENT_KINDS =
            setOf(
                "Connection requested",
                "Remote control started",
                "Device unlock access changed",
                "Unlock requested",
                "Phone unlocked",
                "Unlock needs local recovery",
                "Connection check completed",
                "Connection failed",
                "Connection ended",
                "Disconnected on phone",
                "Session blocked: phone busy",
                "Wake setup completed",
                "Wake setup failed",
                "Setup restored after restart",
                "Setup restored after update",
                "Access stopped on phone",
            )

        val MIGRATION_1_2 =
            object : Migration(1, 2) {
                override fun migrate(db: SupportSQLiteDatabase) {
                    db.execSQL("ALTER TABLE browsers ADD COLUMN unlockAllowed INTEGER NOT NULL DEFAULT 0")
                }
            }

        /** Paired clients are devices, not only browsers; history keeps its entries under the new wording. */
        val MIGRATION_2_3 =
            object : Migration(2, 3) {
                override fun migrate(db: SupportSQLiteDatabase) {
                    db.execSQL("ALTER TABLE browsers RENAME TO devices")
                    db.execSQL("ALTER TABLE activity RENAME COLUMN browserId TO deviceId")
                    db.execSQL("ALTER TABLE activity RENAME COLUMN browserName TO deviceName")
                    db.execSQL("UPDATE activity SET kind = 'Device' || substr(kind, 8) WHERE kind GLOB 'Browser *'")
                }
            }

        val MIGRATION_3_4 =
            object : Migration(3, 4) {
                override fun migrate(db: SupportSQLiteDatabase) {
                    db.execSQL("ALTER TABLE settings ADD COLUMN unrestrictedRemoteControl INTEGER NOT NULL DEFAULT 0")
                    db.execSQL("ALTER TABLE settings ADD COLUMN unrestrictedInitialized INTEGER NOT NULL DEFAULT 0")
                    db.execSQL("ALTER TABLE settings ADD COLUMN unrestrictedUpgradeNotice INTEGER NOT NULL DEFAULT 0")
                }
            }

        @Volatile private var instance: HostStore? = null

        fun get(context: Context): HostStore =
            instance ?: synchronized(this) {
                instance ?: HostStore(
                    WakeSupport.preferences(context.applicationContext),
                    Room
                        .databaseBuilder(context.applicationContext, HostDatabase::class.java, "remote-access.db")
                        .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
                        .build(),
                ).also {
                    instance = it
                }
            }

        fun fixture(
            context: Context,
            database: HostDatabase,
            versionCode: Int = BuildConfig.VERSION_CODE,
        ) = HostStore(context.getSharedPreferences("host-store-fixture", Context.MODE_PRIVATE), database, versionCode)
    }
}
