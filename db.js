const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database('accounts.db');

// 1. Houses table (supports dynamic columns added by Level 0)
// 1. Houses table (unique by house_number/code, NOT house_name)
db.exec(`
  CREATE TABLE IF NOT EXISTS houses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    house_name TEXT NOT NULL,
    house_number TEXT UNIQUE NOT NULL COLLATE NOCASE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// Auto-migrate older houses table (moves UNIQUE from house_name -> house_number, preserves custom columns)
const housesTableMeta = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'houses'")
  .get();

if (housesTableMeta && (housesTableMeta.sql.includes('house_name TEXT UNIQUE') || !housesTableMeta.sql.includes('house_number TEXT UNIQUE'))) {
  console.log('Migrating houses table so house_number (code) is unique instead of house_name...');
  const colInfo = db.prepare('PRAGMA table_info(houses)').all();
  const baseCols = new Set(['id', 'house_name', 'house_number', 'created_at']);
  const extraCols = colInfo.filter((c) => !baseCols.has(c.name));

  db.pragma('foreign_keys = OFF');
  const migrateHouses = db.transaction(() => {
    const extraDefs = extraCols
      .map((c) => {
        const type = c.type || 'TEXT';
        const dflt = c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : '';
        return `"${c.name}" ${type}${dflt}`;
      })
      .join(',\n        ');

    db.exec(`
      CREATE TABLE houses_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        house_name TEXT NOT NULL,
        house_number TEXT UNIQUE NOT NULL COLLATE NOCASE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP${extraDefs ? ',\n        ' + extraDefs : ''}
      )
    `);

    const existingRows = db.prepare('SELECT * FROM houses ORDER BY id ASC').all();
    const usedCodes = new Set();
    const allColNames = ['id', 'house_name', 'house_number', 'created_at', ...extraCols.map((c) => c.name)];
    const insertStmt = db.prepare(`
      INSERT INTO houses_migrated (${allColNames.map((n) => `"${n}"`).join(', ')})
      VALUES (${allColNames.map(() => '?').join(', ')})
    `);

    for (const row of existingRows) {
      let code = String(row.house_number || '').trim();
      if (!code || usedCodes.has(code.toLowerCase())) {
        let suffix = row.id;
        code = `H-${suffix}`;
        while (usedCodes.has(code.toLowerCase())) {
          suffix += 1;
          code = `H-${suffix}`;
        }
      }
      usedCodes.add(code.toLowerCase());

      const vals = [
        row.id,
        row.house_name,
        code,
        row.created_at,
        ...extraCols.map((c) => row[c.name]),
      ];
      insertStmt.run(...vals);
    }

    db.exec('DROP TABLE houses');
    db.exec('ALTER TABLE houses_migrated RENAME TO houses');
  });

  migrateHouses();
  db.pragma('foreign_keys = ON');
}

// 2. Registry of custom columns added by Level 0 (supports data types & dropdown options)
db.exec(`
  CREATE TABLE IF NOT EXISTS custom_columns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL CHECK (table_name IN ('users', 'houses')),
    column_name TEXT NOT NULL,
    display_label TEXT NOT NULL,
    data_type TEXT NOT NULL DEFAULT 'text' CHECK (data_type IN ('text', 'number', 'date', 'tel', 'email', 'boolean', 'select')),
    options_json TEXT NOT NULL DEFAULT '[]',
    created_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(table_name, column_name)
  )
`);

// Auto-migrate existing custom_columns table to support 'select' and options_json
const customColTableMeta = db
  .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'custom_columns'")
  .get();

if (customColTableMeta && (!customColTableMeta.sql.includes("'select'") || !customColTableMeta.sql.includes('options_json'))) {
  const oldCols = db.prepare('PRAGMA table_info(custom_columns)').all().map((c) => c.name);
  const hasDataType = oldCols.includes('data_type');
  const hasOptions = oldCols.includes('options_json');

  const migrateCustomCols = db.transaction(() => {
    db.exec(`
      CREATE TABLE custom_columns_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL CHECK (table_name IN ('users', 'houses')),
        column_name TEXT NOT NULL,
        display_label TEXT NOT NULL,
        data_type TEXT NOT NULL DEFAULT 'text' CHECK (data_type IN ('text', 'number', 'date', 'tel', 'email', 'boolean', 'select')),
        options_json TEXT NOT NULL DEFAULT '[]',
        created_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(table_name, column_name)
      )
    `);

    const dtExpr = hasDataType ? 'data_type' : "'text'";
    const optExpr = hasOptions ? 'options_json' : "'[]'";

    db.exec(`
      INSERT INTO custom_columns_migrated (
        id, table_name, column_name, display_label, data_type, options_json, created_by, created_at
      )
      SELECT id, table_name, column_name, display_label, ${dtExpr}, ${optExpr}, created_by, created_at
      FROM custom_columns
    `);

    db.exec('DROP TABLE custom_columns');
    db.exec('ALTER TABLE custom_columns_migrated RENAME TO custom_columns');
  });

  migrateCustomCols();
}

// 3. Users table (Level 0, 1, 2 + unique login_id + optional house_id)
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    login_id INTEGER UNIQUE NOT NULL,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    access_level INTEGER NOT NULL CHECK (access_level IN (0, 1, 2)),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    house_id INTEGER DEFAULT NULL,
    created_by INTEGER,
    approved_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id),
    FOREIGN KEY (approved_by) REFERENCES users(id)
  )
`);

