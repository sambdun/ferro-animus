const express = require('express');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcrypt');
const session = require('express-session');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'solo_leveling.db');
const app = express();
app.set('trust proxy', 1);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

class SQLiteStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid     TEXT PRIMARY KEY,
        sess    TEXT NOT NULL,
        expired INTEGER NOT NULL
      )
    `);
    setInterval(() => {
      this.db.prepare('DELETE FROM sessions WHERE expired < ?').run(Math.floor(Date.now() / 1000));
    }, 15 * 60 * 1000).unref();
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expired FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expired < Math.floor(Date.now() / 1000)) return cb(null, null);
      cb(null, JSON.parse(row.sess));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      const ttl = sess.cookie && sess.cookie.maxAge ? Math.floor(sess.cookie.maxAge / 1000) : 86400;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, JSON.stringify(sess), Math.floor(Date.now() / 1000) + ttl);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

app.use(express.json());
app.use(session({
  store: new SQLiteStore(db),
  secret: process.env.SESSION_SECRET || 'ferro-animus-dev-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// ── Auth middleware ────────────────────────────────────────────────────────────
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
  next();
}

function requireLoginPage(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── Protected HTML page routes (before static middleware) ─────────────────────
app.get('/', requireLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/map', requireLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'map.html'));
});
app.get('/ashen', requireLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'ashen.html'));
});
app.get('/story', requireLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'story.html'));
});
app.get('/library', requireLoginPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'library.html'));
});
app.get('/admin', requireLoginPage, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Auth pages — redirect to / if already logged in
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Static files (images, css, etc. — NOT html pages, those are handled above)
app.use(express.static(path.join(__dirname, 'public')));

// ── Init DB ───────────────────────────────────────────────────────────────────
function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    INTEGER DEFAULT (unixepoch()),
      is_admin      INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS game_state (
      user_id  INTEGER PRIMARY KEY,
      total_xp INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS stats (
      user_id   INTEGER PRIMARY KEY,
      str       INTEGER NOT NULL DEFAULT 0,
      dis       INTEGER NOT NULL DEFAULT 0,
      vit       INTEGER NOT NULL DEFAULT 0,
      wis       INTEGER NOT NULL DEFAULT 0,
      endurance INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS xp_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 1,
      date       TEXT    NOT NULL,
      note       TEXT    NOT NULL,
      xp         INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE TABLE IF NOT EXISTS daily_quests (
      user_id  INTEGER NOT NULL DEFAULT 1,
      quest_id TEXT    NOT NULL,
      status   TEXT    NOT NULL,
      date     TEXT    NOT NULL,
      xp       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, quest_id, date)
    );
    CREATE TABLE IF NOT EXISTS quests (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL DEFAULT 1,
      name         TEXT    NOT NULL,
      tag          TEXT    NOT NULL CHECK (tag IN ('weekly','monthly','boss')),
      xp           INTEGER NOT NULL DEFAULT 100,
      status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      completed_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS map_cinematics (
      user_id INTEGER NOT NULL DEFAULT 1,
      region  TEXT    NOT NULL,
      seen    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, region)
    );
    CREATE TABLE IF NOT EXISTS map_gear (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      region     TEXT NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('weapon','armour')),
      name       TEXT NOT NULL,
      unlock_lvl INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS region_bosses (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id   INTEGER NOT NULL DEFAULT 1,
      region    TEXT    NOT NULL,
      level_req INTEGER NOT NULL,
      name      TEXT    NOT NULL,
      subtitle  TEXT    NOT NULL DEFAULT '',
      status    TEXT    NOT NULL DEFAULT 'locked' CHECK(status IN ('locked','active','defeated'))
    );
    CREATE TABLE IF NOT EXISTS books (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL DEFAULT 1,
      title        TEXT    NOT NULL,
      status       TEXT    NOT NULL DEFAULT 'reading' CHECK(status IN ('reading','completed')),
      started_at   TEXT    NOT NULL,
      completed_at TEXT,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS reading_list (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL DEFAULT 1,
      title      TEXT    NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS quest_labels (
      user_id  INTEGER NOT NULL DEFAULT 1,
      quest_id TEXT    NOT NULL,
      label    TEXT    NOT NULL,
      PRIMARY KEY (user_id, quest_id)
    );
  `);

  // Seed global gear if empty
  const gearCount = db.prepare('SELECT COUNT(*) as cnt FROM map_gear').get();
  if (Number(gearCount.cnt) === 0) {
    const gearSeeds = [
      { region: 'ashen',   type: 'weapon', name: 'Rusted Iron Blade',      unlock_lvl: 1  },
      { region: 'ashen',   type: 'armour', name: "Scavenger's Coat",       unlock_lvl: 2  },
      { region: 'savanna', type: 'weapon', name: 'Maasai War Spear',       unlock_lvl: 6  },
      { region: 'savanna', type: 'armour', name: "Warrior's Skins",        unlock_lvl: 6  },
      { region: 'abyss',   type: 'weapon', name: 'Bioluminescent Fang',    unlock_lvl: 11 },
      { region: 'abyss',   type: 'armour', name: 'Temple Guardian Plate',  unlock_lvl: 11 },
      { region: 'throne',  type: 'weapon', name: 'Shadow Sovereign Blade', unlock_lvl: 16 },
      { region: 'throne',  type: 'armour', name: "Void Emperor's Mantle",  unlock_lvl: 16 },
    ];
    const insertGear = db.prepare('INSERT INTO map_gear (region, type, name, unlock_lvl) VALUES (?, ?, ?, ?)');
    gearSeeds.forEach(g => insertGear.run(g.region, g.type, g.name, g.unlock_lvl));
  }
}

