require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { requireAuth, requireLevel } = require('./auth');
const { sendDonationAcknowledgement } = require('./mailer');

if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is missing in your .env file.');
  process.exit(1);
}

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DYNAMIC_TABLES = ['users', 'houses'];
const RESERVED_COLUMNS = new Set([
  'id', 'login_id', 'username', 'email', 'password', 'password_hash',
  'access_level', 'status', 'house_id', 'house_name', 'house_number',
  'created_by', 'approved_by', 'created_at', 'members', 'member_count',
]);

const ALLOWED_DATA_TYPES = {
  text:    { sqlType: "TEXT DEFAULT ''",   label: 'Text' },
  number:  { sqlType: 'REAL DEFAULT NULL', label: 'Number' },
  date:    { sqlType: "TEXT DEFAULT ''",   label: 'Date' },
  tel:     { sqlType: "TEXT DEFAULT ''",   label: 'Phone' },
  email:   { sqlType: "TEXT DEFAULT ''",   label: 'Email' },
  boolean: { sqlType: "TEXT DEFAULT ''",   label: 'Yes / No' },
  select:  { sqlType: "TEXT DEFAULT ''",   label: 'Dropdown' },
};

app.use(express.json({ limit: '15mb' }));
app.use(express.static(PUBLIC_DIR));

// ==========================================
// HELPERS
// ==========================================

function validateCustomValue(col, rawVal, isRequired) {
  const type = col.data_type || 'text';
  const strVal = rawVal === null || rawVal === undefined ? '' : String(rawVal).trim();

  if (strVal === '') {
    if (isRequired) {
      return { error: `"${col.display_label}" is mandatory while signing up.` };
    }
    return { value: type === 'number' ? null : '' };
  }

  if (type === 'number') {
    const num = Number(strVal);
    if (!Number.isFinite(num)) {
      return { error: `"${col.display_label}" must be a valid number.` };
    }
    return { value: num };
  }

  if (type === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(strVal)) {
      return { error: `"${col.display_label}" must be a valid date (YYYY-MM-DD).` };
    }
    return { value: strVal };
  }

  if (type === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(strVal)) {
      return { error: `"${col.display_label}" must be a valid email address.` };
    }
    return { value: strVal };
  }

  if (type === 'tel') {
    if (!/^[+\d][\d\s\-()]{5,20}$/.test(strVal)) {
      return { error: `"${col.display_label}" must be a valid phone number.` };
    }
    return { value: strVal };
  }

  if (type === 'boolean') {
    const lower = strVal.toLowerCase();
    if (['yes', 'true', '1'].includes(lower)) return { value: 'Yes' };
    if (['no', 'false', '0'].includes(lower)) return { value: 'No' };
    return { error: `"${col.display_label}" must be "Yes" or "No".` };
  }

  if (type === 'select') {
    const allowed = Array.isArray(col.options) ? col.options : [];
    const matched = allowed.find((opt) => opt.toLowerCase() === strVal.toLowerCase());
    if (!matched) {
      return { error: `"${col.display_label}" must be one of: ${allowed.join(', ')}.` };
    }
    return { value: matched };
  }

  return { value: strVal.slice(0, 250) };
}

function getUserPhoneColumn() {
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);

  const registered = db.prepare(`
    SELECT column_name
    FROM custom_columns
    WHERE table_name = 'users' AND LOWER(display_label) = 'phone number'
    LIMIT 1
  `).get();

  if (registered && cols.includes(registered.column_name)) {
    return registered.column_name;
  }

  if (cols.includes('Phone Number')) return 'Phone Number';
  if (cols.includes('phone_number')) return 'phone_number';
  return null;
}

function saveBase64Image(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw new Error('INVALID_IMAGE');

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);

  return `/uploads/${filename}`;
}

function getTodayDateStr() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isEventExpired(eventDate) {
  const clean = String(eventDate || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) && clean < getTodayDateStr();
}

function resolveEventTag(rawTag, { blockExpired = false } = {}) {
  const cleanTag = String(rawTag || 'General').trim();
  if (!cleanTag || cleanTag.toLowerCase() === 'general') {
    return { valid: true, value: 'General' };
  }
  if (cleanTag.toLowerCase() === 'subtotal') {
    return { valid: false, error: 'Cannot assign "Subtotal" directly as an event tag' };
  }
  const matched = db.prepare(`
    SELECT title, event_date FROM events WHERE title = ? AND LOWER(title) != 'subtotal'
  `).get(cleanTag);
  if (!matched) {
    return { valid: false, error: 'Selected event does not exist' };
  }
  if (blockExpired && isEventExpired(matched.event_date)) {
    return {
      valid: false,
      error: `Donations for "${matched.title}" closed after ${matched.event_date}.`,
    };
  }
  return { valid: true, value: matched.title };
}

