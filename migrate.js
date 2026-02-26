/**
 * migrate.js — one-time migration from single-user to multi-user schema
 *
 * Run BEFORE deploying the new multi-user server.js:
 *   node migrate.js
 *
 * After this runs, deploy new server.js and register as the first user.
 * Your first registration gets user_id=1, and all existing data is preserved
 * because seedUserData uses INSERT OR IGNORE.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'solo_leveling.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

// Guard: if users table already exists, migration was already run
const usersTableExists = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
).get();

if (usersTableExists) {
  console.log('✓ Migration already applied. users table exists. Nothing to do.');
  db.close();
  process.exit(0);
}

console.log('Starting multi-user migration...\n');

// Capture pre-migration counts for verification
const preCounts = {};
try { preCounts.game_state   = db.prepare('SELECT COUNT(*) as c FROM game_state').get().c;   } catch { preCounts.game_state   = 0; }
try { preCounts.stats        = db.prepare('SELECT COUNT(*) as c FROM stats').get().c;        } catch { preCounts.stats        = 0; }
try { preCounts.xp_log       = db.prepare('SELECT COUNT(*) as c FROM xp_log').get().c;       } catch { preCounts.xp_log       = 0; }
try { preCounts.daily_quests = db.prepare('SELECT COUNT(*) as c FROM daily_quests').get().c; } catch { preCounts.daily_quests = 0; }
try { preCounts.quests       = db.prepare('SELECT COUNT(*) as c FROM quests').get().c;       } catch { preCounts.quests       = 0; }
try { preCounts.map_cinematics = db.prepare('SELECT COUNT(*) as c FROM map_cinematics').get().c; } catch { preCounts.map_cinematics = 0; }
try { preCounts.region_bosses  = db.prepare('SELECT COUNT(*) as c FROM region_bosses').get().c;  } catch { preCounts.region_bosses  = 0; }
try { preCounts.books          = db.prepare('SELECT COUNT(*) as c FROM books').get().c;          } catch { preCounts.books          = 0; }
try { preCounts.reading_list   = db.prepare('SELECT COUNT(*) as c FROM reading_list').get().c;   } catch { preCounts.reading_list   = 0; }
try { preCounts.quest_labels   = db.prepare('SELECT COUNT(*) as c FROM quest_labels').get().c;   } catch { preCounts.quest_labels   = 0; }

console.log('Pre-migration row counts:', preCounts);

db.exec('BEGIN');

try {
  // ── 1. Create users table (empty — first registration gets user_id=1) ────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER DEFAULT (unixepoch()),
      is_admin      INTEGER DEFAULT 0
    );
  `);
  console.log('✓ Created users table');

  // ── 2. Recreate game_state (remove CHECK id=1, add user_id) ─────────────────
  db.exec(`
    CREATE TABLE game_state_new (
      user_id  INTEGER PRIMARY KEY,
      total_xp INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO game_state_new (user_id, total_xp)
      SELECT 1 as user_id, total_xp FROM game_state;
    DROP TABLE game_state;
    ALTER TABLE game_state_new RENAME TO game_state;
  `);
  console.log('✓ Migrated game_state');

  // ── 3. Recreate stats (remove CHECK id=1, add user_id) ──────────────────────
  db.exec(`
    CREATE TABLE stats_new (
      user_id   INTEGER PRIMARY KEY,
      str       INTEGER NOT NULL DEFAULT 0,
      dis       INTEGER NOT NULL DEFAULT 0,
      vit       INTEGER NOT NULL DEFAULT 0,
      wis       INTEGER NOT NULL DEFAULT 0,
      endurance INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO stats_new (user_id, str, dis, vit, wis, endurance)
      SELECT 1 as user_id, str, dis, vit, wis, endurance FROM stats;
    DROP TABLE stats;
    ALTER TABLE stats_new RENAME TO stats;
  `);
  console.log('✓ Migrated stats');

  // ── 4. xp_log — add user_id ──────────────────────────────────────────────────
  db.exec(`
    ALTER TABLE xp_log ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
  `);
  console.log('✓ Migrated xp_log');

  // ── 5. daily_quests — recreate with compound PK (user_id, quest_id, date) ───
  db.exec(`
    CREATE TABLE daily_quests_new (
      user_id  INTEGER NOT NULL DEFAULT 1,
      quest_id TEXT    NOT NULL,
      status   TEXT    NOT NULL,
      date     TEXT    NOT NULL,
      xp       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, quest_id, date)
    );
    INSERT INTO daily_quests_new (user_id, quest_id, status, date, xp)
      SELECT 1, quest_id, status, date, xp FROM daily_quests;
    DROP TABLE daily_quests;
    ALTER TABLE daily_quests_new RENAME TO daily_quests;
  `);
  console.log('✓ Migrated daily_quests');

  // ── 6. quests — add user_id ───────────────────────────────────────────────────
  db.exec(`
    ALTER TABLE quests ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
  `);
  console.log('✓ Migrated quests');

  // ── 7. map_cinematics — recreate with compound PK (user_id, region) ─────────
  db.exec(`
    CREATE TABLE map_cinematics_new (
      user_id INTEGER NOT NULL DEFAULT 1,
      region  TEXT    NOT NULL,
      seen    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, region)
    );
    INSERT INTO map_cinematics_new (user_id, region, seen)
      SELECT 1, region, seen FROM map_cinematics;
    DROP TABLE map_cinematics;
    ALTER TABLE map_cinematics_new RENAME TO map_cinematics;
  `);
  console.log('✓ Migrated map_cinematics');

  // ── 8. region_bosses — add user_id ───────────────────────────────────────────
  db.exec(`
    ALTER TABLE region_bosses ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
  `);
  console.log('✓ Migrated region_bosses');

  // ── 9. books — add user_id ────────────────────────────────────────────────────
  db.exec(`
    ALTER TABLE books ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
  `);
  console.log('✓ Migrated books');

  // ── 10. reading_list — add user_id ────────────────────────────────────────────
  db.exec(`
    ALTER TABLE reading_list ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1;
  `);
  console.log('✓ Migrated reading_list');

  // ── 11. quest_labels — recreate with compound PK (user_id, quest_id) ─────────
  db.exec(`
    CREATE TABLE quest_labels_new (
      user_id  INTEGER NOT NULL DEFAULT 1,
      quest_id TEXT    NOT NULL,
      label    TEXT    NOT NULL,
      PRIMARY KEY (user_id, quest_id)
    );
    INSERT INTO quest_labels_new (user_id, quest_id, label)
      SELECT 1, quest_id, label FROM quest_labels;
    DROP TABLE quest_labels;
    ALTER TABLE quest_labels_new RENAME TO quest_labels;
  `);
  console.log('✓ Migrated quest_labels');

  db.exec('COMMIT');
  console.log('\n✓ Migration committed successfully\n');

} catch (err) {
  db.exec('ROLLBACK');
  console.error('\n✗ Migration FAILED — rolled back:', err.message);
  db.close();
  process.exit(1);
}

// ── Verify post-migration counts ──────────────────────────────────────────────
const postCounts = {
  game_state:    db.prepare('SELECT COUNT(*) as c FROM game_state').get().c,
  stats:         db.prepare('SELECT COUNT(*) as c FROM stats').get().c,
  xp_log:        db.prepare('SELECT COUNT(*) as c FROM xp_log').get().c,
  daily_quests:  db.prepare('SELECT COUNT(*) as c FROM daily_quests').get().c,
  quests:        db.prepare('SELECT COUNT(*) as c FROM quests').get().c,
  map_cinematics: db.prepare('SELECT COUNT(*) as c FROM map_cinematics').get().c,
  region_bosses:  db.prepare('SELECT COUNT(*) as c FROM region_bosses').get().c,
  books:          db.prepare('SELECT COUNT(*) as c FROM books').get().c,
  reading_list:   db.prepare('SELECT COUNT(*) as c FROM reading_list').get().c,
  quest_labels:   db.prepare('SELECT COUNT(*) as c FROM quest_labels').get().c,
};

console.log('Post-migration row counts:', postCounts);

let allMatch = true;
for (const key of Object.keys(preCounts)) {
  if (preCounts[key] !== postCounts[key]) {
    console.error(`✗ Row count mismatch for ${key}: before=${preCounts[key]}, after=${postCounts[key]}`);
    allMatch = false;
  }
}

if (allMatch) {
  console.log('\n✓ All row counts match. Migration complete!');
  console.log('\nNext steps:');
  console.log('  1. npm install (to install better-sqlite3, bcrypt, express-session)');
  console.log('  2. node server.js');
  console.log('  3. Register your account at http://localhost:3000/register');
  console.log('     → First registration = user_id=1 = admin, existing data preserved\n');
} else {
  console.error('\n✗ Some row counts do not match — review above before proceeding\n');
}

db.close();
