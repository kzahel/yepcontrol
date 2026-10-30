package dev.remoteaccess.app

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

@RunWith(AndroidJUnit4::class)
class HostStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val legacy get() = context.getSharedPreferences("host-store-fixture", android.content.Context.MODE_PRIVATE)
    private lateinit var db: HostDatabase
    private lateinit var store: HostStore

    @Before
    fun setup() {
        legacy.edit().clear().commit()
        db = Room.inMemoryDatabaseBuilder(context, HostDatabase::class.java).build()
        store = HostStore.fixture(context, db, HostStore.UNRESTRICTED_UPGRADE_VERSION_CODE)
    }

    @After
    fun cleanup() {
        db.close()
        legacy.edit().clear().commit()
    }

    private fun grant(id: String) =
        JSONObject()
            .put(
                "id",
                id,
            ).put("origin", BuildConfig.SHARING_WEBSITE)
            .put("viewer", "public-identity-$id")

    @Test
    fun migratesOnceAndPreservesRevocationAndWakeChoice() {
        val raw = grant("a").toString()
        legacy
            .edit()
            .putString("grant", raw)
            .putBoolean("revoked", true)
            .putBoolean("wakeEnabled", true)
            .commit()
        store.load()
        val pairedDevice = store.snapshot.devices.single()
        assertEquals(raw, pairedDevice.grant)
        assertTrue(pairedDevice.revoked)
        assertTrue(store.snapshot.settings.automatic)
        assertFalse(store.allowed(pairedDevice.id, pairedDevice.generation))
        assertFalse(legacy.contains("grant"))
        // Simulate a crash between the database commit and preference cleanup.
        legacy.edit().putString("grant", grant("b").toString()).commit()
        val reopened = HostStore.fixture(context, db).load()
        assertEquals(listOf("a"), reopened.snapshot.devices.map { it.id })
        assertEquals(1, reopened.events().count { it.kind == "Previous pairing imported" })
    }

    @Test
    fun multipleDevicesKeepSeparateAuthorityAndOldGenerationsNeverReturn() {
        store.load()
        val a = store.pair(grant("a"))
        val b = store.pair(grant("b"))
        store.rename(a.id, "Work laptop")
        assertEquals(a.grant, store.device(a.id)?.grant)
        store.enable(a.id, false)
        assertFalse(store.allowed(a.id, a.generation))
        assertTrue(store.allowed(b.id, b.generation))
        store.enable(a.id, true)
        assertFalse(store.allowed(a.id, a.generation))
        assertTrue(store.allowed(a.id, requireNotNull(store.device(a.id)).generation))
        val before = requireNotNull(store.device(b.id)).generation
        store.settings(armed = false)
        assertFalse(store.allowed(b.id, before))
        store.settings(armed = true)
        assertFalse(store.allowed(b.id, before))
        store.revoke(a.id)
        assertFalse(store.allowed(a.id, requireNotNull(store.device(a.id)).generation))
        assertEquals("Work laptop", store.device(a.id)?.nickname)
        store.removed(a.id)
        assertEquals(listOf(b.id), store.snapshot.devices.map { it.id })
        assertEquals("Device removed locally", store.events().first { it.kind == "Device removed locally" }.kind)
    }

    @Test
    fun historyIsBoundedAndCannotRecordArbitraryPayloads() {
        store.load()
        db.runInTransaction {
            repeat(10005) {
                db.dao().event(
                    ActivityEvent(at = System.currentTimeMillis(), deviceId = null, deviceName = null, kind = "Connection ended"),
                )
            }
            db.dao().event(ActivityEvent(at = 1, deviceId = null, deviceName = null, kind = "Too old"))
        }
        assertEquals(9999, store.events(10000).size)
        assertFailsWith<IllegalArgumentException> { store.record("sensitive remote payload") }
        assertFailsWith<IllegalArgumentException> { store.rename("missing", "\n") }
    }

    @Test
    fun anotherPairingAddsAccessAndFailedCleanupCannotRestoreRemovedAccess() {
        store.load()
        val old = store.pair(grant("old").put("viewer", "same-browser-key"), "Laptop")
        val added = store.pair(grant("added").put("viewer", "same-browser-key"), "Laptop")
        assertEquals("Laptop 2", added.nickname)
        assertTrue(store.allowed(old.id, old.generation))
        assertTrue(store.allowed(added.id, added.generation))

        store.revoke(old.id)
        // Leave the cleanup record unacknowledged, as when the relay is unreachable.
        store = HostStore.fixture(context, db).load()
        val pending = requireNotNull(store.device(old.id))
        assertTrue(pending.revoked)
        assertFalse(pending.synced)
        assertFalse(store.allowed(old.id, old.generation))
        assertFalse(store.allowed(old.id, pending.generation))
        store.enable(old.id, true)
        assertFalse(store.allowed(old.id, pending.generation))
        assertTrue(store.allowed(added.id, added.generation))

        // Eventual cleanup only discards the bookkeeping record; access was already blocked.
        store.removed(old.id)
        assertFalse(store.allowed(old.id, pending.generation))
        assertEquals(listOf(added.id), store.snapshot.devices.map { it.id })
    }

    @Test
    fun rejectsNewGrantsForUnconfiguredServices() {
        store.load()
        assertFailsWith<IllegalArgumentException> { store.pair(grant("bad").put("origin", "https://other.example")) }
        assertTrue(store.snapshot.devices.isEmpty())
    }

    @Test
    fun savedOffOriginGrantsStayVisibleButCannotRegainAuthority() {
        val allowed = store.load().pair(grant("allowed"))
        val unsupported = Device("old", grant("old").put("origin", "https://other.example").toString(), "Old device", 1)
        db.dao().put(unsupported)
        db.dao().put(Device("malformed", "{}", "Malformed grant", 1))
        store = HostStore.fixture(context, db).load()
        assertEquals(3, store.snapshot.devices.size)
        assertTrue(store.allowed(allowed.id, allowed.generation))
        assertFalse(store.allowed(unsupported.id, unsupported.generation))
        assertFalse(requireNotNull(store.device("malformed")).originAllowed)
        assertFailsWith<IllegalArgumentException> { requireNotNull(store.device(unsupported.id)).authority() }
        store.enable(unsupported.id, false)
        store.enable(unsupported.id, true)
        assertFalse(store.allowed(unsupported.id, requireNotNull(store.device(unsupported.id)).generation))
        store.revoke(unsupported.id)
        store.removed(unsupported.id)
        assertEquals(
            setOf(allowed.id, "malformed"),
            store.snapshot.devices
                .map { it.id }
                .toSet(),
        )
    }

    @Test fun designatedUpgradeIncludesPausedPairingsWithoutChangingAuthority() {
        db.dao().put(HostSettings(armed = false, automatic = true))
        val paired = Device("upgrade", grant("upgrade").toString(), "Existing", 1, enabled = false, unlockAllowed = false)
        db.dao().put(paired)
        store.load()
        assertTrue(store.snapshot.settings.unrestrictedRemoteControl)
        assertTrue(store.snapshot.settings.unrestrictedInitialized)
        assertTrue(store.snapshot.settings.unrestrictedUpgradeNotice)
        assertEquals(paired, store.device(paired.id))
        assertFalse(store.allowed(paired.id, paired.generation))
        assertFalse(store.snapshot.settings.armed)
        assertEquals(1, store.events().count { it.kind == "Unrestricted remote control enabled by update" })
        store.dismissUnrestrictedUpgradeNotice()
        store.unrestrictedRemoteControl(false)
        store.settings(automatic = false)
        val later = HostStore.fixture(context, db, HostStore.UNRESTRICTED_UPGRADE_VERSION_CODE + 1).load()
        assertFalse(later.snapshot.settings.unrestrictedRemoteControl)
        assertTrue(later.snapshot.settings.unrestrictedInitialized)
        assertFalse(later.snapshot.settings.unrestrictedUpgradeNotice)
        assertFalse(
            HostStore
                .fixture(context, db)
                .load()
                .snapshot.settings.unrestrictedRemoteControl,
        )
        assertEquals(1, later.events().count { it.kind == "Unrestricted remote control enabled by update" })
    }

    @Test fun freshAndUnpairedAndRevokedOnlyRemainOff() {
        store.load()
        assertTrue(store.snapshot.settings.unrestrictedInitialized)
        assertFalse(store.snapshot.settings.unrestrictedRemoteControl)
        store.pair(grant("new"))
        assertFalse(
            HostStore
                .fixture(context, db)
                .load()
                .snapshot.settings.unrestrictedRemoteControl,
        )
        // An old database with no initialization decision and only a revoked grant.
        db.dao().put(HostSettings())
        store.revoke("new")
        val revokedOnly = HostStore.fixture(context, db).load()
        assertFalse(revokedOnly.snapshot.settings.unrestrictedRemoteControl)
        assertTrue(revokedOnly.snapshot.settings.unrestrictedInitialized)
        revokedOnly.removed("new")
        db.dao().put(HostSettings())
        assertFalse(
            HostStore
                .fixture(context, db)
                .load()
                .snapshot.settings.unrestrictedRemoteControl,
        )
    }

    @Test fun skippingDesignatedReleaseNeverEnablesAndLegacyImportPrecedesDecision() {
        legacy.edit().putString("grant", grant("legacy").toString()).commit()
        val later = HostStore.fixture(context, db, HostStore.UNRESTRICTED_UPGRADE_VERSION_CODE + 1).load()
        assertEquals(
            "legacy",
            later.snapshot.devices
                .single()
                .id,
        )
        assertFalse(later.snapshot.settings.unrestrictedRemoteControl)
        assertTrue(later.snapshot.settings.unrestrictedInitialized)
        assertFalse(
            HostStore
                .fixture(context, db)
                .load()
                .snapshot.settings.unrestrictedRemoteControl,
        )
    }

    @Test fun legacyPairingInitializesOnceAndInterruptedInitializationRollsBack() {
        legacy.edit().putString("grant", grant("legacy").toString()).commit()
        // Abort between saving the policy decision and its activity entry.
        db.openHelper.writableDatabase.execSQL(
            "CREATE TRIGGER interrupt_initialization BEFORE INSERT ON activity " +
                "WHEN NEW.kind = 'Unrestricted remote control enabled by update' BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END",
        )
        assertFailsWith<android.database.sqlite.SQLiteException> { store.load() }
        assertEquals(null, db.dao().settings())
        assertTrue(db.dao().devices().isEmpty())
        assertTrue(legacy.contains("grant"))
        assertTrue(store.snapshot.devices.isEmpty())
        assertFalse(store.snapshot.settings.armed)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER interrupt_initialization")
        store.load()
        assertTrue(store.snapshot.settings.unrestrictedRemoteControl)
        assertEquals(1, store.snapshot.devices.size)
        assertFalse(legacy.contains("grant"))
        val reopened = HostStore.fixture(context, db).load()
        assertEquals(1, reopened.events().count { it.kind == "Unrestricted remote control enabled by update" })
        assertEquals(1, reopened.events().count { it.kind == "Previous pairing imported" })
    }

    @Test fun initializedChoicesSurviveDatabaseCloseAndLaterVersion() {
        val name = "unrestricted-persistence-fixture"
        context.deleteDatabase(name)

        fun open() = Room.databaseBuilder(context, HostDatabase::class.java, name).build()
        var disk = open()
        try {
            disk.dao().put(HostSettings())
            disk.dao().put(Device("persisted", grant("persisted").toString(), "Saved device", 1))
            val designated = HostStore.fixture(context, disk, HostStore.UNRESTRICTED_UPGRADE_VERSION_CODE).load()
            assertTrue(designated.snapshot.settings.unrestrictedRemoteControl)
            disk.close()
            disk = open()
            val later = HostStore.fixture(context, disk, HostStore.UNRESTRICTED_UPGRADE_VERSION_CODE + 1).load()
            assertTrue(later.snapshot.settings.unrestrictedRemoteControl)
            assertTrue(later.snapshot.settings.unrestrictedUpgradeNotice)
            later.unrestrictedRemoteControl(false)
            later.dismissUnrestrictedUpgradeNotice()
            disk.close()
            disk = open()
            val reopened = HostStore.fixture(context, disk, HostStore.UNRESTRICTED_UPGRADE_VERSION_CODE + 2).load()
            assertFalse(reopened.snapshot.settings.unrestrictedRemoteControl)
            assertFalse(reopened.snapshot.settings.unrestrictedUpgradeNotice)
            assertTrue(reopened.snapshot.settings.unrestrictedInitialized)
            assertEquals(
                "persisted",
                reopened.snapshot.devices
                    .single()
                    .id,
            )
            assertEquals(1, reopened.events().count { it.kind == "Unrestricted remote control enabled by update" })
        } finally {
            disk.close()
            context.deleteDatabase(name)
        }
    }
}
