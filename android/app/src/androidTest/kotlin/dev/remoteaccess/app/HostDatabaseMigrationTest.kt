package dev.remoteaccess.app

import androidx.room.Room
import androidx.room.testing.MigrationTestHelper
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Rule
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class HostDatabaseMigrationTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @get:Rule val migration = MigrationTestHelper(instrumentation, HostDatabase::class.java)

    @Test fun devicesKeepAuthorityAndHistoryUnderNewNames() {
        migration.createDatabase("device-migration-fixture", 2).use { db ->
            db.execSQL("INSERT INTO browsers VALUES ('a','{}','Chrome on macOS',123,456,1,0,'old-generation',1,1,1)")
            db.execSQL("INSERT INTO settings VALUES (1,1,0)")
            db.execSQL("INSERT INTO activity (at, browserId, browserName, kind) VALUES (100,'a','Chrome on macOS','Browser paired')")
            db.execSQL("INSERT INTO activity (at, browserId, browserName, kind) VALUES (200,'a','Chrome on macOS','Connection requested')")
            db.execSQL("INSERT INTO activity (at, browserId, browserName, kind) VALUES (300,NULL,NULL,'Remote access enabled')")
        }
        migration.runMigrationsAndValidate("device-migration-fixture", 3, true, HostStore.MIGRATION_2_3).use { db ->
            db.query("SELECT nickname, generation, unlockAllowed, synced FROM devices WHERE id='a'").use { row ->
                assertTrue(row.moveToFirst())
                assertEquals("Chrome on macOS", row.getString(0))
                assertEquals("old-generation", row.getString(1))
                assertEquals(1, row.getInt(2))
                assertEquals(1, row.getInt(3))
            }
            db.query("SELECT deviceId, deviceName, kind FROM activity ORDER BY at").use { rows ->
                val history =
                    generateSequence { if (rows.moveToNext()) Triple(rows.getString(0), rows.getString(1), rows.getString(2)) else null }
                assertEquals(
                    listOf(
                        Triple("a", "Chrome on macOS", "Device paired"),
                        Triple("a", "Chrome on macOS", "Connection requested"),
                        Triple(null, null, "Remote access enabled"),
                    ),
                    history.toList(),
                )
            }
        }
    }

    @Test fun firstReleaseDatabaseOpensThroughEveryMigration() {
        migration.createDatabase("chain-migration-fixture", 1).use { db ->
            db.execSQL("INSERT INTO browsers VALUES ('a','{\"id\":\"a\"}','Work laptop',123,456,1,0,'old-generation',1,1)")
            db.execSQL("INSERT INTO settings VALUES (1,1,1)")
        }
        val database =
            Room
                .databaseBuilder(instrumentation.targetContext, HostDatabase::class.java, "chain-migration-fixture")
                .addMigrations(HostStore.MIGRATION_1_2, HostStore.MIGRATION_2_3, HostStore.MIGRATION_3_4)
                .build()
        try {
            val stored = database.dao().devices().single()
            assertEquals("Work laptop", stored.nickname)
            assertEquals(false, stored.unlockAllowed)
            assertEquals(true, database.dao().settings()?.automatic)
        } finally {
            database.close()
            instrumentation.targetContext.deleteDatabase("chain-migration-fixture")
        }
    }

    @Test fun structuralMigrationDoesNotMakeTheReleaseDecision() {
        migration.createDatabase("unrestricted-migration-fixture", 3).use { db ->
            db.execSQL("INSERT INTO devices VALUES ('a','{}','Saved device',123,456,0,0,'generation',1,1,1)")
            db.execSQL("INSERT INTO settings VALUES (1,0,1)")
        }
        migration.runMigrationsAndValidate("unrestricted-migration-fixture", 4, true, HostStore.MIGRATION_3_4).use { db ->
            db
                .query(
                    "SELECT armed, automatic, unrestrictedRemoteControl, unrestrictedInitialized, " +
                        "unrestrictedUpgradeNotice FROM settings",
                ).use { row ->
                    assertTrue(row.moveToFirst())
                    assertEquals(listOf(0, 1, 0, 0, 0), (0..4).map { row.getInt(it) })
                }
        }
    }
}