// ── Seed fresh data for a new user ────────────────────────────────────────────
function seedUserData(userId) {
  db.prepare('INSERT OR IGNORE INTO game_state (user_id, total_xp) VALUES (?, 0)').run(userId);
  db.prepare('INSERT OR IGNORE INTO stats (user_id, str, dis, vit, wis, endurance) VALUES (?, 0, 0, 0, 0, 0)').run(userId);

  // map_cinematics
  const insertCinematic = db.prepare('INSERT OR IGNORE INTO map_cinematics (user_id, region, seen) VALUES (?, ?, 0)');
  ['savanna', 'abyss', 'throne'].forEach(region => insertCinematic.run(userId, region));

  // quest_labels
  const labelSeeds = [
    ['calorie',  'Calorie Goal'],
    ['macro',    'Macro Goal'],
    ['gym',      'Gym Session'],
    ['water',    'Drink 3L Water'],
    ['scroll',   'Doomscrolling'],
    ['junkfood', 'Junk Food'],
    ['alcohol',  'Alcohol'],
  ];
  const insertLabel = db.prepare('INSERT OR IGNORE INTO quest_labels (user_id, quest_id, label) VALUES (?, ?, ?)');
  labelSeeds.forEach(([qid, label]) => insertLabel.run(userId, qid, label));

  // Default quests (only if user has none)
  const qCount = db.prepare('SELECT COUNT(*) as cnt FROM quests WHERE user_id = ?').get(userId);
  if (Number(qCount.cnt) === 0) {
    const questSeeds = [
      { name: 'Hit gym 5 days in a week',              tag: 'weekly',  xp: 200  },
      { name: 'All 5 habits in a single day',          tag: 'weekly',  xp: 150  },
      { name: '7 days no doomscrolling',               tag: 'weekly',  xp: 200  },
      { name: 'Hit calorie goal 20 days in a month',   tag: 'monthly', xp: 400  },
      { name: '10 perfect days in a single month',     tag: 'boss',    xp: 600  },
      { name: 'Finish a book',                         tag: 'monthly', xp: 200  },
      { name: 'Complete a course or certification',    tag: 'monthly', xp: 300  },
      { name: 'Secure a job offer',                    tag: 'boss',    xp: 1000 },
      { name: 'Get back to a 5-mile run',              tag: 'weekly',  xp: 300  },
      { name: '30-day gym streak',                     tag: 'boss',    xp: 800  },
      { name: 'Lose 10 lbs (reach 210 lbs)',           tag: 'monthly', xp: 500  },
    ];
    const insertQuest = db.prepare('INSERT INTO quests (user_id, name, tag, xp) VALUES (?, ?, ?, ?)');
    questSeeds.forEach(q => insertQuest.run(userId, q.name, q.tag, q.xp));
  }

  // Region bosses (only if user has none)
  const bossCount = db.prepare('SELECT COUNT(*) as cnt FROM region_bosses WHERE user_id = ?').get(userId);
  if (Number(bossCount.cnt) === 0) {
    const bossSeeds = [
      { region: 'ashen',   level_req: 1,  name: 'The Scavenger King',        subtitle: 'Lord of the Rubble'          },
      { region: 'ashen',   level_req: 2,  name: 'Warden of the Rust',        subtitle: 'Keeper of the Dead Quarter'  },
      { region: 'ashen',   level_req: 3,  name: 'The Ash Revenant',          subtitle: 'Risen from the Grey'         },
      { region: 'ashen',   level_req: 4,  name: 'The Industrial Phantom',    subtitle: 'Ghost of the Smokestacks'    },
      { region: 'ashen',   level_req: 5,  name: 'Lord of the Broken City',   subtitle: 'Final Warden of the Ash'    },
      { region: 'savanna', level_req: 6,  name: 'The Red Dust Herald',       subtitle: 'Harbinger of the Plains'     },
      { region: 'savanna', level_req: 7,  name: 'The Elder Horned',          subtitle: 'Ancient Beast of the Herd'  },
      { region: 'savanna', level_req: 8,  name: 'Warlord of the Red Stone',  subtitle: 'Champion of the Kingdom'     },
      { region: 'savanna', level_req: 9,  name: 'The Twilight Stalker',      subtitle: 'Predator at Dusk'            },
      { region: 'savanna', level_req: 10, name: 'The Crimson Sovereign',     subtitle: 'High King of the Savanna'    },
      { region: 'abyss',   level_req: 11, name: 'The Root Warden',           subtitle: 'First Guardian of the Deep'  },
      { region: 'abyss',   level_req: 12, name: 'The Bioluminescent Horror', subtitle: 'Ancient of the Canopy'       },
      { region: 'abyss',   level_req: 13, name: 'Temple Construct',          subtitle: 'Stone Golem of the Ancients' },
      { region: 'abyss',   level_req: 14, name: 'The Venomweaver',           subtitle: 'Silk Empress of the Abyss'   },
      { region: 'abyss',   level_req: 15, name: 'The Verdant God',           subtitle: 'Awakened Heart of the Jungle'},
      { region: 'throne',  level_req: 16, name: 'The Void Sentinel',         subtitle: 'First Gate of the Throne'    },
      { region: 'throne',  level_req: 17, name: 'The Fractured Knight',      subtitle: 'Broken Champion of the Void' },
      { region: 'throne',  level_req: 18, name: 'The Echo of All Realms',    subtitle: 'Memory Given Form'           },
      { region: 'throne',  level_req: 19, name: 'The Undying Emperor',       subtitle: 'He Who Would Not Fall'       },
      { region: 'throne',  level_req: 20, name: 'The Shadow Self',           subtitle: 'Final Boss — Your True Enemy'},
    ];
    const insertBoss = db.prepare(
      'INSERT INTO region_bosses (user_id, region, level_req, name, subtitle, status) VALUES (?, ?, ?, ?, ?, ?)'
    );
    bossSeeds.forEach(b => insertBoss.run(userId, b.region, b.level_req, b.name, b.subtitle, b.level_req === 1 ? 'active' : 'locked'));
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function clamp(val, min = 0, max = 100) {
  return Math.max(min, Math.min(max, parseInt(val) || 0));
}

function computeStats(uid) {
  const rows = db.prepare(`
    SELECT quest_id, COUNT(*) as cnt
    FROM daily_quests
    WHERE user_id = ? AND date >= date('now', '-6 days') AND status = 'completed'
    GROUP BY quest_id
  `).all(uid);
  const c = {};
  rows.forEach(r => { c[r.quest_id] = Number(r.cnt); });
  const g = id => c[id] || 0;

  const booksRow  = db.prepare("SELECT COUNT(*) as cnt FROM books WHERE user_id = ? AND status='completed'").get(uid);
  const booksRead = Number((booksRow || { cnt: 0 }).cnt) || 0;
  const bookWisBonus = Math.min(40, booksRead * 8);

  return {
    str: Math.min(100, Math.round((g('gym'))                                                                          / 7  * 100)),
    dis: Math.min(100, Math.round((g('scroll') + g('alcohol') + g('junkfood'))                                       / 21 * 100)),
    vit: Math.min(100, Math.round((g('calorie') + g('macro') + g('water'))                                           / 21 * 100)),
    wis: Math.min(100, Math.round((g('gym') + g('calorie') + g('macro') + g('water') + g('scroll') + g('alcohol') + g('junkfood')) / 49 * 60) + bookWisBonus),
    end: Math.min(100, Math.round((g('gym') + g('calorie') + g('water'))                                             / 21 * 100)),
  };
}

function fullState(uid) {
  const gs  = db.prepare('SELECT total_xp FROM game_state WHERE user_id = ?').get(uid);
  const log = db.prepare('SELECT date, note, xp FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid);
  return {
    totalXP: gs ? gs.total_xp : 0,
    stats: computeStats(uid),
    log,
  };
}

// Validate & sanitise a YYYY-MM-DD date string (no future dates, max 60 days back)
function parseDate(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return today;
  if (dateStr > today) return today;
  const min = new Date(); min.setDate(min.getDate() - 60);
  if (dateStr < min.toISOString().slice(0, 10)) return null;
  return dateStr;
}

const LEVEL_XP = [0,7300,13300,19300,25300,31300,37300,43300,49300,55300,
                  61300,67300,73300,79300,85300,91300,97300,103300,109300,115300];

function xpToLevel(xp) {
  for (let i = LEVEL_XP.length - 1; i >= 0; i--) {
    if (xp >= LEVEL_XP[i]) return i + 1;
  }
  return 1;
}

// ── Auth routes ───────────────────────────────────────────────────────────────

app.post('/api/register', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  if (!/^[a-zA-Z0-9]{3,20}$/.test(username)) {
    return res.status(400).json({ error: 'Username must be 3–20 alphanumeric characters' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const password_hash = await bcrypt.hash(password, 12);

  // First user to register gets is_admin=1
  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  const isAdmin = Number(userCount.cnt) === 0 ? 1 : 0;

  const result = db.prepare(
    'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)'
  ).run(username, password_hash, isAdmin);

  const userId = Number(result.lastInsertRowid); // node:sqlite returns BigInt
  seedUserData(userId);

  req.session.userId   = userId;
  req.session.username = username;
  req.session.isAdmin  = isAdmin === 1;

  res.json({ ok: true, redirect: '/' });
});

app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  req.session.userId   = user.id;
  req.session.username = user.username;
  req.session.isAdmin  = user.is_admin === 1;

  res.json({ ok: true, redirect: '/' });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true, redirect: '/login' });
  });
});