// Auto-migrate older users table (adds Level 0, login_id, house_id without losing data)
const usersTableMeta = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
if (usersTableMeta && (!usersTableMeta.sql.includes('IN (0, 1, 2)') || !usersTableMeta.sql.includes('login_id'))) {
  console.log('Migrating users table to support Level 0, login_id, and house_id...');
  const oldCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  const hasLoginId = oldCols.includes('login_id');
  const hasHouseId = oldCols.includes('house_id');

  db.pragma('foreign_keys = OFF');
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE users_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login_id INTEGER UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        access_level INTEGER NOT NULL CHECK (access_level IN (0, 1, 2)),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
        house_id INTEGER DEFAULT NULL,
        created_by INTEGER,
        approved_by INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (house_id) REFERENCES houses(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id),
        FOREIGN KEY (approved_by) REFERENCES users(id)
      )
    `);

    const loginExpr = hasLoginId ? 'COALESCE(login_id, 1000 + id)' : '1000 + id';
    const houseExpr = hasHouseId ? 'house_id' : 'NULL';

    db.exec(`
      INSERT INTO users_migrated (
        id, login_id, username, email, password_hash, access_level, status, house_id, created_by, approved_by, created_at
      )
      SELECT
        id, ${loginExpr}, username, email, password_hash, access_level, status, ${houseExpr}, created_by, approved_by, created_at
      FROM users
    `);

    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_migrated RENAME TO users');
  });
  migrate();
  db.pragma('foreign_keys = ON');
}

// 4. Donations, Events, Expenses, Reports tables
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

// Auto-upgrade columns on existing tables
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

// Helper: Generate the next unique numeric login_id
function getNextLoginId() {
  const row = db.prepare('SELECT MAX(login_id) AS maxId FROM users').get();
  let candidate = Math.max(1000, Number(row && row.maxId ? row.maxId : 1000)) + 1;
  while (db.prepare('SELECT 1 FROM users WHERE login_id = ?').get(candidate)) {
    candidate += 1;
  }
  return candidate;
}

// Helper: Return all custom columns registered for a table (including parsed dropdown options)
function getCustomColumns(tableName) {
  const rows = db
    .prepare(`
      SELECT id, table_name, column_name, display_label, data_type, options_json, created_at
      FROM custom_columns
      WHERE table_name = ?
      ORDER BY id ASC
    `)
    .all(tableName);

  return rows.map((row) => {
    let options = [];
    try {
      const parsed = JSON.parse(row.options_json || '[]');
      if (Array.isArray(parsed)) options = parsed;
    } catch {}
    return {
      id: row.id,
      table_name: row.table_name,
      column_name: row.column_name,
      display_label: row.display_label,
      data_type: row.data_type,
      options,
      created_at: row.created_at,
    };
  });
}

// Helper: Return all column names of a table, ALWAYS stripping password_hash
function getSafeTableColumns(tableName) {
  return db
    .prepare(`PRAGMA table_info(${tableName})`)
    .all()
    .map((c) => c.name)
    .filter((name) => name !== 'password_hash');
}

// Seed default accounts if empty
const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;

if (userCount === 0) {
  const insert = db.prepare(`
    INSERT INTO users (login_id, username, email, password_hash, access_level, status)
    VALUES (?, ?, ?, ?, ?, 'approved')
  `);

  insert.run(1000, 'superadmin', 'superadmin@example.com', bcrypt.hashSync('super123', 10), 0);
  insert.run(1001, 'admin', 'admin@example.com', bcrypt.hashSync('admin123', 10), 1);
  insert.run(1002, 'operator', 'operator@example.com', bcrypt.hashSync('operator123', 10), 2);

  console.log('Seeded default accounts:');
  console.log('  Level 0 -> ID 1000 / super123');
  console.log('  Level 1 -> ID 1001 / admin123');
  console.log('  Level 2 -> ID 1002 / operator123');
} else {
  const hasLevel0 = db.prepare('SELECT id FROM users WHERE access_level = 0 LIMIT 1').get();
  if (!hasLevel0) {
    const idForL0 = db.prepare('SELECT 1 FROM users WHERE login_id = 1000').get() ? getNextLoginId() : 1000;
    const uname = db.prepare("SELECT 1 FROM users WHERE username = 'superadmin'").get()
      ? `superadmin_${idForL0}`
      : 'superadmin';
    const mail = db.prepare("SELECT 1 FROM users WHERE email = 'superadmin@example.com'").get()
      ? `superadmin_${idForL0}@example.com`
      : 'superadmin@example.com';

    db.prepare(`
      INSERT INTO users (login_id, username, email, password_hash, access_level, status)
      VALUES (?, ?, ?, ?, 0, 'approved')
    `).run(idForL0, uname, mail, bcrypt.hashSync('super123', 10));

    console.log(`Added Level 0 account -> ID ${idForL0} / super123`);
  }
}

// Ensure protected system event "Subtotal" always exists
const subtotalRow = db.prepare("SELECT id FROM events WHERE LOWER(title) = 'subtotal'").get();
if (!subtotalRow) {
  const owner =
    db.prepare('SELECT id FROM users WHERE access_level IN (0, 1) ORDER BY access_level ASC, id ASC LIMIT 1').get() ||
    db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();

  if (owner) {
    db.prepare(`
      INSERT INTO events (title, event_date, content_json, total_fund, created_by)
      VALUES ('Subtotal', '', '[]', 0, ?)
    `).run(owner.id);
  }
}

// Recalculate every event's total_fund and Subtotal
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
db.getNextLoginId = getNextLoginId;
db.getCustomColumns = getCustomColumns;
db.getSafeTableColumns = getSafeTableColumns;

module.exports = db;