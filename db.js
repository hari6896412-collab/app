const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database('accounts.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    access_level INTEGER NOT NULL CHECK (access_level IN (1, 2)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_by INTEGER,
    approved_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (approved_by) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS donations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    amount REAL NOT NULL CHECK (amount > 0),
    event_tag TEXT NOT NULL DEFAULT 'General',
    note TEXT DEFAULT '',
    donor_name TEXT NOT NULL DEFAULT '',
    is_manual INTEGER NOT NULL DEFAULT 0,
    recorded_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (recorded_by) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    event_date TEXT DEFAULT '',
    content_json TEXT NOT NULL,
    total_fund REAL NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount REAL NOT NULL CHECK (amount > 0),
    event_tag TEXT NOT NULL DEFAULT 'General',
    type_tag TEXT NOT NULL,
    note TEXT DEFAULT '',
    created_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_type TEXT NOT NULL CHECK (report_type IN ('event', 'monthly', 'quarterly', 'half_yearly', 'yearly')),
    title TEXT NOT NULL,
    period_label TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    generated_by INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (generated_by) REFERENCES users(id)
  )
`);

// Auto-upgrade existing databases safely
const donationCols = db.prepare('PRAGMA table_info(donations)').all();
if (!donationCols.some((c) => c.name === 'event_tag')) {
  db.exec("ALTER TABLE donations ADD COLUMN event_tag TEXT NOT NULL DEFAULT 'General'");
}
if (!donationCols.some((c) => c.name === 'donor_name')) {
  db.exec("ALTER TABLE donations ADD COLUMN donor_name TEXT NOT NULL DEFAULT ''");
}
if (!donationCols.some((c) => c.name === 'is_manual')) {
  db.exec('ALTER TABLE donations ADD COLUMN is_manual INTEGER NOT NULL DEFAULT 0');
}
if (!donationCols.some((c) => c.name === 'recorded_by')) {
  db.exec('ALTER TABLE donations ADD COLUMN recorded_by INTEGER');
}

const eventCols = db.prepare('PRAGMA table_info(events)').all();
if (!eventCols.some((c) => c.name === 'total_fund')) {
  db.exec('ALTER TABLE events ADD COLUMN total_fund REAL NOT NULL DEFAULT 0');
}

// Seed default accounts if empty
const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

if (userCount === 0) {
  const insert = db.prepare(`
    INSERT INTO users (username, email, password_hash, access_level, status)
    VALUES (?, ?, ?, ?, 'approved')
  `);

  insert.run('admin', 'admin@example.com', bcrypt.hashSync('admin123', 10), 1);
  insert.run('operator', 'operator@example.com', bcrypt.hashSync('operator123', 10), 2);

  console.log('Seeded default accounts:');
  console.log('  Level 1 -> admin / admin123');
  console.log('  Level 2 -> operator / operator123');
}

// Ensure protected system event "Subtotal" always exists
const subtotalRow = db.prepare("SELECT id FROM events WHERE LOWER(title) = 'subtotal'").get();
if (!subtotalRow) {
  const owner =
    db.prepare('SELECT id FROM users WHERE access_level = 1 ORDER BY id ASC LIMIT 1').get() ||
    db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();

  if (owner) {
    db.prepare(`
      INSERT INTO events (title, event_date, content_json, total_fund, created_by)
      VALUES ('Subtotal', '', '[]', 0, ?)
    `).run(owner.id);
  }
}

// Sync every event's total_fund and the Subtotal event
function syncEventFunds() {
  db.exec(`
    UPDATE events
    SET total_fund = COALESCE(
      (SELECT SUM(d.amount) FROM donations d WHERE d.event_tag = events.title),
      0
    )
    WHERE LOWER(title) != 'subtotal'
  `);

  db.exec(`
    UPDATE events
    SET total_fund = COALESCE((SELECT SUM(amount) FROM donations), 0)
    WHERE LOWER(title) = 'subtotal'
  `);
}

syncEventFunds();
db.syncEventFunds = syncEventFunds;

module.exports = db;