app.get('/api/me', requireLogin, (req, res) => {
  res.json({ username: req.session.username, isAdmin: req.session.isAdmin });
});

// ── Game API routes ───────────────────────────────────────────────────────────

app.get('/api/state', requireLogin, (req, res) => {
  res.json(fullState(req.session.userId));
});

app.post('/api/xp', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const xp  = parseInt(req.body.xp);
  if (!xp || xp === 0) return res.status(400).json({ error: 'Invalid XP value' });

  const note    = (String(req.body.note || 'Weekly Update')).slice(0, 200);
  const date    = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  db.prepare('UPDATE game_state SET total_xp = MAX(0, total_xp + ?) WHERE user_id = ?').run(xp, uid);
  db.prepare('INSERT INTO xp_log (user_id, date, note, xp) VALUES (?, ?, ?, ?)').run(uid, date, note, xp);
  db.prepare('DELETE FROM xp_log WHERE user_id = ? AND id NOT IN (SELECT id FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50)').run(uid, uid);

  const gs  = db.prepare('SELECT total_xp FROM game_state WHERE user_id = ?').get(uid);
  const log = db.prepare('SELECT date, note, xp FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid);
  res.json({ totalXP: gs.total_xp, log });
});

app.post('/api/stats', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const { str, dis, vit, wis } = req.body;
  const end = req.body.end;
  db.prepare(
    'UPDATE stats SET str=?, dis=?, vit=?, wis=?, endurance=? WHERE user_id=?'
  ).run(clamp(str), clamp(dis), clamp(vit), clamp(wis), clamp(end), uid);
  res.json({ ok: true });
});