function sanitizeColumnName(rawLabel) {
  return String(rawLabel || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function buildReportQuery(params) {
  const { report_type, event_tag, year, month, quarter, half } = params;
  const pad2 = (n) => String(n).padStart(2, '0');

  if (report_type === 'event') {
    const resolved = resolveEventTag(event_tag);
    if (!resolved.valid) return { error: resolved.error };
    return {
      title: `Event Report — ${resolved.value}`,
      periodLabel: `Event: ${resolved.value}`,
      whereSql: 'event_tag = ?',
      whereArgs: [resolved.value],
    };
  }

  const yr = Number(year);
  if (!Number.isInteger(yr) || yr < 2000 || yr > 2100) {
    return { error: 'Please select a valid year (2000–2100)' };
  }

  let startDate = '';
  let endDate = '';
  let title = '';
  let periodLabel = '';

  if (report_type === 'monthly') {
    const m = Number(month);
    if (!Number.isInteger(m) || m < 1 || m > 12) {
      return { error: 'Please select a valid month (1–12)' };
    }
    const nextYear = m === 12 ? yr + 1 : yr;
    const nextMonth = m === 12 ? 1 : m + 1;
    startDate = `${yr}-${pad2(m)}-01 00:00:00`;
    endDate = `${nextYear}-${pad2(nextMonth)}-01 00:00:00`;
    periodLabel = `${MONTH_NAMES[m - 1]} ${yr}`;
    title = `Monthly Report — ${periodLabel}`;
  } else if (report_type === 'quarterly') {
    const q = Number(quarter);
    if (![1, 2, 3, 4].includes(q)) {
      return { error: 'Please select a valid quarter (1–4)' };
    }
    const startMonth = (q - 1) * 3 + 1;
    const endYear = q === 4 ? yr + 1 : yr;
    const endMonth = q === 4 ? 1 : startMonth + 3;
    const labels = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];
    startDate = `${yr}-${pad2(startMonth)}-01 00:00:00`;
    endDate = `${endYear}-${pad2(endMonth)}-01 00:00:00`;
    periodLabel = `Q${q} ${yr} (${labels[q - 1]})`;
    title = `Quarterly Report — ${periodLabel}`;
  } else if (report_type === 'half_yearly') {
    const h = Number(half);
    if (![1, 2].includes(h)) {
      return { error: 'Please select a valid half-year (1 or 2)' };
    }
    startDate = h === 1 ? `${yr}-01-01 00:00:00` : `${yr}-07-01 00:00:00`;
    endDate = h === 1 ? `${yr}-07-01 00:00:00` : `${yr + 1}-01-01 00:00:00`;
    periodLabel = h === 1 ? `H1 ${yr} (Jan–Jun)` : `H2 ${yr} (Jul–Dec)`;
    title = `Half-Yearly Report — ${periodLabel}`;
  } else if (report_type === 'yearly') {
    startDate = `${yr}-01-01 00:00:00`;
    endDate = `${yr + 1}-01-01 00:00:00`;
    periodLabel = `Year ${yr}`;
    title = `Yearly Report — ${yr}`;
  } else {
    return { error: 'Invalid report_type. Choose event, monthly, quarterly, half_yearly, or yearly.' };
  }

  return {
    title,
    periodLabel,
    whereSql: 'created_at >= ? AND created_at < ?',
    whereArgs: [startDate, endDate],
  };
}

function groupExpensesBy(expenses, keyField) {
  const map = new Map();

  for (const ex of expenses) {
    const key = ex[keyField] || 'General';
    if (!map.has(key)) {
      map.set(key, { category: key, count: 0, total: 0, items: [] });
    }
    const bucket = map.get(key);
    bucket.count += 1;
    bucket.total = Math.round((bucket.total + ex.amount) * 100) / 100;
    bucket.items.push({
      id: ex.id,
      amount: ex.amount,
      event_tag: ex.event_tag,
      type_tag: ex.type_tag,
      note: ex.note,
      recorded_by: ex.recorded_by,
      created_at: ex.created_at,
    });
  }

  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

// ==========================================
// DYNAMIC SCHEMA ROUTES (Level 0 Adds & Removes Columns)
// ==========================================

app.get('/api/schema/:table', (req, res) => {
  const { table } = req.params;
  if (!DYNAMIC_TABLES.includes(table)) {
    return res.status(400).json({ error: 'Invalid table. Use "users" or "houses".' });
  }
  const columns = db.getCustomColumns(table);
  res.json({ table, columns });
});

app.post('/api/schema/:table/columns', requireAuth, requireLevel(0), (req, res) => {
  const { table } = req.params;
  if (!DYNAMIC_TABLES.includes(table)) {
    return res.status(400).json({ error: 'Columns can only be added to "users" or "houses".' });
  }

  const displayLabel = String(req.body?.label || '').trim().slice(0, 50);
  if (!displayLabel) {
    return res.status(400).json({ error: 'Column label is required' });
  }

  const dataType = String(req.body?.data_type || 'text').trim().toLowerCase();
  const typeDef = ALLOWED_DATA_TYPES[dataType];
  if (!typeDef) {
    return res.status(400).json({
      error: `Invalid data_type. Allowed: ${Object.keys(ALLOWED_DATA_TYPES).join(', ')}`,
    });
  }

  let cleanOptions = [];
  if (dataType === 'select') {
    const rawOptions = Array.isArray(req.body?.options)
      ? req.body.options
      : String(req.body?.options || '').split(',');

    const seen = new Set();
    for (const item of rawOptions) {
      const opt = String(item ?? '').trim().slice(0, 80);
      if (opt && !seen.has(opt.toLowerCase())) {
        seen.add(opt.toLowerCase());
        cleanOptions.push(opt);
      }
    }

    if (cleanOptions.length < 1) {
      return res.status(400).json({
        error: 'Please provide at least one dropdown option (comma-separated).',
      });
    }
  }

  const colName = sanitizeColumnName(req.body?.column_name || displayLabel);
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(colName)) {
    return res.status(400).json({
      error: 'Column name must start with a letter and be 2–41 characters (letters, numbers, spaces/underscores).',
    });
  }

  if (RESERVED_COLUMNS.has(colName)) {
    return res.status(400).json({ error: `"${colName}" is a reserved system column name.` });
  }

  const existingCols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (existingCols.includes(colName)) {
    return res.status(409).json({ error: `Column "${colName}" already exists in ${table}.` });
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN "${colName}" ${typeDef.sqlType}`);
  db.prepare(`
    INSERT INTO custom_columns (table_name, column_name, display_label, data_type, options_json, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(table, colName, displayLabel, dataType, JSON.stringify(cleanOptions), req.user.id);

  res.status(201).json({
    message: `Column "${displayLabel}" (${typeDef.label}) added to ${table}.`,
    column: {
      table_name: table,
      column_name: colName,
      display_label: displayLabel,
      data_type: dataType,
      options: cleanOptions,
    },
  });
});

app.delete('/api/schema/:table/columns/:columnName', requireAuth, requireLevel(0), (req, res) => {
  const { table, columnName } = req.params;
  if (!DYNAMIC_TABLES.includes(table)) {
    return res.status(400).json({ error: 'Columns can only be removed from "users" or "houses".' });
  }

  const colName = String(columnName || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(colName) || RESERVED_COLUMNS.has(colName)) {
    return res.status(400).json({ error: 'System or invalid columns cannot be removed.' });
  }

  const registered = db.prepare(`
    SELECT id, display_label
    FROM custom_columns
    WHERE table_name = ? AND column_name = ?
  `).get(table, colName);

  if (!registered) {
    return res.status(404).json({ error: `Custom column "${colName}" not found in ${table}.` });
  }

  const existingCols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  try {
    const dropColumn = db.transaction(() => {
      if (existingCols.includes(colName)) {
        db.exec(`ALTER TABLE ${table} DROP COLUMN "${colName}"`);
      }
      db.prepare('DELETE FROM custom_columns WHERE id = ?').run(registered.id);
    });

    dropColumn();
    res.json({
      message: `Column "${registered.display_label}" removed from ${table}.`,
    });
  } catch (err) {
    console.error('Failed to drop column:', err);
    res.status(500).json({ error: 'Could not remove column from database.' });
  }
});

// ==========================================
// AUTH ROUTES (Login by Unique User ID Number)
// ==========================================

app.post('/api/login', (req, res) => {
  const { login_id, password } = req.body || {};
  const parsedLoginId = Number(login_id);

  if (!Number.isInteger(parsedLoginId) || !password) {
    return res.status(400).json({ error: 'Unique User ID number and password are required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE login_id = ?').get(parsedLoginId);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid User ID number or password' });
  }

  if (user.status !== 'approved') {
    return res.status(403).json({
      error: `Account (ID ${user.login_id}) is currently '${user.status}' and requires admin approval`,
    });
  }

  const token = jwt.sign(
    {
      id: user.id,
      login_id: user.login_id,
      username: user.username,
      access_level: user.access_level,
    },
    process.env.JWT_SECRET,
    { expiresIn: '2h' }
  );

  res.json({
    token,
    access_level: user.access_level,
    login_id: user.login_id,
    username: user.username,
  });
});

app.post('/api/signup', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const accessLevel = Number(body.access_level ?? 2);

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are all mandatory' });
  }

  if (![1, 2].includes(accessLevel)) {
    return res.status(400).json({ error: 'Public signup access_level must be 1 or 2' });
  }

  const customCols = db.getCustomColumns('users');
  const customFieldsInput = body.custom_fields || {};
  const colNames = ['login_id', 'username', 'email', 'password_hash', 'access_level', 'status', 'created_by', 'approved_by'];
  const loginId = db.getNextLoginId();
  const values = [loginId, username, email, bcrypt.hashSync(password, 10), accessLevel, 'pending', null, null];

  for (const col of customCols) {
    const rawVal = customFieldsInput[col.column_name] ?? body[col.column_name];
    const check = validateCustomValue(col, rawVal, true);
    if (check.error) return res.status(400).json({ error: check.error });
    colNames.push(`"${col.column_name}"`);
    values.push(check.value);
  }

  try {
    const placeholders = values.map(() => '?').join(', ');
    const result = db.prepare(`
      INSERT INTO users (${colNames.join(', ')})
      VALUES (${placeholders})
    `).run(...values);

    res.status(201).json({
      message: `Account submitted! Your Unique Login ID Number is ${loginId}. Save it to sign in once approved.`,
      login_id: loginId,
      user: {
        id: result.lastInsertRowid,
        login_id: loginId,
        username,
        email,
        access_level: accessLevel,
        status: 'pending',
      },
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ==========================================
// USER MANAGEMENT ROUTES (Level 0 & 1 — NO PASSWORD ACCESS)
// ==========================================

app.get('/api/users', requireAuth, requireLevel(0, 1), (req, res) => {
  const safeCols = db.getSafeTableColumns('users');
  const selectSql = safeCols.map((c) => `u."${c}"`).join(', ');
  const customCols = db.getCustomColumns('users');

  const users = db.prepare(`
    SELECT ${selectSql}, h.house_name
    FROM users u
    LEFT JOIN houses h ON u.house_id = h.id
    ORDER BY u.id ASC
  `).all();

  for (const u of users) {
    for (const c of customCols) {
      if (u[c.column_name] === undefined) {
        u[c.column_name] = c.data_type === 'number' ? null : '';
      }
    }
  }

  res.json({ count: users.length, custom_columns: customCols, users });
});

app.post('/api/users', requireAuth, requireLevel(0, 1), (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const accessLevel = Number(body.access_level ?? 2);
  const houseId = body.house_id ? Number(body.house_id) : null;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password are required' });
  }

  if (![0, 1, 2].includes(accessLevel)) {
    return res.status(400).json({ error: 'access_level must be 0, 1, or 2' });
  }

  if (accessLevel === 0 && req.user.access_level !== 0) {
    return res.status(403).json({ error: 'Only Level 0 can create another Level 0 account' });
  }

  if (houseId !== null && !db.prepare('SELECT id FROM houses WHERE id = ?').get(houseId)) {
    return res.status(400).json({ error: 'Selected house does not exist' });
  }

  const customCols = db.getCustomColumns('users');
  const customFieldsInput = body.custom_fields || {};
  const loginId = db.getNextLoginId();

  const colNames = ['login_id', 'username', 'email', 'password_hash', 'access_level', 'status', 'house_id', 'created_by', 'approved_by'];
  const values = [loginId, username, email, bcrypt.hashSync(password, 10), accessLevel, 'approved', houseId, req.user.id, req.user.id];

  for (const col of customCols) {
    const rawVal = customFieldsInput[col.column_name] ?? body[col.column_name];
    const check = validateCustomValue(col, rawVal, false);
    if (check.error) return res.status(400).json({ error: check.error });
    colNames.push(`"${col.column_name}"`);
    values.push(check.value);
  }

  try {
    const placeholders = values.map(() => '?').join(', ');
    const result = db.prepare(`
      INSERT INTO users (${colNames.join(', ')})
      VALUES (${placeholders})
    `).run(...values);

    res.status(201).json({
      message: `Account created! Unique Login ID: ${loginId}`,
      login_id: loginId,
      user: {
        id: result.lastInsertRowid,
        login_id: loginId,
        username,
        email,
        access_level: accessLevel,
        status: 'approved',
        house_id: houseId,
      },
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/users/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });

  const existing = db.prepare('SELECT id, access_level, username FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  if (existing.access_level === 0 && req.user.access_level !== 0) {
    return res.status(403).json({ error: 'Only Level 0 can edit a Level 0 account' });
  }

  const body = req.body || {};
  const updates = [];
  const params = [];

  if (body.username !== undefined) {
    const clean = String(body.username).trim();
    if (!clean) return res.status(400).json({ error: 'Username cannot be empty' });
    updates.push('username = ?');
    params.push(clean);
  }

  if (body.email !== undefined) {
    const clean = String(body.email).trim();
    if (!clean) return res.status(400).json({ error: 'Email cannot be empty' });
    updates.push('email = ?');
    params.push(clean);
  }

  if (body.access_level !== undefined) {
    const lvl = Number(body.access_level);
    if (![0, 1, 2].includes(lvl)) {
      return res.status(400).json({ error: 'access_level must be 0, 1, or 2' });
    }
    if (lvl === 0 && req.user.access_level !== 0) {
      return res.status(403).json({ error: 'Only Level 0 can assign Level 0 access' });
    }
    updates.push('access_level = ?');
    params.push(lvl);
  }

  if (body.status !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(body.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updates.push('status = ?');
    params.push(body.status);
  }

  if (body.house_id !== undefined) {
    if (body.house_id === null || body.house_id === '') {
      updates.push('house_id = NULL');
    } else {
      const hId = Number(body.house_id);
      if (!db.prepare('SELECT id FROM houses WHERE id = ?').get(hId)) {
        return res.status(400).json({ error: 'Selected house does not exist' });
      }
      updates.push('house_id = ?');
      params.push(hId);
    }
  }

  const customCols = db.getCustomColumns('users');
  const customFieldsInput = body.custom_fields || {};
  for (const col of customCols) {
    const val = customFieldsInput[col.column_name] !== undefined
      ? customFieldsInput[col.column_name]
      : body[col.column_name];
    if (val !== undefined) {
      const check = validateCustomValue(col, val, false);
      if (check.error) return res.status(400).json({ error: check.error });
      updates.push(`"${col.column_name}" = ?`);
      params.push(check.value);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  try {
    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ message: 'User updated (passwords remain protected).' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/users/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own active account' });

  const target = db.prepare('SELECT id, username, access_level FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (target.access_level === 0 && req.user.access_level !== 0) {
    return res.status(403).json({ error: 'Only Level 0 can delete a Level 0 account' });
  }

  const removeUser = db.transaction(() => {
    db.prepare(`
      UPDATE donations
      SET donor_name = CASE WHEN donor_name = '' THEN ? ELSE donor_name END,
          user_id = ?
      WHERE user_id = ?
    `).run(target.username, req.user.id, id);

    db.prepare('UPDATE donations SET recorded_by = ? WHERE recorded_by = ?').run(req.user.id, id);
    db.prepare('UPDATE events SET created_by = ? WHERE created_by = ?').run(req.user.id, id);
    db.prepare('UPDATE expenses SET created_by = ? WHERE created_by = ?').run(req.user.id, id);
    db.prepare('UPDATE reports SET generated_by = ? WHERE generated_by = ?').run(req.user.id, id);
    db.prepare('UPDATE users SET created_by = NULL WHERE created_by = ?').run(id);
    db.prepare('UPDATE users SET approved_by = NULL WHERE approved_by = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  });

  removeUser();
  res.json({ message: `User "${target.username}" deleted.` });
});

app.patch('/api/users/:id/decision', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });

  const { decision } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  }

  const targetUser = db.prepare('SELECT id, status FROM users WHERE id = ?').get(id);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  if (targetUser.status !== 'pending') {
    return res.status(400).json({ error: `User is already ${targetUser.status}` });
  }

  db.prepare('UPDATE users SET status = ?, approved_by = ? WHERE id = ?')
    .run(decision, req.user.id, id);

  res.json({
    message: `User ${id} has been ${decision}.`,
    approved_by: req.user.id,
  });
});

// ==========================================
// HOUSES DATABASE ROUTES (Level 0 & 1 — Unique by House Code)
// ==========================================

app.get('/api/houses/check-code', requireAuth, requireLevel(0, 1), (req, res) => {
  const cleanCode = String(req.query.code || '').trim();
  if (!cleanCode) {
    return res.json({ available: false, error: 'House code is required' });
  }

  const excludeId = req.query.exclude_id ? Number(req.query.exclude_id) : null;
  const existing = Number.isInteger(excludeId)
    ? db.prepare('SELECT id, house_name FROM houses WHERE LOWER(house_number) = LOWER(?) AND id != ?').get(cleanCode, excludeId)
    : db.prepare('SELECT id, house_name FROM houses WHERE LOWER(house_number) = LOWER(?)').get(cleanCode);

  res.json({
    available: !existing,
    code: cleanCode,
    existing_house: existing ? existing.house_name : null,
  });
});

app.get('/api/houses', requireAuth, requireLevel(0, 1), (req, res) => {
  const customCols = db.getCustomColumns('houses');
  const houses = db.prepare('SELECT * FROM houses ORDER BY id ASC').all();
  const allMembers = db.prepare(`
    SELECT id, login_id, username, email, access_level, house_id
    FROM users
    WHERE house_id IS NOT NULL
    ORDER BY username ASC
  `).all();

  const membersByHouse = new Map();
  for (const m of allMembers) {
    if (!membersByHouse.has(m.house_id)) membersByHouse.set(m.house_id, []);
    membersByHouse.get(m.house_id).push(m);
  }

  const enriched = houses.map((h) => {
    for (const c of customCols) {
      if (h[c.column_name] === undefined) {
        h[c.column_name] = c.data_type === 'number' ? null : '';
      }
    }
    const members = membersByHouse.get(h.id) || [];
    return { ...h, member_count: members.length, members };
  });

  res.json({ count: enriched.length, custom_columns: customCols, houses: enriched });
});

app.post('/api/houses', requireAuth, requireLevel(0, 1), (req, res) => {
  const body = req.body || {};
  const houseName = String(body.house_name || '').trim();
  const houseNumber = String(body.house_number || '').trim();

  if (!houseName) {
    return res.status(400).json({ error: 'House name is required' });
  }

  if (!houseNumber) {
    return res.status(400).json({ error: 'House code is required' });
  }

  const duplicateCode = db
    .prepare('SELECT id, house_name FROM houses WHERE LOWER(house_number) = LOWER(?)')
    .get(houseNumber);

  if (duplicateCode) {
    return res.status(409).json({
      error: `House code "${houseNumber}" is already taken by "${duplicateCode.house_name}".`,
    });
  }

  const customCols = db.getCustomColumns('houses');
  const customFieldsInput = body.custom_fields || {};
  const colNames = ['house_name', 'house_number'];
  const values = [houseName, houseNumber];

  for (const col of customCols) {
    const rawVal = customFieldsInput[col.column_name] ?? body[col.column_name];
    const check = validateCustomValue(col, rawVal, false);
    if (check.error) return res.status(400).json({ error: check.error });
    colNames.push(`"${col.column_name}"`);
    values.push(check.value);
  }

  try {
    const placeholders = values.map(() => '?').join(', ');
    const result = db.prepare(`
      INSERT INTO houses (${colNames.join(', ')})
      VALUES (${placeholders})
    `).run(...values);

    res.status(201).json({
      message: `House "${houseName}" (${houseNumber}) created.`,
      id: result.lastInsertRowid,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `House code "${houseNumber}" is already taken.` });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/houses/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid house ID' });

  const existing = db.prepare('SELECT id FROM houses WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'House not found' });

  const body = req.body || {};
  const updates = [];
  const params = [];

  if (body.house_name !== undefined) {
    const clean = String(body.house_name).trim();
    if (!clean) return res.status(400).json({ error: 'House name cannot be empty' });
    updates.push('house_name = ?');
    params.push(clean);
  }

  if (body.house_number !== undefined) {
    const cleanCode = String(body.house_number ?? '').trim();
    if (!cleanCode) return res.status(400).json({ error: 'House code cannot be empty' });

    const duplicateCode = db
      .prepare('SELECT id, house_name FROM houses WHERE LOWER(house_number) = LOWER(?) AND id != ?')
      .get(cleanCode, id);

    if (duplicateCode) {
      return res.status(409).json({
        error: `House code "${cleanCode}" is already taken by "${duplicateCode.house_name}".`,
      });
    }

    updates.push('house_number = ?');
    params.push(cleanCode);
  }

  const customCols = db.getCustomColumns('houses');
  const customFieldsInput = body.custom_fields || {};
  for (const col of customCols) {
    const val = customFieldsInput[col.column_name] !== undefined
      ? customFieldsInput[col.column_name]
      : body[col.column_name];
    if (val !== undefined) {
      const check = validateCustomValue(col, val, false);
      if (check.error) return res.status(400).json({ error: check.error });
      updates.push(`"${col.column_name}" = ?`);
      params.push(check.value);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  try {
    params.push(id);
    db.prepare(`UPDATE houses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ message: 'House updated.' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That house code is already taken.' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/houses/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid house ID' });

  db.prepare('UPDATE users SET house_id = NULL WHERE house_id = ?').run(id);
  const info = db.prepare('DELETE FROM houses WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'House not found' });

  res.json({ message: 'House deleted and members unassigned.' });
});

app.patch('/api/houses/assign-member', requireAuth, requireLevel(0, 1), (req, res) => {
  const { user_id, house_id } = req.body || {};
  const uId = Number(user_id);
  if (!Number.isInteger(uId)) return res.status(400).json({ error: 'Valid user_id is required' });

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(uId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (house_id === null || house_id === '' || house_id === undefined) {
    db.prepare('UPDATE users SET house_id = NULL WHERE id = ?').run(uId);
    return res.json({ message: `${user.username} removed from house.` });
  }

  const hId = Number(house_id);
  const house = db.prepare('SELECT id, house_name FROM houses WHERE id = ?').get(hId);
  if (!house) return res.status(404).json({ error: 'House not found' });

  db.prepare('UPDATE users SET house_id = ? WHERE id = ?').run(hId, uId);
  res.json({ message: `${user.username} assigned to "${house.house_name}".` });
});

// ==========================================
// DONATION, ANALYTICS & FUNDS ROUTES
// ==========================================

app.get('/api/donations', requireAuth, (req, res) => {
  const donations = db.prepare(`
    SELECT d.id,
           CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS username,
           d.amount, d.event_tag, d.note, d.is_manual, d.created_at
    FROM donations d
    JOIN users u ON d.user_id = u.id
    WHERE d.user_id = ? AND (d.donor_name = '' OR d.donor_name = u.username)
    ORDER BY d.id DESC
  `).all(req.user.id);

  const total = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({ total, count: donations.length, donations });
});

app.get('/api/admin/donations', requireAuth, requireLevel(0, 1), (req, res) => {
  const donations = db.prepare(`
    SELECT d.id, d.user_id, u.login_id,
           CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS donor_display,
           h.house_name,
           d.amount, d.event_tag, d.note, d.is_manual, d.created_at
    FROM donations d
    JOIN users u ON d.user_id = u.id
    LEFT JOIN houses h ON u.house_id = h.id
    ORDER BY d.id DESC
  `).all();

  const total = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({ total, count: donations.length, donations });
});

app.get('/api/donations/major', requireAuth, (req, res) => {
  const donations = db.prepare(`
    SELECT d.id,
           CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS username,
           d.amount, d.event_tag, d.note, d.is_manual, d.created_at
    FROM donations d
    JOIN users u ON d.user_id = u.id
    WHERE d.amount > 10000
    ORDER BY d.id DESC
  `).all();

  const total = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({ total, count: donations.length, donations });
});

app.get('/api/donations/by-person', requireAuth, requireLevel(0, 1), (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.login_id, u.username, u.email, u.house_id, h.house_name
    FROM users u
    LEFT JOIN houses h ON u.house_id = h.id
    ORDER BY u.id ASC
  `).all();

  const allDonations = db.prepare(`
    SELECT d.id, d.user_id, d.amount, d.event_tag, d.note, d.donor_name, d.is_manual, d.created_at, u.username
    FROM donations d
    JOIN users u ON d.user_id = u.id
    ORDER BY d.id DESC
  `).all();

  const peopleMap = new Map();
  for (const u of users) {
    peopleMap.set(`user:${u.id}`, {
      key: `user:${u.id}`,
      user_id: u.id,
      login_id: u.login_id,
      name: u.username,
      email: u.email,
      house_name: u.house_name || 'Unassigned',
      is_registered: true,
      donation_count: 0,
      total_donated: 0,
      donations: [],
    });
  }

  for (const d of allDonations) {
    const isCustomGuest = d.donor_name && d.donor_name !== d.username;
    const key = isCustomGuest ? `guest:${d.donor_name}` : `user:${d.user_id}`;

    if (!peopleMap.has(key)) {
      peopleMap.set(key, {
        key,
        user_id: null,
        login_id: null,
        name: d.donor_name,
        email: '',
        house_name: 'Unassigned (Offline Donor)',
        is_registered: false,
        donation_count: 0,
        total_donated: 0,
        donations: [],
      });
    }

    const person = peopleMap.get(key);
    person.donation_count += 1;
    person.total_donated = Math.round((person.total_donated + d.amount) * 100) / 100;
    person.donations.push({
      id: d.id,
      amount: d.amount,
      event_tag: d.event_tag,
      note: d.note,
      is_manual: d.is_manual,
      created_at: d.created_at,
    });
  }

  const people = Array.from(peopleMap.values()).sort((a, b) => b.total_donated - a.total_donated);
  res.json({ count: people.length, people });
});

app.get('/api/donations/by-house', requireAuth, requireLevel(0, 1), (req, res) => {
  const houses = db.prepare('SELECT * FROM houses ORDER BY house_name ASC').all();
  const users = db.prepare('SELECT id, login_id, username, house_id FROM users ORDER BY username ASC').all();
  const allDonations = db.prepare(`
    SELECT d.id, d.user_id, d.amount, d.event_tag, d.note, d.donor_name, d.is_manual, d.created_at, u.username, u.login_id, u.house_id
    FROM donations d
    JOIN users u ON d.user_id = u.id
    ORDER BY d.id DESC
  `).all();

  const houseMap = new Map();
  for (const h of houses) {
    houseMap.set(h.id, {
      house_id: h.id,
      house_name: h.house_name,
      house_number: h.house_number || '',
      members: [],
      donation_count: 0,
      total_donated: 0,
      donations: [],
    });
  }

  const unassigned = {
    house_id: null,
    house_name: 'Unassigned / External Donors',
    house_number: '',
    members: [],
    donation_count: 0,
    total_donated: 0,
    donations: [],
  };

  for (const u of users) {
    if (u.house_id && houseMap.has(u.house_id)) {
      houseMap.get(u.house_id).members.push({ id: u.id, login_id: u.login_id, username: u.username });
    }
  }

  for (const d of allDonations) {
    const isCustomGuest = d.donor_name && d.donor_name !== d.username;
    const targetBucket =
      !isCustomGuest && d.house_id && houseMap.has(d.house_id)
        ? houseMap.get(d.house_id)
        : unassigned;

    targetBucket.donation_count += 1;
    targetBucket.total_donated = Math.round((targetBucket.total_donated + d.amount) * 100) / 100;
    targetBucket.donations.push({
      id: d.id,
      donor: isCustomGuest ? d.donor_name : d.username,
      login_id: isCustomGuest ? null : d.login_id,
      amount: d.amount,
      event_tag: d.event_tag,
      note: d.note,
      is_manual: d.is_manual,
      created_at: d.created_at,
    });
  }

  const result = Array.from(houseMap.values()).sort((a, b) => b.total_donated - a.total_donated);
  if (unassigned.donation_count > 0) {
    result.push(unassigned);
  }

  res.json({ count: result.length, houses: result });
});

// Standard user donation -> blocks expired events, sends email (Resend) & SMS
app.post('/api/donations', requireAuth, async (req, res, next) => {
  try {
    const { amount, event_tag = 'General', note = '' } = req.body || {};
    const parsedAmount = Math.round(Number(amount) * 100) / 100;

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount greater than 0' });
    }

    const resolved = resolveEventTag(event_tag, { blockExpired: true });
    if (!resolved.valid) return res.status(400).json({ error: resolved.error });

    const cleanNote = String(note).trim().slice(0, 150);

    const result = db.prepare(`
      INSERT INTO donations (user_id, amount, event_tag, note, donor_name, is_manual, recorded_by)
      VALUES (?, ?, ?, ?, '', 0, NULL)
    `).run(req.user.id, parsedAmount, resolved.value, cleanNote);

    db.syncEventFunds();

    const donationId = result.lastInsertRowid;
    const phoneCol = getUserPhoneColumn();
    const selectCols = phoneCol
      ? `username, email, "${phoneCol}" AS phone_number`
      : `username, email, '' AS phone_number`;

    const donor = db.prepare(`SELECT ${selectCols} FROM users WHERE id = ?`).get(req.user.id);

    let emailPreviewUrl = null;
    const notices = [];

    if (donor) {
      const ack = await sendDonationAcknowledgement({
        to: donor.email,
        phone: donor.phone_number,
        username: donor.username,
        donationId,
        amount: parsedAmount,
        eventTag: resolved.value,
        note: cleanNote,
        date: new Date().toISOString(),
      });

      emailPreviewUrl = ack.email.previewUrl;

      if (ack.email.status === 'sent') {
        notices.push(
          ack.email.testMode
            ? `Email logged in test mode for ${donor.email}`
            : `Email sent to ${donor.email}`
        );
      } else if (ack.email.status === 'failed') {
        notices.push('Email failed (check Resend settings)');
      }

      if (ack.sms.status === 'sent') {
        notices.push(
          ack.sms.testMode
            ? `SMS logged in test mode for ${ack.sms.to}`
            : `SMS sent to ${ack.sms.to}`
        );
      } else if (ack.sms.status === 'failed') {
        notices.push('SMS failed (check SMS settings)');
      }
    }

    const statusSuffix = notices.length ? ` (${notices.join(' · ')}.)` : '';

    res.status(201).json({
      message: `Thank you! Test donation of ₹${parsedAmount} (${resolved.value}) recorded.${statusSuffix}`,
      emailPreviewUrl,
      donation: {
        id: donationId,
        username: req.user.username,
        amount: parsedAmount,
        event_tag: resolved.value,
        note: cleanNote,
        is_manual: 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Admin proxy donation (in someone's name) -> stays open for ended events, NO payment, NO email/SMS
app.post('/api/admin/donations', requireAuth, requireLevel(0, 1), (req, res) => {
  const {
    target_user_id,
    custom_donor_name = '',
    amount,
    event_tag = 'General',
    note = '',
  } = req.body || {};

  const parsedAmount = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Please enter a valid amount greater than 0' });
  }

  const resolved = resolveEventTag(event_tag);
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  let linkedUserId = req.user.id;
  let displayName = '';

  if (target_user_id && target_user_id !== 'custom') {
    const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(target_user_id));
    if (!targetUser) return res.status(404).json({ error: 'Selected user not found' });
    linkedUserId = targetUser.id;
    displayName = targetUser.username;
  } else {
    displayName = String(custom_donor_name).trim().slice(0, 80);
    if (!displayName) return res.status(400).json({ error: 'Select a user or enter a donor name' });
  }

  const cleanNote = String(note).trim().slice(0, 150);

  const result = db.prepare(`
    INSERT INTO donations (user_id, amount, event_tag, note, donor_name, is_manual, recorded_by)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(linkedUserId, parsedAmount, resolved.value, cleanNote, displayName, req.user.id);

  db.syncEventFunds();

  res.status(201).json({
    message: `Recorded ₹${parsedAmount} under "${displayName}" (${resolved.value}). Offline entry — no payment required and no email sent.`,
    donation: {
      id: result.lastInsertRowid,
      username: displayName,
      amount: parsedAmount,
      event_tag: resolved.value,
      note: cleanNote,
      is_manual: 1,
    },
  });
});

app.put('/api/donations/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid donation ID' });

  const existing = db.prepare('SELECT * FROM donations WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Donation not found' });

  const { amount, event_tag, note, donor_name } = req.body || {};
  const parsedAmount = amount !== undefined ? Math.round(Number(amount) * 100) / 100 : existing.amount;
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  const resolved = event_tag !== undefined ? resolveEventTag(event_tag) : { valid: true, value: existing.event_tag };
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  const cleanNote = note !== undefined ? String(note).trim().slice(0, 150) : existing.note;
  const cleanDonor = donor_name !== undefined ? String(donor_name).trim().slice(0, 80) : existing.donor_name;

  db.prepare(`
    UPDATE donations SET amount = ?, event_tag = ?, note = ?, donor_name = ? WHERE id = ?
  `).run(parsedAmount, resolved.value, cleanNote, cleanDonor, id);

  db.syncEventFunds();
  res.json({ message: 'Donation updated.' });
});

app.delete('/api/donations/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid donation ID' });

  const info = db.prepare('DELETE FROM donations WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Donation not found' });

  db.syncEventFunds();
  res.json({ message: 'Donation deleted and event funds re-synced.' });
});

app.get('/api/funds', (req, res) => {
  const subtotal = db.prepare(`
    SELECT id, title, total_fund FROM events WHERE LOWER(title) = 'subtotal'
  `).get() || { id: null, title: 'Subtotal', total_fund: 0 };

  const eventFunds = db.prepare(`
    SELECT id, title, event_date, total_fund
    FROM events
    WHERE LOWER(title) != 'subtotal'
    ORDER BY id DESC
  `).all();

  const generalRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM donations
    WHERE LOWER(event_tag) = 'general'
  `).get();

  res.json({
    subtotal,
    general_fund: generalRow.total,
    events: eventFunds,
  });
});

// ==========================================
// EVENT ROUTES
// ==========================================

app.get('/api/events', requireAuth, (req, res) => {
  const subtotal = db.prepare(`
    SELECT id, title, total_fund FROM events WHERE LOWER(title) = 'subtotal'
  `).get() || { id: null, title: 'Subtotal', total_fund: 0 };

  const generalRow = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) AS total
    FROM donations
    WHERE LOWER(event_tag) = 'general'
  `).get();

  const rows = db.prepare(`
    SELECT e.id, e.title, e.event_date, e.content_json, e.total_fund, e.created_at, u.username AS author
    FROM events e
    JOIN users u ON e.created_by = u.id
    WHERE LOWER(e.title) != 'subtotal'
    ORDER BY e.id DESC
  `).all();

  const events = rows.map((row) => ({
    id: row.id,
    title: row.title,
    event_date: row.event_date,
    is_expired: isEventExpired(row.event_date),
    total_fund: row.total_fund,
    author: row.author,
    created_at: row.created_at,
    blocks: JSON.parse(row.content_json),
  }));

  res.json({ count: events.length, subtotal, general_fund: generalRow.total, events });
});

app.post('/api/events', requireAuth, requireLevel(0, 1), (req, res, next) => {
  const { title, event_date = '', blocks } = req.body || {};
  const cleanTitle = String(title || '').trim();

  if (!cleanTitle) return res.status(400).json({ error: 'Event title is required' });
  if (cleanTitle.toLowerCase() === 'subtotal') {
    return res.status(400).json({ error: '"Subtotal" is a reserved system event and cannot be created' });
  }
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return res.status(400).json({ error: 'Add at least one heading, text, or picture block' });
  }

  const savedBlocks = [];
  try {
    for (const block of blocks) {
      if (block.type === 'heading' && String(block.content || '').trim()) {
        savedBlocks.push({ type: 'heading', content: String(block.content).trim() });
      } else if (block.type === 'text' && String(block.content || '').trim()) {
        savedBlocks.push({ type: 'text', content: String(block.content).trim() });
      } else if (block.type === 'image' && block.dataUrl) {
        const imageUrl = saveBase64Image(block.dataUrl);
        savedBlocks.push({
          type: 'image',
          url: imageUrl,
          caption: String(block.caption || '').trim().slice(0, 200),
        });
      }
    }
  } catch (imgErr) {
    if (imgErr.message === 'INVALID_IMAGE') {
      return res.status(400).json({ error: 'Invalid image format (use PNG, JPG, GIF, or WEBP)' });
    }
    return next(imgErr);
  }

  if (savedBlocks.length === 0) return res.status(400).json({ error: 'Article cannot be empty' });

  const result = db.prepare(`
    INSERT INTO events (title, event_date, content_json, total_fund, created_by)
    VALUES (?, ?, ?, 0, ?)
  `).run(cleanTitle, String(event_date).trim(), JSON.stringify(savedBlocks), req.user.id);

  db.syncEventFunds();
  res.status(201).json({ message: 'Event article published!', id: result.lastInsertRowid });
});

app.put('/api/events/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event ID' });

  const existing = db.prepare('SELECT id, title, event_date FROM events WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });
  if (existing.title.toLowerCase() === 'subtotal') {
    return res.status(403).json({ error: 'The "Subtotal" system event cannot be edited' });
  }

  const newTitle = req.body?.title !== undefined ? String(req.body.title).trim() : existing.title;
  const newDate = req.body?.event_date !== undefined ? String(req.body.event_date).trim() : existing.event_date;

  if (!newTitle) return res.status(400).json({ error: 'Event title cannot be empty' });
  if (newTitle.toLowerCase() === 'subtotal') {
    return res.status(400).json({ error: 'Cannot rename an event to "Subtotal"' });
  }

  const updateEvent = db.transaction(() => {
    db.prepare('UPDATE events SET title = ?, event_date = ? WHERE id = ?').run(newTitle, newDate, id);
    if (newTitle !== existing.title) {
      db.prepare('UPDATE donations SET event_tag = ? WHERE event_tag = ?').run(newTitle, existing.title);
      db.prepare('UPDATE expenses SET event_tag = ? WHERE event_tag = ?').run(newTitle, existing.title);
    }
  });

  updateEvent();
  db.syncEventFunds();
  res.json({ message: 'Event updated.' });
});

app.delete('/api/events/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event ID' });

  const existing = db.prepare('SELECT title, content_json FROM events WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });
  if (existing.title.toLowerCase() === 'subtotal') {
    return res.status(403).json({ error: 'The "Subtotal" event cannot be deleted' });
  }

  try {
    const blocks = JSON.parse(existing.content_json);
    for (const b of blocks) {
      if (b.type === 'image' && b.url && b.url.startsWith('/uploads/')) {
        const filePath = path.join(PUBLIC_DIR, b.url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
  } catch {}

  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  db.syncEventFunds();
  res.json({ message: 'Event deleted.' });
});

// ==========================================
// EXPENSE ROUTES (Level 0 & 1)
// ==========================================

app.get('/api/expenses', requireAuth, requireLevel(0, 1), (req, res) => {
  const expenses = db.prepare(`
    SELECT ex.id, ex.amount, ex.event_tag, ex.type_tag, ex.note, ex.created_at, u.username AS recorded_by
    FROM expenses ex
    JOIN users u ON ex.created_by = u.id
    ORDER BY ex.id DESC
  `).all();

  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  res.json({ total, count: expenses.length, expenses });
});

app.post('/api/expenses', requireAuth, requireLevel(0, 1), (req, res) => {
  const { amount, event_tag = 'General', type_tag = '', note = '' } = req.body || {};
  const parsedAmount = Math.round(Number(amount) * 100) / 100;

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Please enter a valid expense amount greater than 0' });
  }

  const resolved = resolveEventTag(event_tag);
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  const cleanType = String(type_tag).trim().slice(0, 60);
  if (!cleanType) return res.status(400).json({ error: 'Expense type tag is required' });

  const cleanNote = String(note).trim().slice(0, 150);

  const result = db.prepare(`
    INSERT INTO expenses (amount, event_tag, type_tag, note, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(parsedAmount, resolved.value, cleanType, cleanNote, req.user.id);

  res.status(201).json({
    message: `Expense of ₹${parsedAmount} (${cleanType} · ${resolved.value}) recorded.`,
    expense: {
      id: result.lastInsertRowid,
      amount: parsedAmount,
      event_tag: resolved.value,
      type_tag: cleanType,
      note: cleanNote,
    },
  });
});

app.put('/api/expenses/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid expense ID' });

  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });

  const { amount, event_tag, type_tag, note } = req.body || {};
  const parsedAmount = amount !== undefined ? Math.round(Number(amount) * 100) / 100 : existing.amount;
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  const resolved = event_tag !== undefined ? resolveEventTag(event_tag) : { valid: true, value: existing.event_tag };
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  const cleanType = type_tag !== undefined ? String(type_tag).trim().slice(0, 60) : existing.type_tag;
  if (!cleanType) return res.status(400).json({ error: 'Expense type tag cannot be empty' });

  const cleanNote = note !== undefined ? String(note).trim().slice(0, 150) : existing.note;

  db.prepare(`
    UPDATE expenses SET amount = ?, event_tag = ?, type_tag = ?, note = ? WHERE id = ?
  `).run(parsedAmount, resolved.value, cleanType, cleanNote, id);

  res.json({ message: 'Expense updated.' });
});

app.delete('/api/expenses/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid expense ID' });

  const info = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Expense not found' });

  res.json({ message: 'Expense deleted.' });
});

// ==========================================
// REPORT ROUTES
// ==========================================

app.get('/api/reports', requireAuth, requireLevel(0, 1, 2), (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.report_type, r.title, r.period_label, r.summary_json, r.created_at, u.username AS generated_by
    FROM reports r
    JOIN users u ON r.generated_by = u.id
    ORDER BY r.id DESC
  `).all();

  const reports = rows.map((r) => ({
    id: r.id,
    report_type: r.report_type,
    title: r.title,
    period_label: r.period_label,
    generated_by: r.generated_by,
    created_at: r.created_at,
    summary: JSON.parse(r.summary_json),
  }));

  res.json({ count: reports.length, reports });
});

app.post('/api/reports/generate', requireAuth, requireLevel(0, 1), (req, res) => {
  const body = req.body || {};
  const spec = buildReportQuery(body);
  if (spec.error) return res.status(400).json({ error: spec.error });

  const donationTotals = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(amount), 0) AS total,
           COALESCE(SUM(CASE WHEN is_manual = 1 THEN amount ELSE 0 END), 0) AS manual_total
    FROM donations
    WHERE ${spec.whereSql}
  `).get(...spec.whereArgs);

  const donationsByCategory = db.prepare(`
    SELECT event_tag AS category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM donations
    WHERE ${spec.whereSql}
    GROUP BY event_tag
    ORDER BY total DESC
  `).all(...spec.whereArgs);

  const expenseWhereAliased = spec.whereSql
    .replace(/\bcreated_at\b/g, 'ex.created_at')
    .replace(/\bevent_tag\b/g, 'ex.event_tag');

  const matchingExpenses = db.prepare(`
    SELECT ex.id, ex.amount, ex.event_tag, ex.type_tag, ex.note, ex.created_at, u.username AS recorded_by
    FROM expenses ex
    JOIN users u ON ex.created_by = u.id
    WHERE ${expenseWhereAliased}
    ORDER BY ex.id DESC
  `).all(...spec.whereArgs);

  const totalExpenses = Math.round(matchingExpenses.reduce((sum, e) => sum + e.amount, 0) * 100) / 100;

  const summary = {
    total_donations: donationTotals.total,
    donation_count: donationTotals.count,
    manual_donations_total: donationTotals.manual_total,
    total_expenses: totalExpenses,
    expense_count: matchingExpenses.length,
    net_balance: Math.round((donationTotals.total - totalExpenses) * 100) / 100,
    donations_by_category: donationsByCategory,
    expenses_by_type: groupExpensesBy(matchingExpenses, 'type_tag'),
    expenses_by_event: groupExpensesBy(matchingExpenses, 'event_tag'),
  };

  const result = db.prepare(`
    INSERT INTO reports (report_type, title, period_label, summary_json, generated_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(body.report_type, spec.title, spec.periodLabel, JSON.stringify(summary), req.user.id);

  res.status(201).json({
    message: `${spec.title} generated! View it on the Reports page.`,
    report_id: result.lastInsertRowid,
    title: spec.title,
    summary,
  });
});

app.delete('/api/reports/:id', requireAuth, requireLevel(0, 1), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report ID' });

  const info = db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'Report not found' });

  res.json({ message: 'Report deleted.' });
});

// ==========================================
// FALLBACKS & ERROR HANDLING
// ==========================================

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found' });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running with Express on http://localhost:${PORT}`);
});