// GET /api/daily-quests?date=YYYY-MM-DD
app.get('/api/daily-quests', requireLogin, (req, res) => {
  const uid  = req.session.userId;
  const date = parseDate(req.query.date);
  if (!date) return res.status(400).json({ error: 'Date out of range' });
  const rows = db.prepare('SELECT quest_id, status, xp FROM daily_quests WHERE user_id = ? AND date = ?').all(uid, date);
  const result = {};
  rows.forEach(r => { result[r.quest_id] = { status: r.status, xp: r.xp }; });
  res.json(result);
});

// POST /api/daily-quests — mark or toggle a quest completed/failed
app.post('/api/daily-quests', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const { questId, status } = req.body;

  const QUEST_CONFIG = {
    calorie:  { name: 'Calorie Goal',   completed: 100,  failed: 0    },
    macro:    { name: 'Macro Goal',     completed: 100,  failed: 0    },
    gym:      { name: 'Gym Session',    completed: 100,  failed: 0    },
    water:    { name: 'Drink 3L Water', completed: 100,  failed: 0    },
    scroll:   { name: 'Doomscrolling',  completed: 100,  failed: 0    },
    junkfood: { name: 'Junk Food',      completed: 0,    failed: -100 },
    alcohol:  { name: 'Alcohol',        completed: 0,    failed: -100 },
  };

  const cfg = QUEST_CONFIG[questId];
  if (!cfg || !['completed', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'Invalid quest or status' });
  }

  const today = parseDate(req.body.date);
  if (!today) return res.status(400).json({ error: 'Date out of range' });
  const [y, m, d] = today.split('-').map(Number);
  const logDate = new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const existing = db.prepare(
    'SELECT status FROM daily_quests WHERE user_id = ? AND quest_id = ? AND date = ?'
  ).get(uid, questId, today);

  let xpDelta = 0;

  if (existing) {
    if (existing.status === status) {
      // Same button — no-op
      const gs  = db.prepare('SELECT total_xp FROM game_state WHERE user_id = ?').get(uid);
      const log = db.prepare('SELECT date, note, xp FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid);
      return res.json({ totalXP: gs.total_xp, log, xpAwarded: 0 });
    }
    xpDelta = cfg[status] - cfg[existing.status];
    db.prepare(
      'UPDATE daily_quests SET status = ?, xp = ? WHERE user_id = ? AND quest_id = ? AND date = ?'
    ).run(status, cfg[status], uid, questId, today);
  } else {
    xpDelta = cfg[status];
    db.prepare(
      'INSERT INTO daily_quests (user_id, quest_id, status, date, xp) VALUES (?, ?, ?, ?, ?)'
    ).run(uid, questId, status, today, xpDelta);
  }

  if (xpDelta !== 0) {
    db.prepare('UPDATE game_state SET total_xp = MAX(0, total_xp + ?) WHERE user_id = ?').run(xpDelta, uid);
    const label = xpDelta > 0 ? `Daily: ${cfg.name}` : `Penalty: ${cfg.name}`;
    db.prepare('INSERT INTO xp_log (user_id, date, note, xp) VALUES (?, ?, ?, ?)').run(uid, logDate, label, xpDelta);
    db.prepare('DELETE FROM xp_log WHERE user_id = ? AND id NOT IN (SELECT id FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50)').run(uid, uid);
  }

  const gs  = db.prepare('SELECT total_xp FROM game_state WHERE user_id = ?').get(uid);
  const log = db.prepare('SELECT date, note, xp FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid);
  res.json({ totalXP: gs.total_xp, stats: computeStats(uid), log, xpAwarded: xpDelta });
});

// GET /api/quests
app.get('/api/quests', requireLogin, (req, res) => {
  const uid       = req.session.userId;
  const active    = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='active'    ORDER BY created_at ASC").all(uid);
  const completed = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  res.json({ active, completed });
});

// POST /api/quests — create
app.post('/api/quests', requireLogin, (req, res) => {
  const uid  = req.session.userId;
  const name = String(req.body.name || '').trim().slice(0, 200);
  const tag  = req.body.tag;
  const xp   = Math.max(0, parseInt(req.body.xp) || 0);
  if (!name || !['weekly','monthly','boss'].includes(tag)) {
    return res.status(400).json({ error: 'Invalid quest data' });
  }
  db.prepare('INSERT INTO quests (user_id, name, tag, xp) VALUES (?, ?, ?, ?)').run(uid, name, tag, xp);
  const active    = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='active'    ORDER BY created_at ASC").all(uid);
  const completed = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  res.json({ active, completed });
});

// POST /api/quests/:id/complete
app.post('/api/quests/:id/complete', requireLogin, (req, res) => {
  const uid   = req.session.userId;
  const id    = parseInt(req.params.id);
  const quest = db.prepare("SELECT * FROM quests WHERE id = ? AND user_id = ? AND status = 'active'").get(id, uid);
  if (!quest) return res.status(404).json({ error: 'Quest not found or already completed' });

  db.prepare("UPDATE quests SET status='completed', completed_at=unixepoch() WHERE id=? AND user_id=?").run(id, uid);

  if (quest.xp > 0) {
    const logDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const tag = quest.tag === 'boss' ? 'Boss Defeated' : 'Quest Complete';
    db.prepare('UPDATE game_state SET total_xp = total_xp + ? WHERE user_id = ?').run(quest.xp, uid);
    db.prepare('INSERT INTO xp_log (user_id, date, note, xp) VALUES (?, ?, ?, ?)').run(uid, logDate, `${tag}: ${quest.name}`, quest.xp);
    db.prepare('DELETE FROM xp_log WHERE user_id = ? AND id NOT IN (SELECT id FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50)').run(uid, uid);
  }

  const gs        = db.prepare('SELECT total_xp FROM game_state WHERE user_id = ?').get(uid);
  const log       = db.prepare('SELECT date, note, xp FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(uid);
  const active    = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='active'    ORDER BY created_at ASC").all(uid);
  const completed = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  res.json({ totalXP: gs.total_xp, stats: computeStats(uid), log, active, completed });
});

// DELETE /api/quests/:id
app.delete('/api/quests/:id', requireLogin, (req, res) => {
  const uid = req.session.userId;
  const id  = parseInt(req.params.id);
  db.prepare('DELETE FROM quests WHERE id = ? AND user_id = ?').run(id, uid);
  const active    = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='active'    ORDER BY created_at ASC").all(uid);
  const completed = db.prepare("SELECT * FROM quests WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  res.json({ active, completed });
});

app.post('/api/reset', requireLogin, (req, res) => {
  const uid = req.session.userId;
  db.prepare('UPDATE game_state SET total_xp = 0 WHERE user_id = ?').run(uid);
  db.prepare('UPDATE stats SET str=0, dis=0, vit=0, wis=0, endurance=0 WHERE user_id=?').run(uid);
  db.prepare('DELETE FROM xp_log WHERE user_id = ?').run(uid);
  res.json({ ok: true });
});

// ── Map routes ────────────────────────────────────────────────────────────────

app.get('/api/map', requireLogin, (req, res) => {
  const uid          = req.session.userId;
  const gs           = db.prepare('SELECT total_xp FROM game_state WHERE user_id = ?').get(uid);
  const level        = xpToLevel(gs ? gs.total_xp : 0);
  const cinematics   = db.prepare('SELECT region, seen FROM map_cinematics WHERE user_id = ?').all(uid);
  const gear         = db.prepare('SELECT * FROM map_gear').all();
  const bosses       = db.prepare("SELECT id, name, status, xp, tag FROM quests WHERE user_id = ? AND tag = 'boss'").all(uid);
  const quests       = db.prepare("SELECT id, name, tag, status, xp FROM quests WHERE user_id = ? ORDER BY created_at ASC").all(uid);
  const regionBosses = db.prepare('SELECT * FROM region_bosses WHERE user_id = ? ORDER BY region, level_req ASC').all(uid);
  res.json({ level, total_xp: gs ? gs.total_xp : 0, cinematics, gear, bosses, quests, regionBosses });
});

app.post('/api/map/cinematic-seen', requireLogin, (req, res) => {
  const uid      = req.session.userId;
  const { region } = req.body;
  if (!['savanna', 'abyss', 'throne'].includes(region)) {
    return res.status(400).json({ error: 'Invalid region' });
  }
  db.prepare('UPDATE map_cinematics SET seen = 1 WHERE user_id = ? AND region = ?').run(uid, region);
  res.json({ ok: true });
});

// ── Books routes ──────────────────────────────────────────────────────────────

app.get('/api/books', requireLogin, (req, res) => {
  const uid      = req.session.userId;
  const current  = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='reading' ORDER BY created_at DESC LIMIT 1").get(uid);
  const log      = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  const wishlist = db.prepare("SELECT * FROM reading_list WHERE user_id = ? ORDER BY created_at ASC").all(uid);
  res.json({ current: current || null, log, wishlist });
});

app.post('/api/books', requireLogin, (req, res) => {
  const uid   = req.session.userId;
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title required' });
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  db.prepare('INSERT INTO books (user_id, title, started_at) VALUES (?, ?, ?)').run(uid, title, today);
  const current = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='reading' ORDER BY created_at DESC LIMIT 1").get(uid);
  const log     = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  res.json({ current, log });
});

app.post('/api/books/:id/finish', requireLogin, (req, res) => {
  const uid  = req.session.userId;
  const id   = parseInt(req.params.id);
  const book = db.prepare("SELECT * FROM books WHERE id=? AND user_id=? AND status='reading'").get(id, uid);
  if (!book) return res.status(404).json({ error: 'Book not found' });
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  db.prepare("UPDATE books SET status='completed', completed_at=? WHERE id=? AND user_id=?").run(today, id, uid);
  db.prepare('UPDATE game_state SET total_xp = total_xp + 200 WHERE user_id = ?').run(uid);
  db.prepare('INSERT INTO xp_log (user_id, date, note, xp) VALUES (?, ?, ?, ?)').run(uid, today, `Tome Completed: ${book.title}`, 200);
  db.prepare('DELETE FROM xp_log WHERE user_id = ? AND id NOT IN (SELECT id FROM xp_log WHERE user_id = ? ORDER BY id DESC LIMIT 50)').run(uid, uid);
  const current = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='reading' ORDER BY created_at DESC LIMIT 1").get(uid);
  const log     = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  const gs      = db.prepare('SELECT total_xp FROM game_state WHERE user_id = ?').get(uid);
  res.json({ current: current || null, log, xpAwarded: 200, totalXP: gs.total_xp });
});

// ── Quest labels ──────────────────────────────────────────────────────────────

app.get('/api/quest-labels', requireLogin, (req, res) => {
  const uid  = req.session.userId;
  const rows = db.prepare('SELECT quest_id, label FROM quest_labels WHERE user_id = ?').all(uid);
  const labels = {};
  rows.forEach(r => { labels[r.quest_id] = r.label; });
  res.json(labels);
});

app.patch('/api/quest-labels/:id', requireLogin, (req, res) => {
  const uid     = req.session.userId;
  const questId = req.params.id;
  const label   = String(req.body.label || '').trim().slice(0, 100);
  const valid   = ['calorie','macro','gym','water','scroll','junkfood','alcohol'];
  if (!valid.includes(questId) || !label) return res.status(400).json({ error: 'Invalid' });
  db.prepare('UPDATE quest_labels SET label = ? WHERE user_id = ? AND quest_id = ?').run(label, uid, questId);
  res.json({ ok: true, questId, label });
});

// ── Reading list ──────────────────────────────────────────────────────────────

app.post('/api/reading-list', requireLogin, (req, res) => {
  const uid   = req.session.userId;
  const title = String(req.body.title || '').trim().slice(0, 200);
  if (!title) return res.status(400).json({ error: 'Title required' });
  db.prepare('INSERT INTO reading_list (user_id, title) VALUES (?, ?)').run(uid, title);
  res.json({ wishlist: db.prepare('SELECT * FROM reading_list WHERE user_id = ? ORDER BY created_at ASC').all(uid) });
});

app.delete('/api/reading-list/:id', requireLogin, (req, res) => {
  const uid = req.session.userId;
  db.prepare('DELETE FROM reading_list WHERE id = ? AND user_id = ?').run(parseInt(req.params.id), uid);
  res.json({ wishlist: db.prepare('SELECT * FROM reading_list WHERE user_id = ? ORDER BY created_at ASC').all(uid) });
});

app.post('/api/reading-list/:id/start', requireLogin, (req, res) => {
  const uid   = req.session.userId;
  const entry = db.prepare('SELECT * FROM reading_list WHERE id = ? AND user_id = ?').get(parseInt(req.params.id), uid);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  db.prepare('INSERT INTO books (user_id, title, started_at) VALUES (?, ?, ?)').run(uid, entry.title, today);
  db.prepare('DELETE FROM reading_list WHERE id = ? AND user_id = ?').run(entry.id, uid);
  const current  = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='reading' ORDER BY created_at DESC LIMIT 1").get(uid);
  const log      = db.prepare("SELECT * FROM books WHERE user_id = ? AND status='completed' ORDER BY completed_at DESC").all(uid);
  const wishlist = db.prepare('SELECT * FROM reading_list WHERE user_id = ? ORDER BY created_at ASC').all(uid);
  res.json({ current: current || null, log, wishlist });
});

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/api/admin/users', requireLogin, requireAdmin, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.created_at, u.is_admin, COALESCE(g.total_xp, 0) as total_xp
    FROM users u
    LEFT JOIN game_state g ON g.user_id = u.id
    ORDER BY total_xp DESC
  `).all();
  res.json(users);
});

app.post('/api/admin/reset-user/:id', requireLogin, requireAdmin, (req, res) => {
  const uid = parseInt(req.params.id);
  db.prepare('UPDATE game_state SET total_xp = 0 WHERE user_id = ?').run(uid);
  db.prepare('UPDATE stats SET str=0, dis=0, vit=0, wis=0, endurance=0 WHERE user_id=?').run(uid);
  db.prepare('DELETE FROM xp_log WHERE user_id = ?').run(uid);
  res.json({ ok: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
initDb();
app.listen(PORT, () => {
  console.log(`\n  ⚔  Ferro Animus running → http://localhost:${PORT}\n`);
});
