require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { requireAuth, requireLevel, requireAdmin, requireSuper } = require('./auth');
const H = require('./hierarchy');
const { sendDonationAcknowledgement } = require('./mailer');
const { registerFeatureRoutes, isUploadUrl, makeFileRemover, isUrlStillUsed } = require('./features');
const { buildReportPdf } = require('./report-pdf');

if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is missing in your .env file.');
  process.exit(1);
}

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const removeUploadedFile = makeFileRemover(PUBLIC_DIR);

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DYNAMIC_TABLES = ['users', 'houses'];
const RESERVED_COLUMNS = new Set([
  'id', 'login_id', 'username', 'email', 'password', 'password_hash',
  'access_level', 'status', 'house_id', 'house_name', 'house_number',
  'created_by', 'approved_by', 'created_at', 'members', 'member_count',
  'centre_id', 'scope_id', 'centre_name', 'role_label', 'can_manage',
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

// The About page is the landing page for "/" (before the static index.html sign-in page)
app.get(['/', '/about'], (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'about.html'));
});

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

// Event tags are unique per centre: "General" or the title of one of that centre's events
function resolveEventTag(rawTag, centreId, { blockExpired = false } = {}) {
  const cleanTag = String(rawTag || 'General').trim();
  if (!cleanTag || cleanTag.toLowerCase() === 'general') {
    return { valid: true, value: 'General' };
  }
  if (cleanTag.toLowerCase() === 'subtotal') {
    return { valid: false, error: 'Cannot assign "Subtotal" directly as an event tag' };
  }
  const matched = db.prepare(`
    SELECT title, event_date FROM events
    WHERE title = ? AND centre_id IS ? AND LOWER(title) != 'subtotal'
  `).get(cleanTag, centreId ?? null);
  if (!matched) {
    return { valid: false, error: `"${cleanTag}" is not an event of this centre` };
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
    // Centre filtering is added by the caller (each event belongs to one centre)
    const tag = String(params.event_title || event_tag || 'General').trim() || 'General';
    return {
      title: `Event Report — ${tag}`,
      periodLabel: `Event: ${tag}`,
      whereSql: 'event_tag = ?',
      whereArgs: [tag],
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

  // Only people (users) columns appear on the sign-up form, so only they can be mandatory
  const isRequired = table === 'users' && Boolean(req.body?.is_required) ? 1 : 0;

  db.exec(`ALTER TABLE ${table} ADD COLUMN "${colName}" ${typeDef.sqlType}`);
  db.prepare(`
    INSERT INTO custom_columns (table_name, column_name, display_label, data_type, options_json, is_required, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(table, colName, displayLabel, dataType, JSON.stringify(cleanOptions), isRequired, req.user.id);

  H.logAction(req, 'schema.add_column', {
    targetType: 'column', summary: `Added ${typeDef.label} column "${displayLabel}" to ${table}`,
    details: { table, column: colName, data_type: dataType, options: cleanOptions, mandatory_at_signup: Boolean(isRequired) },
  });

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

// Super Admin: switch "mandatory at sign-up" on or off for an existing people column
app.patch('/api/schema/users/columns/:columnName', requireAuth, requireSuper, (req, res) => {
  const col = db.getCustomColumns('users').find((c) => c.column_name === req.params.columnName);
  if (!col) return res.status(404).json({ error: 'Column not found' });
  const isRequired = req.body && req.body.is_required ? 1 : 0;
  db.prepare("UPDATE custom_columns SET is_required = ? WHERE table_name = 'users' AND column_name = ?")
    .run(isRequired, col.column_name);
  H.logAction(req, 'schema.update_column', {
    targetType: 'column',
    summary: `Made "${col.display_label}" ${isRequired ? 'mandatory' : 'optional'} at sign-up`,
    details: { table: 'users', column: col.column_name, mandatory_at_signup: Boolean(isRequired) },
  });
  res.json({ message: `"${col.display_label}" is now ${isRequired ? 'mandatory' : 'optional'} when signing up.` });
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
    H.logAction(req, 'schema.remove_column', {
      targetType: 'column', summary: `Removed column "${registered.display_label}" from ${table} (its data was deleted)`,
      details: { table, column: colName },
    });
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

function centreSummary(centreId) {
  const c = H.getCentre(centreId);
  return c ? { id: c.id, name: c.name, zone_name: c.zone_name, region_name: c.region_name } : null;
}

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
    centre_id: user.centre_id,
    scope_id: user.scope_id,
    role_label: H.roleLabel(user.access_level, user.scope_id),
    centre: centreSummary(user.centre_id),
  });
});

// Current account (role, home centre, admin area)
app.get('/api/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    id: u.id,
    login_id: u.login_id,
    username: u.username,
    access_level: u.access_level,
    is_admin: H.isAdmin(u),
    is_super: H.isSuper(u),
    centre_id: u.centre_id,
    scope_id: u.scope_id,
    role_label: H.roleLabel(u.access_level, u.scope_id),
    centre: centreSummary(u.centre_id),
  });
});

app.post('/api/signup', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const centre = H.getCentre(body.centre_id);

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are all mandatory' });
  }

  if (!centre) {
    return res.status(400).json({ error: 'Please choose your centre' });
  }

  const customCols = db.getCustomColumns('users');
  const customFieldsInput = body.custom_fields || {};
  const colNames = ['login_id', 'username', 'email', 'password_hash', 'access_level', 'status', 'centre_id', 'created_by', 'approved_by'];
  const loginId = db.getNextLoginId();
  // Public sign-ups are always ordinary users; admins promote accounts afterwards
  const values = [loginId, username, email, bcrypt.hashSync(password, 10), 4, 'pending', centre.id, null, null];

  for (const col of customCols) {
    const rawVal = customFieldsInput[col.column_name] ?? body[col.column_name];
    const check = validateCustomValue(col, rawVal, col.is_required);
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
      message: `Account submitted! Your Unique Login ID Number is ${loginId}. An admin of ${centre.name} will approve it.`,
      login_id: loginId,
      user: {
        id: result.lastInsertRowid,
        login_id: loginId,
        username,
        email,
        access_level: 4,
        status: 'pending',
        centre_id: centre.id,
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
// CENTRES HIERARCHY (Regions -> Zones -> Centres)
// ==========================================

// Public list of centres (for sign-up and the public Funds page)
app.get('/api/centres/public', (req, res) => {
  const centres = db.prepare(`
    SELECT c.id, c.name, z.name AS zone_name, r.name AS region_name
    FROM centres c JOIN zones z ON z.id = c.zone_id JOIN regions r ON r.id = z.region_id
    ORDER BY r.name COLLATE NOCASE, z.name COLLATE NOCASE, c.name COLLATE NOCASE
  `).all();
  res.json({ centres });
});

// Full tree with what the current account may manage
app.get('/api/hierarchy', requireAuth, (req, res) => {
  const me = req.user;
  const regions = db.prepare('SELECT id, name, created_at FROM regions ORDER BY name COLLATE NOCASE').all();
  const zones = db.prepare('SELECT id, region_id, name, created_at FROM zones ORDER BY name COLLATE NOCASE').all();
  const centres = db.prepare(`
    SELECT c.id, c.zone_id, c.name, c.code, c.address, c.major_donation_min, c.created_at,
      (SELECT COUNT(*) FROM users u WHERE u.centre_id = c.id) AS member_count,
      (SELECT COUNT(*) FROM houses h WHERE h.centre_id = c.id) AS house_count,
      (SELECT COUNT(*) FROM events e WHERE e.centre_id = c.id) AS event_count,
      (SELECT COALESCE(SUM(d.amount), 0) FROM donations d WHERE d.centre_id = c.id) AS donation_total
    FROM centres c ORDER BY c.name COLLATE NOCASE
  `).all();
  const admins = db.prepare(`
    SELECT id, login_id, username, access_level, scope_id FROM users
    WHERE access_level IN (1, 2, 3) AND status = 'approved' ORDER BY username COLLATE NOCASE
  `).all();

  const adminsFor = (level, id) => admins
    .filter((a) => a.access_level === level && a.scope_id === id)
    .map((a) => ({ id: a.id, login_id: a.login_id, username: a.username }));

  const managedCentres = H.adminCentreIds(me);
  const managedSet = managedCentres === null ? null : new Set(managedCentres);

  const tree = regions.map((r) => ({
    ...r,
    can_manage: H.canManageScope(me, 'region', r.id),
    can_edit: H.isSuper(me),
    admins: adminsFor(1, r.id),
    zones: zones.filter((z) => z.region_id === r.id).map((z) => ({
      ...z,
      can_manage: H.canManageScope(me, 'zone', z.id),
      can_edit: H.canManageScope(me, 'region', r.id),
      admins: adminsFor(2, z.id),
      centres: centres.filter((c) => c.zone_id === z.id).map((c) => ({
        ...c,
        can_manage: managedSet === null ? H.isSuper(me) : managedSet.has(c.id),
        can_edit_details: managedSet === null ? H.isSuper(me) : managedSet.has(c.id),
        can_move_or_delete: H.canManageScope(me, 'zone', z.id),
        admins: adminsFor(3, c.id),
      })),
    })),
  }));

  // Flat list of centres the account manages (for dropdowns)
  const flat = [];
  for (const r of tree) for (const z of r.zones) for (const c of z.centres) {
    flat.push({ id: c.id, name: c.name, zone_id: z.id, zone_name: z.name, region_id: r.id, region_name: r.name, can_manage: c.can_manage });
  }

  res.json({
    me: {
      id: me.id,
      access_level: me.access_level,
      is_super: H.isSuper(me),
      is_admin: H.isAdmin(me),
      centre_id: me.centre_id,
      scope_id: me.scope_id,
      role_label: H.roleLabel(me.access_level, me.scope_id),
    },
    regions: tree,
    centres: flat,
    managed_centre_ids: managedCentres === null ? flat.map((c) => c.id) : managedCentres,
  });
});

// Amount >= 0 (rounded to paise); `fallback` when not given; null when invalid
function parseLimit(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const num = Math.round(Number(raw) * 100) / 100;
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function cleanName(raw, max = 80) {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

app.post('/api/regions', requireAuth, requireSuper, (req, res) => {
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Region name is required' });
  try {
    const id = db.prepare('INSERT INTO regions (name) VALUES (?)').run(name).lastInsertRowid;
    H.logAction(req, 'region.create', { targetType: 'region', targetId: id, summary: `Created region "${name}"` });
    res.status(201).json({ message: `Region "${name}" created.`, id });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'A region with that name already exists' });
    throw err;
  }
});

app.put('/api/regions/:id', requireAuth, requireSuper, (req, res) => {
  const region = H.getRegion(req.params.id);
  if (!region) return res.status(404).json({ error: 'Region not found' });
  const name = cleanName(req.body && req.body.name);
  if (!name) return res.status(400).json({ error: 'Region name is required' });
  try {
    db.prepare('UPDATE regions SET name = ? WHERE id = ?').run(name, region.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'A region with that name already exists' });
    throw err;
  }
  H.logAction(req, 'region.update', {
    targetType: 'region', targetId: region.id,
    summary: `Renamed region "${region.name}" to "${name}"`, details: { before: region.name, after: name },
  });
  res.json({ message: 'Region updated.' });
});

app.delete('/api/regions/:id', requireAuth, requireSuper, (req, res) => {
  const region = H.getRegion(req.params.id);
  if (!region) return res.status(404).json({ error: 'Region not found' });
  if (db.prepare('SELECT 1 FROM zones WHERE region_id = ? LIMIT 1').get(region.id)) {
    return res.status(400).json({ error: 'Remove or move this region’s zones first.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE access_level = 1 AND scope_id = ? LIMIT 1').get(region.id)) {
    return res.status(400).json({ error: 'Reassign this region’s Region Admins first.' });
  }
  db.prepare('DELETE FROM regions WHERE id = ?').run(region.id);
  H.logAction(req, 'region.delete', { targetType: 'region', targetId: region.id, summary: `Deleted region "${region.name}"` });
  res.json({ message: 'Region deleted.' });
});

app.post('/api/zones', requireAuth, requireAdmin, (req, res) => {
  const region = H.getRegion(req.body && req.body.region_id);
  const name = cleanName(req.body && req.body.name);
  if (!region) return res.status(400).json({ error: 'Choose a region' });
  if (!name) return res.status(400).json({ error: 'Zone name is required' });
  if (!H.canManageScope(req.user, 'region', region.id)) {
    return res.status(403).json({ error: 'You can only add zones to your own region.' });
  }
  try {
    const id = db.prepare('INSERT INTO zones (region_id, name) VALUES (?, ?)').run(region.id, name).lastInsertRowid;
    H.logAction(req, 'zone.create', { targetType: 'zone', targetId: id, summary: `Created zone "${name}" in ${region.name}` });
    res.status(201).json({ message: `Zone "${name}" created.`, id });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That region already has a zone with this name' });
    throw err;
  }
});

app.put('/api/zones/:id', requireAuth, requireAdmin, (req, res) => {
  const zone = H.getZone(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  if (!H.canManageScope(req.user, 'region', zone.region_id)) {
    return res.status(403).json({ error: 'Only an admin of this zone’s region can edit it.' });
  }
  const name = req.body && req.body.name !== undefined ? cleanName(req.body.name) : zone.name;
  if (!name) return res.status(400).json({ error: 'Zone name is required' });
  let regionId = zone.region_id;
  if (req.body && req.body.region_id !== undefined && Number(req.body.region_id) !== zone.region_id) {
    const target = H.getRegion(req.body.region_id);
    if (!target) return res.status(400).json({ error: 'Region not found' });
    if (!H.canManageScope(req.user, 'region', target.id)) {
      return res.status(403).json({ error: 'You cannot move a zone into that region.' });
    }
    regionId = target.id;
  }
  try {
    db.prepare('UPDATE zones SET name = ?, region_id = ? WHERE id = ?').run(name, regionId, zone.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That region already has a zone with this name' });
    throw err;
  }
  H.logAction(req, 'zone.update', {
    targetType: 'zone', targetId: zone.id, summary: `Updated zone "${zone.name}"`,
    details: { before: { name: zone.name, region_id: zone.region_id }, after: { name, region_id: regionId } },
  });
  res.json({ message: 'Zone updated.' });
});

app.delete('/api/zones/:id', requireAuth, requireAdmin, (req, res) => {
  const zone = H.getZone(req.params.id);
  if (!zone) return res.status(404).json({ error: 'Zone not found' });
  if (!H.canManageScope(req.user, 'region', zone.region_id)) {
    return res.status(403).json({ error: 'Only an admin of this zone’s region can delete it.' });
  }
  if (db.prepare('SELECT 1 FROM centres WHERE zone_id = ? LIMIT 1').get(zone.id)) {
    return res.status(400).json({ error: 'Remove or move this zone’s centres first.' });
  }
  if (db.prepare('SELECT 1 FROM users WHERE access_level = 2 AND scope_id = ? LIMIT 1').get(zone.id)) {
    return res.status(400).json({ error: 'Reassign this zone’s Zone Admins first.' });
  }
  db.prepare('DELETE FROM zones WHERE id = ?').run(zone.id);
  H.logAction(req, 'zone.delete', { targetType: 'zone', targetId: zone.id, summary: `Deleted zone "${zone.name}" (${zone.region_name})` });
  res.json({ message: 'Zone deleted.' });
});

app.post('/api/centres', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const zone = H.getZone(body.zone_id);
  const name = cleanName(body.name);
  if (!zone) return res.status(400).json({ error: 'Choose a zone' });
  if (!name) return res.status(400).json({ error: 'Centre name is required' });
  if (!H.canManageScope(req.user, 'zone', zone.id)) {
    return res.status(403).json({ error: 'You can only add centres inside your own zone or region.' });
  }
  try {
    const limit = parseLimit(body.major_donation_min, 10000);
    if (limit === null) return res.status(400).json({ error: 'Major-donation limit must be 0 or more' });
    const id = db.prepare('INSERT INTO centres (zone_id, name, code, address, major_donation_min) VALUES (?, ?, ?, ?, ?)')
      .run(zone.id, name, cleanName(body.code, 30), cleanName(body.address, 200), limit).lastInsertRowid;
    H.logAction(req, 'centre.create', {
      targetType: 'centre', targetId: id, centreId: id, summary: `Created centre "${name}" in ${zone.name}`,
    });
    res.status(201).json({ message: `Centre "${name}" created.`, id });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That zone already has a centre with this name' });
    throw err;
  }
});

app.put('/api/centres/:id', requireAuth, requireAdmin, (req, res) => {
  const centre = H.getCentre(req.params.id);
  if (!centre) return res.status(404).json({ error: 'Centre not found' });
  if (!H.canManageCentre(req.user, centre.id)) {
    return res.status(403).json({ error: 'This centre is outside your jurisdiction.' });
  }
  const body = req.body || {};
  const name = body.name !== undefined ? cleanName(body.name) : centre.name;
  if (!name) return res.status(400).json({ error: 'Centre name is required' });
  const code = body.code !== undefined ? cleanName(body.code, 30) : centre.code;
  const address = body.address !== undefined ? cleanName(body.address, 200) : centre.address;
  const currentLimit = db.prepare('SELECT major_donation_min FROM centres WHERE id = ?').get(centre.id).major_donation_min;
  const majorMin = parseLimit(body.major_donation_min, currentLimit);
  if (majorMin === null) return res.status(400).json({ error: 'Major-donation limit must be 0 or more' });

  let zoneId = centre.zone_id;
  if (body.zone_id !== undefined && Number(body.zone_id) !== centre.zone_id) {
    const target = H.getZone(body.zone_id);
    if (!target) return res.status(400).json({ error: 'Zone not found' });
    if (!H.canManageScope(req.user, 'zone', centre.zone_id) || !H.canManageScope(req.user, 'zone', target.id)) {
      return res.status(403).json({ error: 'Moving a centre needs authority over both zones.' });
    }
    zoneId = target.id;
  }

  try {
    db.prepare('UPDATE centres SET name = ?, code = ?, address = ?, zone_id = ?, major_donation_min = ? WHERE id = ?')
      .run(name, code, address, zoneId, majorMin, centre.id);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'That zone already has a centre with this name' });
    throw err;
  }
  H.logAction(req, 'centre.update', {
    targetType: 'centre', targetId: centre.id, centreId: centre.id, summary: `Updated centre "${centre.name}"`,
    details: {
      before: { name: centre.name, code: centre.code, address: centre.address, zone_id: centre.zone_id, major_donation_min: currentLimit },
      after: { name, code, address, zone_id: zoneId, major_donation_min: majorMin },
    },
  });
  res.json({ message: 'Centre updated.' });
});

app.delete('/api/centres/:id', requireAuth, requireAdmin, (req, res) => {
  const centre = H.getCentre(req.params.id);
  if (!centre) return res.status(404).json({ error: 'Centre not found' });
  if (!H.canManageScope(req.user, 'zone', centre.zone_id)) {
    return res.status(403).json({ error: 'Only a zone, region or super admin can delete centres.' });
  }
  const inUse = [
    ['users', 'SELECT 1 FROM users WHERE centre_id = ? OR (access_level = 3 AND scope_id = ?) LIMIT 1', [centre.id, centre.id]],
    ['houses', 'SELECT 1 FROM houses WHERE centre_id = ? LIMIT 1', [centre.id]],
    ['donations', 'SELECT 1 FROM donations WHERE centre_id = ? LIMIT 1', [centre.id]],
    ['events', 'SELECT 1 FROM events WHERE centre_id = ? LIMIT 1', [centre.id]],
    ['expenses', 'SELECT 1 FROM expenses WHERE centre_id = ? LIMIT 1', [centre.id]],
  ].filter(([, sql, args]) => db.prepare(sql).get(...args)).map(([what]) => what);
  if (inUse.length) {
    return res.status(400).json({ error: `This centre still has ${inUse.join(', ')}. Move or remove them first.` });
  }
  db.prepare('DELETE FROM centres WHERE id = ?').run(centre.id);
  H.logAction(req, 'centre.delete', {
    targetType: 'centre', targetId: centre.id, centreId: centre.id, summary: `Deleted centre "${centre.name}" (${centre.zone_name})`,
  });
  res.json({ message: 'Centre deleted.' });
});

// ==========================================
// USER MANAGEMENT ROUTES (admins, within their jurisdiction — NO PASSWORD ACCESS)
// ==========================================

// Memoised permission checks for one request
function userGate(actor) {
  const ids = H.adminCentreIds(actor);
  const set = ids === null ? null : new Set(ids);
  const memo = new Map();
  return {
    inScope: (centreId) => (set === null ? true : set.has(Number(centreId))),
    canManage: (target) => {
      const key = `${target.id}:${target.access_level}:${target.scope_id}:${target.centre_id}`;
      if (!memo.has(key)) memo.set(key, H.canManageUser(actor, target));
      return memo.get(key);
    },
  };
}

function centreNameMap() {
  const map = new Map();
  for (const c of db.prepare(`
    SELECT c.id, c.name, z.name AS zone_name, r.name AS region_name
    FROM centres c JOIN zones z ON z.id = c.zone_id JOIN regions r ON r.id = z.region_id
  `).all()) map.set(c.id, c);
  return map;
}

function superAdminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE access_level = 0 AND status = 'approved'").get().n;
}

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
  const safeCols = db.getSafeTableColumns('users');
  const selectSql = safeCols.map((c) => `u."${c}"`).join(', ');
  const customCols = db.getCustomColumns('users');
  const gate = userGate(req.user);
  const centres = centreNameMap();

  const all = db.prepare(`
    SELECT ${selectSql}, h.house_name
    FROM users u
    LEFT JOIN houses h ON u.house_id = h.id
    ORDER BY u.id ASC
  `).all();

  // Database Control: only accounts under this admin's jurisdiction
  const users = all
    .filter((u) => u.id !== req.user.id && gate.canManage(u))
    .map((u) => {
      for (const c of customCols) {
        if (u[c.column_name] === undefined) u[c.column_name] = c.data_type === 'number' ? null : '';
      }
      const c = centres.get(u.centre_id);
      return {
        ...u,
        centre_name: c ? c.name : '',
        role_label: H.roleLabel(u.access_level, u.scope_id),
        can_manage: true,
      };
    });

  res.json({ count: users.length, custom_columns: customCols, users });
});

// Light list of everyone whose home centre is in this admin's area (to pick a donor for an offline donation)
app.get('/api/users/donors', requireAuth, requireAdmin, (req, res) => {
  const scope = H.scopeSql(req.user, 'centre_id');
  const users = db.prepare(`
    SELECT id, login_id, username, email, centre_id FROM users
    WHERE status = 'approved' AND ${scope.sql}
    ORDER BY username COLLATE NOCASE
  `).all(...scope.args);
  res.json({ users });
});

// Validate role / scope / centre / house for a new or edited account
function resolveAccountPlacement(actor, { level, scopeId, centreId, houseId, checkRole = true }) {
  const lvl = Number(level);
  if (![0, 1, 2, 3, 4].includes(lvl)) return { error: 'Choose a valid role' };

  let scope = null;
  if ([1, 2, 3].includes(lvl)) {
    scope = Number(scopeId);
    const exists =
      (lvl === 1 && H.getRegion(scope)) || (lvl === 2 && H.getZone(scope)) || (lvl === 3 && H.getCentre(scope));
    if (!Number.isInteger(scope) || !exists) {
      return { error: `Choose which ${H.SCOPE_TYPE_FOR_LEVEL[lvl]} this ${H.LEVEL_NAMES[lvl]} looks after` };
    }
  }
  if (checkRole && !H.canAssignRole(actor, lvl, scope)) {
    return { error: 'You can only give roles below your own, inside your own area.', status: 403 };
  }

  let house = null;
  let centre = null;
  if (houseId !== null && houseId !== undefined && houseId !== '') {
    house = db.prepare('SELECT id, house_name, centre_id FROM houses WHERE id = ?').get(Number(houseId));
    if (!house) return { error: 'Selected house does not exist' };
    if (!H.canManageCentre(actor, house.centre_id)) {
      return { error: 'That house is outside your jurisdiction.', status: 403 };
    }
    centre = H.getCentre(house.centre_id);
  } else if (centreId !== null && centreId !== undefined && centreId !== '') {
    centre = H.getCentre(centreId);
    if (!centre) return { error: 'Selected centre does not exist' };
    if (!H.canManageCentre(actor, centre.id)) {
      return { error: 'That centre is outside your jurisdiction.', status: 403 };
    }
  }

  if (!centre && lvl !== 0) return { error: 'Choose the centre this person belongs to' };

  return { level: lvl, scopeId: scope, centreId: centre ? centre.id : null, houseId: house ? house.id : null };
}

app.post('/api/users', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password are required' });
  }

  const level = body.access_level ?? 4;
  const placement = resolveAccountPlacement(req.user, {
    level,
    scopeId: body.scope_id,
    centreId: body.centre_id ?? (Number(level) === 3 ? body.scope_id : H.defaultCentreFor(req.user)),
    houseId: body.house_id,
  });
  if (placement.error) return res.status(placement.status || 400).json({ error: placement.error });

  const customCols = db.getCustomColumns('users');
  const customFieldsInput = body.custom_fields || {};
  const loginId = db.getNextLoginId();

  const colNames = ['login_id', 'username', 'email', 'password_hash', 'access_level', 'status', 'house_id', 'centre_id', 'scope_id', 'created_by', 'approved_by'];
  const values = [
    loginId, username, email, bcrypt.hashSync(password, 10), placement.level, 'approved',
    placement.houseId, placement.centreId, placement.scopeId, req.user.id, req.user.id,
  ];

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

    const roleLabel = H.roleLabel(placement.level, placement.scopeId);
    H.logAction(req, 'user.create', {
      targetType: 'user', targetId: result.lastInsertRowid, centreId: placement.centreId,
      summary: `Created account #${loginId} "${username}" as ${roleLabel}`,
      details: { login_id: loginId, username, email, role: roleLabel, centre_id: placement.centreId, house_id: placement.houseId },
    });

    res.status(201).json({
      message: `Account created! Unique Login ID: ${loginId}`,
      login_id: loginId,
      user: {
        id: result.lastInsertRowid,
        login_id: loginId,
        username,
        email,
        access_level: placement.level,
        status: 'approved',
        house_id: placement.houseId,
        centre_id: placement.centreId,
        scope_id: placement.scopeId,
      },
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });

  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'User not found' });

  if (!H.canManageUser(req.user, existing)) {
    return res.status(403).json({ error: 'This account is above your level or outside your jurisdiction.' });
  }

  const body = req.body || {};
  const updates = [];
  const params = [];
  const changes = {};
  const track = (field, before, after) => {
    if (String(before ?? '') !== String(after ?? '')) changes[field] = { before, after };
  };

  if (body.username !== undefined) {
    const clean = String(body.username).trim();
    if (!clean) return res.status(400).json({ error: 'Username cannot be empty' });
    updates.push('username = ?');
    params.push(clean);
    track('username', existing.username, clean);
  }

  if (body.email !== undefined) {
    const clean = String(body.email).trim();
    if (!clean) return res.status(400).json({ error: 'Email cannot be empty' });
    updates.push('email = ?');
    params.push(clean);
    track('email', existing.email, clean);
  }

  // Role, area, centre and house are validated together
  const placementTouched = ['access_level', 'scope_id', 'centre_id', 'house_id'].some((k) => body[k] !== undefined);
  if (placementTouched) {
    const newLevel = body.access_level !== undefined ? Number(body.access_level) : existing.access_level;
    let newScope = body.scope_id !== undefined ? body.scope_id : existing.scope_id;
    if (newLevel === 0 || newLevel === 4) newScope = null;
    const houseInput = body.house_id !== undefined ? body.house_id : existing.house_id;
    const centreInput = body.centre_id !== undefined ? body.centre_id : existing.centre_id;

    // Moving to a different centre drops a house that belongs elsewhere
    let houseId = houseInput;
    if (body.centre_id !== undefined && body.house_id === undefined && existing.house_id) {
      const h = db.prepare('SELECT centre_id FROM houses WHERE id = ?').get(existing.house_id);
      if (h && Number(h.centre_id) !== Number(body.centre_id)) houseId = null;
    }

    const roleChanged = newLevel !== existing.access_level || String(newScope ?? '') !== String(existing.scope_id ?? '');
    if (existing.access_level === 0 && newLevel !== 0 && superAdminCount() <= 1) {
      return res.status(400).json({ error: 'This is the last Super Admin — promote someone else first.' });
    }

    const placement = resolveAccountPlacement(req.user, {
      level: newLevel, scopeId: newScope, centreId: centreInput, houseId, checkRole: roleChanged,
    });
    if (placement.error) return res.status(placement.status || 400).json({ error: placement.error });

    const finalScope = roleChanged ? placement.scopeId : existing.scope_id;
    updates.push('access_level = ?', 'scope_id = ?', 'centre_id = ?', 'house_id = ?');
    params.push(newLevel, finalScope, placement.centreId, placement.houseId);
    track('role', H.roleLabel(existing.access_level, existing.scope_id), H.roleLabel(newLevel, finalScope));
    track('centre_id', existing.centre_id, placement.centreId);
    track('house_id', existing.house_id, placement.houseId);
  }

  if (body.status !== undefined) {
    if (!['pending', 'approved', 'rejected'].includes(body.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updates.push('status = ?');
    params.push(body.status);
    track('status', existing.status, body.status);
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
      track(col.display_label, existing[col.column_name], check.value);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  try {
    params.push(id);
    db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (Object.keys(changes).length) {
      H.logAction(req, 'user.update', {
        targetType: 'user', targetId: id, centreId: existing.centre_id,
        summary: `Edited account #${existing.login_id} "${existing.username}" (${Object.keys(changes).join(', ')})`,
        details: changes,
      });
    }
    res.json({ message: 'User updated (passwords remain protected).' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Username or email already exists' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own active account' });

  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  if (!H.canManageUser(req.user, target)) {
    return res.status(403).json({ error: 'This account is above your level or outside your jurisdiction.' });
  }
  if (target.access_level === 0 && superAdminCount() <= 1) {
    return res.status(400).json({ error: 'You cannot delete the last Super Admin.' });
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
  H.logAction(req, 'user.delete', {
    targetType: 'user', targetId: id, centreId: target.centre_id,
    summary: `Deleted account #${target.login_id} "${target.username}" (${H.roleLabel(target.access_level, target.scope_id)})`,
    details: { login_id: target.login_id, username: target.username, email: target.email },
  });
  res.json({ message: `User "${target.username}" deleted.` });
});

app.patch('/api/users/:id/decision', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });

  const { decision } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approved" or "rejected"' });
  }

  const targetUser = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!targetUser) return res.status(404).json({ error: 'User not found' });
  if (!H.canManageUser(req.user, targetUser)) {
    return res.status(403).json({ error: 'This sign-up belongs to a centre outside your jurisdiction.' });
  }
  if (targetUser.status !== 'pending') {
    return res.status(400).json({ error: `User is already ${targetUser.status}` });
  }

  db.prepare('UPDATE users SET status = ?, approved_by = ? WHERE id = ?')
    .run(decision, req.user.id, id);

  H.logAction(req, decision === 'approved' ? 'user.approve' : 'user.reject', {
    targetType: 'user', targetId: id, centreId: targetUser.centre_id,
    summary: `${decision === 'approved' ? 'Approved' : 'Rejected'} sign-up #${targetUser.login_id} "${targetUser.username}"`,
  });

  res.json({
    message: `User ${id} has been ${decision}.`,
    approved_by: req.user.id,
  });
});

// ==========================================
// HOUSES DATABASE ROUTES (admins, within their centres — Unique by House Code)
// ==========================================

app.get('/api/houses/check-code', requireAuth, requireAdmin, (req, res) => {
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

app.get('/api/houses', requireAuth, requireAdmin, (req, res) => {
  const customCols = db.getCustomColumns('houses');
  const scope = H.scopeSql(req.user, 'centre_id');
  const houses = db.prepare(`SELECT * FROM houses WHERE ${scope.sql} ORDER BY id ASC`).all(...scope.args);
  const allMembers = db.prepare(`
    SELECT id, login_id, username, email, access_level, house_id
    FROM users
    WHERE house_id IS NOT NULL
    ORDER BY username ASC
  `).all();
  const centres = centreNameMap();

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
    const c = centres.get(h.centre_id);
    return { ...h, centre_name: c ? c.name : '', member_count: members.length, members };
  });

  res.json({ count: enriched.length, custom_columns: customCols, houses: enriched });
});

app.post('/api/houses', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const houseName = String(body.house_name || '').trim();
  const houseNumber = String(body.house_number || '').trim();
  const centreId = body.centre_id ?? H.defaultCentreFor(req.user);
  const centre = H.getCentre(centreId);

  if (!houseName) {
    return res.status(400).json({ error: 'House name is required' });
  }

  if (!houseNumber) {
    return res.status(400).json({ error: 'House code is required' });
  }

  if (!centre) return res.status(400).json({ error: 'Choose the centre this house belongs to' });
  if (!H.canManageCentre(req.user, centre.id)) {
    return res.status(403).json({ error: 'That centre is outside your jurisdiction.' });
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
  const colNames = ['house_name', 'house_number', 'centre_id'];
  const values = [houseName, houseNumber, centre.id];

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

    H.logAction(req, 'house.create', {
      targetType: 'house', targetId: result.lastInsertRowid, centreId: centre.id,
      summary: `Created house "${houseName}" (${houseNumber}) in ${centre.name}`,
    });

    res.status(201).json({
      message: `House "${houseName}" (${houseNumber}) created in ${centre.name}.`,
      id: result.lastInsertRowid,
    });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: `House code "${houseNumber}" is already taken.` });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.put('/api/houses/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid house ID' });

  const existing = db.prepare('SELECT * FROM houses WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'House not found' });
  if (!H.canManageCentre(req.user, existing.centre_id)) {
    return res.status(403).json({ error: 'This house is outside your jurisdiction.' });
  }

  const body = req.body || {};
  const updates = [];
  const params = [];
  const changes = {};
  let movedTo = null;

  if (body.house_name !== undefined) {
    const clean = String(body.house_name).trim();
    if (!clean) return res.status(400).json({ error: 'House name cannot be empty' });
    updates.push('house_name = ?');
    params.push(clean);
    if (clean !== existing.house_name) changes.house_name = { before: existing.house_name, after: clean };
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
    if (cleanCode !== existing.house_number) changes.house_number = { before: existing.house_number, after: cleanCode };
  }

  if (body.centre_id !== undefined && Number(body.centre_id) !== Number(existing.centre_id)) {
    const centre = H.getCentre(body.centre_id);
    if (!centre) return res.status(400).json({ error: 'Centre not found' });
    if (!H.canManageCentre(req.user, centre.id)) {
      return res.status(403).json({ error: 'You cannot move a house to a centre outside your jurisdiction.' });
    }
    updates.push('centre_id = ?');
    params.push(centre.id);
    movedTo = centre;
    changes.centre_id = { before: existing.centre_id, after: centre.id };
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
      if (String(existing[col.column_name] ?? '') !== String(check.value ?? '')) {
        changes[col.display_label] = { before: existing[col.column_name], after: check.value };
      }
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  try {
    params.push(id);
    db.transaction(() => {
      db.prepare(`UPDATE houses SET ${updates.join(', ')} WHERE id = ?`).run(...params);
      // Members move with their house
      if (movedTo) db.prepare('UPDATE users SET centre_id = ? WHERE house_id = ?').run(movedTo.id, id);
    })();
    if (Object.keys(changes).length) {
      H.logAction(req, 'house.update', {
        targetType: 'house', targetId: id, centreId: movedTo ? movedTo.id : existing.centre_id,
        summary: `Edited house "${existing.house_name}" (${Object.keys(changes).join(', ')})`,
        details: changes,
      });
    }
    res.json({ message: movedTo ? `House updated and moved to ${movedTo.name} with its members.` : 'House updated.' });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'That house code is already taken.' });
    }
    res.status(500).json({ error: 'Database error' });
  }
});

app.delete('/api/houses/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid house ID' });

  const house = db.prepare('SELECT * FROM houses WHERE id = ?').get(id);
  if (!house) return res.status(404).json({ error: 'House not found' });
  if (!H.canManageCentre(req.user, house.centre_id)) {
    return res.status(403).json({ error: 'This house is outside your jurisdiction.' });
  }

  db.prepare('UPDATE users SET house_id = NULL WHERE house_id = ?').run(id);
  db.prepare('DELETE FROM houses WHERE id = ?').run(id);

  H.logAction(req, 'house.delete', {
    targetType: 'house', targetId: id, centreId: house.centre_id,
    summary: `Deleted house "${house.house_name}" (${house.house_number})`,
  });

  res.json({ message: 'House deleted and members unassigned.' });
});

app.patch('/api/houses/assign-member', requireAuth, requireAdmin, (req, res) => {
  const { user_id, house_id } = req.body || {};
  const uId = Number(user_id);
  if (!Number.isInteger(uId)) return res.status(400).json({ error: 'Valid user_id is required' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(uId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const gate = userGate(req.user);
  const mayMove = H.isSuper(req.user) || user.id === req.user.id || gate.canManage(user) ||
    user.centre_id === null || gate.inScope(user.centre_id);
  if (!mayMove) {
    return res.status(403).json({ error: 'This person belongs to a centre outside your jurisdiction.' });
  }

  if (house_id === null || house_id === '' || house_id === undefined) {
    db.prepare('UPDATE users SET house_id = NULL WHERE id = ?').run(uId);
    H.logAction(req, 'house.unassign_member', {
      targetType: 'user', targetId: uId, centreId: user.centre_id,
      summary: `Removed ${user.username} from their house`,
    });
    return res.json({ message: `${user.username} removed from house.` });
  }

  const hId = Number(house_id);
  const house = db.prepare('SELECT id, house_name, centre_id FROM houses WHERE id = ?').get(hId);
  if (!house) return res.status(404).json({ error: 'House not found' });
  if (!H.canManageCentre(req.user, house.centre_id)) {
    return res.status(403).json({ error: 'That house is outside your jurisdiction.' });
  }

  // A family belongs to one centre, so its members do too
  db.prepare('UPDATE users SET house_id = ?, centre_id = ? WHERE id = ?').run(hId, house.centre_id, uId);
  H.logAction(req, 'house.assign_member', {
    targetType: 'user', targetId: uId, centreId: house.centre_id,
    summary: `Assigned ${user.username} to house "${house.house_name}"`,
    details: { house_id: hId, previous_centre_id: user.centre_id, centre_id: house.centre_id },
  });
  res.json({ message: `${user.username} assigned to "${house.house_name}".` });
});

// ==========================================
// DONATION, ANALYTICS & FUNDS ROUTES
// ==========================================

app.get('/api/donations', requireAuth, (req, res) => {
  const donations = db.prepare(`
    SELECT d.id,
           CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS username,
           d.amount, d.event_tag, d.note, d.is_manual, d.created_at, d.centre_id, c.name AS centre_name
    FROM donations d
    JOIN users u ON d.user_id = u.id
    LEFT JOIN centres c ON c.id = d.centre_id
    WHERE d.user_id = ? AND (d.donor_name = '' OR d.donor_name = u.username)
    ORDER BY d.id DESC
  `).all(req.user.id);

  const total = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({ total, count: donations.length, donations });
});

app.get('/api/admin/donations', requireAuth, requireAdmin, (req, res) => {
  const scope = H.scopeSql(req.user, 'd.centre_id');
  const donations = db.prepare(`
    SELECT d.id, d.user_id, u.login_id,
           CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS donor_display,
           h.house_name,
           d.amount, d.event_tag, d.note, d.is_manual, d.created_at, d.centre_id, c.name AS centre_name
    FROM donations d
    JOIN users u ON d.user_id = u.id
    LEFT JOIN houses h ON u.house_id = h.id
    LEFT JOIN centres c ON c.id = d.centre_id
    WHERE ${scope.sql}
    ORDER BY d.id DESC
  `).all(...scope.args);

  const total = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({ total, count: donations.length, donations });
});

// Major donations: every centre has its own lower limit (centres.major_donation_min).
// ?centre_id= limits the list to one centre.
app.get('/api/donations/major', requireAuth, (req, res) => {
  const centres = db.prepare(`
    SELECT c.id, c.name, c.major_donation_min, z.name AS zone_name, r.name AS region_name
    FROM centres c JOIN zones z ON z.id = c.zone_id JOIN regions r ON r.id = z.region_id
    ORDER BY r.name COLLATE NOCASE, z.name COLLATE NOCASE, c.name COLLATE NOCASE
  `).all().map((c) => ({ ...c, can_edit: H.canManageCentre(req.user, c.id) }));

  let where = 'd.amount > c.major_donation_min';
  const args = [];
  if (req.query.centre_id) {
    where += ' AND d.centre_id = ?';
    args.push(Number(req.query.centre_id));
  }

  const donations = db.prepare(`
    SELECT d.id,
           CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS username,
           d.amount, d.event_tag, d.note, d.is_manual, d.created_at, d.centre_id,
           c.name AS centre_name, c.major_donation_min
    FROM donations d
    JOIN users u ON d.user_id = u.id
    JOIN centres c ON c.id = d.centre_id
    WHERE ${where}
    ORDER BY d.id DESC
  `).all(...args);

  const total = donations.reduce((sum, d) => sum + d.amount, 0);
  res.json({ centres, my_centre_id: req.user.centre_id, total, count: donations.length, donations });
});

app.get('/api/donations/by-person', requireAuth, requireAdmin, (req, res) => {
  const userScope = H.scopeSql(req.user, 'u.centre_id');
  const donationScope = H.scopeSql(req.user, 'd.centre_id');

  const users = db.prepare(`
    SELECT u.id, u.login_id, u.username, u.email, u.house_id, h.house_name, c.name AS centre_name
    FROM users u
    LEFT JOIN houses h ON u.house_id = h.id
    LEFT JOIN centres c ON c.id = u.centre_id
    WHERE ${userScope.sql}
    ORDER BY u.id ASC
  `).all(...userScope.args);

  const allDonations = db.prepare(`
    SELECT d.id, d.user_id, d.amount, d.event_tag, d.note, d.donor_name, d.is_manual, d.created_at, u.username,
           c.name AS centre_name
    FROM donations d
    JOIN users u ON d.user_id = u.id
    LEFT JOIN centres c ON c.id = d.centre_id
    WHERE ${donationScope.sql}
    ORDER BY d.id DESC
  `).all(...donationScope.args);

  const peopleMap = new Map();
  for (const u of users) {
    peopleMap.set(`user:${u.id}`, {
      key: `user:${u.id}`,
      user_id: u.id,
      login_id: u.login_id,
      name: u.username,
      email: u.email,
      house_name: u.house_name || 'Unassigned',
      centre_name: u.centre_name || '',
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
        user_id: isCustomGuest ? null : d.user_id,
        login_id: null,
        name: isCustomGuest ? d.donor_name : d.username,
        email: '',
        house_name: isCustomGuest ? 'Unassigned (Offline Donor)' : 'Another centre',
        centre_name: d.centre_name || '',
        is_registered: !isCustomGuest,
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
      centre_name: d.centre_name,
    });
  }

  const people = Array.from(peopleMap.values()).sort((a, b) => b.total_donated - a.total_donated);
  res.json({ count: people.length, people });
});

app.get('/api/donations/by-house', requireAuth, requireAdmin, (req, res) => {
  const houseScope = H.scopeSql(req.user, 'centre_id');
  const donationScope = H.scopeSql(req.user, 'd.centre_id');
  const houses = db.prepare(`SELECT * FROM houses WHERE ${houseScope.sql} ORDER BY house_name ASC`).all(...houseScope.args);
  const users = db.prepare('SELECT id, login_id, username, house_id FROM users ORDER BY username ASC').all();
  const allDonations = db.prepare(`
    SELECT d.id, d.user_id, d.amount, d.event_tag, d.note, d.donor_name, d.is_manual, d.created_at, u.username, u.login_id, u.house_id
    FROM donations d
    JOIN users u ON d.user_id = u.id
    WHERE ${donationScope.sql}
    ORDER BY d.id DESC
  `).all(...donationScope.args);
  const centres = centreNameMap();

  const houseMap = new Map();
  for (const h of houses) {
    const c = centres.get(h.centre_id);
    houseMap.set(h.id, {
      house_id: h.id,
      house_name: h.house_name,
      house_number: h.house_number || '',
      centre_name: c ? c.name : '',
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

// Standard user donation -> goes to the donor's own centre, blocks expired events, sends email & SMS
app.post('/api/donations', requireAuth, async (req, res, next) => {
  try {
    const { amount, event_tag = 'General', note = '' } = req.body || {};
    const parsedAmount = Math.round(Number(amount) * 100) / 100;

    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Please enter a valid amount greater than 0' });
    }

    const centre = H.getCentre(req.user.centre_id);
    if (!centre) {
      return res.status(400).json({ error: 'Your account is not linked to a centre yet. Please ask an admin to set your centre.' });
    }

    const resolved = resolveEventTag(event_tag, centre.id, { blockExpired: true });
    if (!resolved.valid) return res.status(400).json({ error: resolved.error });

    const cleanNote = String(note).trim().slice(0, 150);

    const result = db.prepare(`
      INSERT INTO donations (user_id, amount, event_tag, note, donor_name, is_manual, recorded_by, centre_id)
      VALUES (?, ?, ?, ?, '', 0, NULL, ?)
    `).run(req.user.id, parsedAmount, resolved.value, cleanNote, centre.id);

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
        eventTag: `${resolved.value} (${centre.name})`,
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
        notices.push('Email failed (check email settings)');
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
      message: `Thank you! Test donation of ₹${parsedAmount} (${resolved.value}) recorded for ${centre.name}.${statusSuffix}`,
      emailPreviewUrl,
      donation: {
        id: donationId,
        username: req.user.username,
        amount: parsedAmount,
        event_tag: resolved.value,
        note: cleanNote,
        is_manual: 0,
        centre_id: centre.id,
      },
    });
  } catch (err) {
    next(err);
  }
});

// Admin proxy donation (in someone's name) -> stays open for ended events, NO payment, NO email/SMS
app.post('/api/admin/donations', requireAuth, requireAdmin, (req, res) => {
  const {
    target_user_id,
    custom_donor_name = '',
    amount,
    event_tag = 'General',
    note = '',
    centre_id,
  } = req.body || {};

  const parsedAmount = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Please enter a valid amount greater than 0' });
  }

  let linkedUserId = req.user.id;
  let displayName = '';
  let centreId = null;

  if (target_user_id && target_user_id !== 'custom') {
    const targetUser = db.prepare('SELECT id, username, centre_id FROM users WHERE id = ?').get(Number(target_user_id));
    if (!targetUser) return res.status(404).json({ error: 'Selected user not found' });
    linkedUserId = targetUser.id;
    displayName = targetUser.username;
    // A member's donation always goes to their own centre
    centreId = targetUser.centre_id;
    if (!centreId) return res.status(400).json({ error: `${targetUser.username} is not linked to a centre yet.` });
  } else {
    displayName = String(custom_donor_name).trim().slice(0, 80);
    if (!displayName) return res.status(400).json({ error: 'Select a user or enter a donor name' });
    centreId = centre_id ?? H.defaultCentreFor(req.user);
    if (!H.getCentre(centreId)) return res.status(400).json({ error: 'Choose which centre this donation is for' });
  }

  if (!H.canManageCentre(req.user, centreId)) {
    return res.status(403).json({ error: 'That donor’s centre is outside your jurisdiction.' });
  }
  const centre = H.getCentre(centreId);

  const resolved = resolveEventTag(event_tag, centre.id);
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  const cleanNote = String(note).trim().slice(0, 150);

  const result = db.prepare(`
    INSERT INTO donations (user_id, amount, event_tag, note, donor_name, is_manual, recorded_by, centre_id)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(linkedUserId, parsedAmount, resolved.value, cleanNote, displayName, req.user.id, centre.id);

  db.syncEventFunds();

  H.logAction(req, 'donation.record_offline', {
    targetType: 'donation', targetId: result.lastInsertRowid, centreId: centre.id,
    summary: `Recorded ₹${parsedAmount} for "${displayName}" (${resolved.value}, ${centre.name})`,
    details: { amount: parsedAmount, donor: displayName, event_tag: resolved.value, note: cleanNote },
  });

  res.status(201).json({
    message: `Recorded ₹${parsedAmount} under "${displayName}" (${resolved.value}, ${centre.name}). Offline entry — no payment required and no email sent.`,
    donation: {
      id: result.lastInsertRowid,
      username: displayName,
      amount: parsedAmount,
      event_tag: resolved.value,
      note: cleanNote,
      is_manual: 1,
      centre_id: centre.id,
    },
  });
});

app.put('/api/donations/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid donation ID' });

  const existing = db.prepare('SELECT * FROM donations WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Donation not found' });
  if (!H.canManageCentre(req.user, existing.centre_id)) {
    return res.status(403).json({ error: 'This donation belongs to a centre outside your jurisdiction.' });
  }

  const { amount, event_tag, note, donor_name } = req.body || {};
  const parsedAmount = amount !== undefined ? Math.round(Number(amount) * 100) / 100 : existing.amount;
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  const resolved = event_tag !== undefined
    ? resolveEventTag(event_tag, existing.centre_id)
    : { valid: true, value: existing.event_tag };
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  const cleanNote = note !== undefined ? String(note).trim().slice(0, 150) : existing.note;
  const cleanDonor = donor_name !== undefined ? String(donor_name).trim().slice(0, 80) : existing.donor_name;

  db.prepare(`
    UPDATE donations SET amount = ?, event_tag = ?, note = ?, donor_name = ? WHERE id = ?
  `).run(parsedAmount, resolved.value, cleanNote, cleanDonor, id);

  db.syncEventFunds();

  H.logAction(req, 'donation.update', {
    targetType: 'donation', targetId: id, centreId: existing.centre_id,
    summary: `Edited donation #${id}${parsedAmount !== existing.amount ? ` (₹${existing.amount} → ₹${parsedAmount})` : ''}`,
    details: {
      before: { amount: existing.amount, event_tag: existing.event_tag, note: existing.note, donor_name: existing.donor_name },
      after: { amount: parsedAmount, event_tag: resolved.value, note: cleanNote, donor_name: cleanDonor },
    },
  });

  res.json({ message: 'Donation updated.' });
});

app.delete('/api/donations/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid donation ID' });

  const existing = db.prepare('SELECT * FROM donations WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Donation not found' });
  if (!H.canManageCentre(req.user, existing.centre_id)) {
    return res.status(403).json({ error: 'This donation belongs to a centre outside your jurisdiction.' });
  }

  db.prepare('DELETE FROM donations WHERE id = ?').run(id);
  db.syncEventFunds();

  H.logAction(req, 'donation.delete', {
    targetType: 'donation', targetId: id, centreId: existing.centre_id,
    summary: `Deleted donation #${id} of ₹${existing.amount} (${existing.event_tag})`,
    details: existing,
  });

  res.json({ message: 'Donation deleted and event funds re-synced.' });
});

// Transparency ledger for signed-in members: money raised by each event, grouped by centre
app.get('/api/funds', requireAuth, (req, res) => {
  const events = db.prepare(`
    SELECT e.id, e.title, e.event_date, e.total_fund, e.centre_id,
           c.name AS centre_name, z.name AS zone_name, r.name AS region_name
    FROM events e
    LEFT JOIN centres c ON c.id = e.centre_id
    LEFT JOIN zones z ON z.id = c.zone_id
    LEFT JOIN regions r ON r.id = z.region_id
    WHERE LOWER(e.title) != 'subtotal'
    ORDER BY r.name COLLATE NOCASE, z.name COLLATE NOCASE, c.name COLLATE NOCASE, e.id DESC
  `).all();

  res.json({ events });
});

// ==========================================
// EVENT ROUTES (each event belongs to one centre)
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
    SELECT e.id, e.title, e.event_date, e.content_json, e.total_fund, e.created_at, e.centre_id,
           COALESCE(u.username, 'Former member') AS author,
           c.name AS centre_name, z.name AS zone_name, r.name AS region_name
    FROM events e
    LEFT JOIN users u ON e.created_by = u.id
    LEFT JOIN centres c ON c.id = e.centre_id
    LEFT JOIN zones z ON z.id = c.zone_id
    LEFT JOIN regions r ON r.id = z.region_id
    WHERE LOWER(e.title) != 'subtotal'
    ORDER BY e.id DESC
  `).all();

  const photoRows = db.prepare(`
    SELECT p.id, p.event_id, p.url, p.caption, p.uploaded_by AS uploaded_by_id, p.created_at,
           COALESCE(u.username, 'Former member') AS uploaded_by
    FROM event_photos p
    LEFT JOIN users u ON u.id = p.uploaded_by
    ORDER BY p.id ASC
  `).all();
  const photosByEvent = new Map();
  for (const p of photoRows) {
    if (!photosByEvent.has(p.event_id)) photosByEvent.set(p.event_id, []);
    photosByEvent.get(p.event_id).push(p);
  }

  const managed = H.adminCentreIds(req.user);
  const managedSet = managed === null ? null : new Set(managed);

  const events = rows.map((row) => ({
    id: row.id,
    title: row.title,
    event_date: row.event_date,
    is_expired: isEventExpired(row.event_date),
    total_fund: row.total_fund,
    author: row.author,
    created_at: row.created_at,
    centre_id: row.centre_id,
    centre_name: row.centre_name || '',
    zone_name: row.zone_name || '',
    region_name: row.region_name || '',
    is_my_centre: row.centre_id !== null && row.centre_id === req.user.centre_id,
    can_manage: H.isAdmin(req.user) && (managedSet === null || managedSet.has(row.centre_id)),
    blocks: JSON.parse(row.content_json),
    photos: photosByEvent.get(row.id) || [],
  }));

  res.json({
    count: events.length,
    subtotal,
    general_fund: generalRow.total,
    my_centre_id: req.user.centre_id,
    events,
  });
});

function titleTakenInCentre(title, centreId, excludeId = null) {
  return db.prepare(`
    SELECT id FROM events WHERE LOWER(title) = LOWER(?) AND centre_id IS ? AND id != ?
  `).get(title, centreId, excludeId ?? -1);
}

app.post('/api/events', requireAuth, requireAdmin, (req, res, next) => {
  const { title, event_date = '', blocks, centre_id } = req.body || {};
  const cleanTitle = String(title || '').trim();

  if (!cleanTitle) return res.status(400).json({ error: 'Event title is required' });
  if (['subtotal', 'general'].includes(cleanTitle.toLowerCase())) {
    return res.status(400).json({ error: `"${cleanTitle}" is a reserved name and cannot be used for an event` });
  }

  const centre = H.getCentre(centre_id ?? H.defaultCentreFor(req.user));
  if (!centre) return res.status(400).json({ error: 'Choose which centre this event is for' });
  if (!H.canManageCentre(req.user, centre.id)) {
    return res.status(403).json({ error: 'You can only add events to centres under your jurisdiction.' });
  }
  if (titleTakenInCentre(cleanTitle, centre.id)) {
    return res.status(409).json({ error: `${centre.name} already has an event called "${cleanTitle}"` });
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
    INSERT INTO events (title, event_date, content_json, total_fund, created_by, centre_id)
    VALUES (?, ?, ?, 0, ?, ?)
  `).run(cleanTitle, String(event_date).trim(), JSON.stringify(savedBlocks), req.user.id, centre.id);

  db.syncEventFunds();
  H.logAction(req, 'event.create', {
    targetType: 'event', targetId: result.lastInsertRowid, centreId: centre.id,
    summary: `Published event "${cleanTitle}" for ${centre.name}`,
    details: { event_date: String(event_date).trim() },
  });
  res.status(201).json({ message: `Event article published for ${centre.name}!`, id: result.lastInsertRowid });
});

app.put('/api/events/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event ID' });

  const existing = db.prepare('SELECT id, title, event_date, centre_id FROM events WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });
  if (existing.title.toLowerCase() === 'subtotal') {
    return res.status(403).json({ error: 'The "Subtotal" system event cannot be edited' });
  }
  if (!H.canManageCentre(req.user, existing.centre_id)) {
    return res.status(403).json({ error: 'This event belongs to a centre outside your jurisdiction.' });
  }

  const newTitle = req.body?.title !== undefined ? String(req.body.title).trim() : existing.title;
  const newDate = req.body?.event_date !== undefined ? String(req.body.event_date).trim() : existing.event_date;

  if (!newTitle) return res.status(400).json({ error: 'Event title cannot be empty' });
  if (['subtotal', 'general'].includes(newTitle.toLowerCase())) {
    return res.status(400).json({ error: `Cannot rename an event to "${newTitle}"` });
  }
  if (titleTakenInCentre(newTitle, existing.centre_id, id)) {
    return res.status(409).json({ error: `This centre already has an event called "${newTitle}"` });
  }

  const updateEvent = db.transaction(() => {
    db.prepare('UPDATE events SET title = ?, event_date = ? WHERE id = ?').run(newTitle, newDate, id);
    if (newTitle !== existing.title) {
      db.prepare('UPDATE donations SET event_tag = ? WHERE event_tag = ? AND centre_id IS ?').run(newTitle, existing.title, existing.centre_id);
      db.prepare('UPDATE expenses SET event_tag = ? WHERE event_tag = ? AND centre_id IS ?').run(newTitle, existing.title, existing.centre_id);
    }
  });

  updateEvent();
  db.syncEventFunds();
  H.logAction(req, 'event.update', {
    targetType: 'event', targetId: id, centreId: existing.centre_id,
    summary: `Edited event "${existing.title}"${newTitle !== existing.title ? ` → "${newTitle}"` : ''}`,
    details: { before: { title: existing.title, event_date: existing.event_date }, after: { title: newTitle, event_date: newDate } },
  });
  res.json({ message: 'Event updated.' });
});

app.delete('/api/events/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event ID' });

  const existing = db.prepare('SELECT title, content_json, centre_id FROM events WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Event not found' });
  if (existing.title.toLowerCase() === 'subtotal') {
    return res.status(403).json({ error: 'The "Subtotal" event cannot be deleted' });
  }
  if (!H.canManageCentre(req.user, existing.centre_id)) {
    return res.status(403).json({ error: 'This event belongs to a centre outside your jurisdiction.' });
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

  const albumPhotos = db.prepare('SELECT url FROM event_photos WHERE event_id = ?').all(id);
  db.prepare('DELETE FROM event_photos WHERE event_id = ?').run(id);
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  for (const p of albumPhotos) {
    if (isUploadUrl(p.url) && !isUrlStillUsed(p.url)) removeUploadedFile(p.url);
  }
  db.syncEventFunds();
  H.logAction(req, 'event.delete', {
    targetType: 'event', targetId: id, centreId: existing.centre_id,
    summary: `Deleted event "${existing.title}" (and ${albumPhotos.length} album photo(s))`,
  });
  res.json({ message: 'Event deleted.' });
});

// ==========================================
// EXPENSE ROUTES (admins, within their centres)
// ==========================================

app.get('/api/expenses', requireAuth, requireAdmin, (req, res) => {
  const scope = H.scopeSql(req.user, 'ex.centre_id');
  const expenses = db.prepare(`
    SELECT ex.id, ex.amount, ex.event_tag, ex.type_tag, ex.note, ex.created_at, ex.centre_id,
           COALESCE(u.username, 'Former member') AS recorded_by, c.name AS centre_name
    FROM expenses ex
    LEFT JOIN users u ON ex.created_by = u.id
    LEFT JOIN centres c ON c.id = ex.centre_id
    WHERE ${scope.sql}
    ORDER BY ex.id DESC
  `).all(...scope.args);

  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  res.json({ total, count: expenses.length, expenses });
});

app.post('/api/expenses', requireAuth, requireAdmin, (req, res) => {
  const { amount, event_tag = 'General', type_tag = '', note = '', centre_id } = req.body || {};
  const parsedAmount = Math.round(Number(amount) * 100) / 100;

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Please enter a valid expense amount greater than 0' });
  }

  const centre = H.getCentre(centre_id ?? H.defaultCentreFor(req.user));
  if (!centre) return res.status(400).json({ error: 'Choose which centre this expense belongs to' });
  if (!H.canManageCentre(req.user, centre.id)) {
    return res.status(403).json({ error: 'That centre is outside your jurisdiction.' });
  }

  const resolved = resolveEventTag(event_tag, centre.id);
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  const cleanType = String(type_tag).trim().slice(0, 60);
  if (!cleanType) return res.status(400).json({ error: 'Expense type tag is required' });

  const cleanNote = String(note).trim().slice(0, 150);

  const result = db.prepare(`
    INSERT INTO expenses (amount, event_tag, type_tag, note, created_by, centre_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(parsedAmount, resolved.value, cleanType, cleanNote, req.user.id, centre.id);

  H.logAction(req, 'expense.create', {
    targetType: 'expense', targetId: result.lastInsertRowid, centreId: centre.id,
    summary: `Added expense ₹${parsedAmount} (${cleanType} · ${resolved.value}) for ${centre.name}`,
    details: { amount: parsedAmount, type_tag: cleanType, event_tag: resolved.value, note: cleanNote },
  });

  res.status(201).json({
    message: `Expense of ₹${parsedAmount} (${cleanType} · ${resolved.value}) recorded for ${centre.name}.`,
    expense: {
      id: result.lastInsertRowid,
      amount: parsedAmount,
      event_tag: resolved.value,
      type_tag: cleanType,
      note: cleanNote,
      centre_id: centre.id,
    },
  });
});

app.put('/api/expenses/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid expense ID' });

  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  if (!H.canManageCentre(req.user, existing.centre_id)) {
    return res.status(403).json({ error: 'This expense belongs to a centre outside your jurisdiction.' });
  }

  const { amount, event_tag, type_tag, note } = req.body || {};
  const parsedAmount = amount !== undefined ? Math.round(Number(amount) * 100) / 100 : existing.amount;
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: 'Amount must be greater than 0' });
  }

  const resolved = event_tag !== undefined
    ? resolveEventTag(event_tag, existing.centre_id)
    : { valid: true, value: existing.event_tag };
  if (!resolved.valid) return res.status(400).json({ error: resolved.error });

  const cleanType = type_tag !== undefined ? String(type_tag).trim().slice(0, 60) : existing.type_tag;
  if (!cleanType) return res.status(400).json({ error: 'Expense type tag cannot be empty' });

  const cleanNote = note !== undefined ? String(note).trim().slice(0, 150) : existing.note;

  db.prepare(`
    UPDATE expenses SET amount = ?, event_tag = ?, type_tag = ?, note = ? WHERE id = ?
  `).run(parsedAmount, resolved.value, cleanType, cleanNote, id);

  H.logAction(req, 'expense.update', {
    targetType: 'expense', targetId: id, centreId: existing.centre_id,
    summary: `Edited expense #${id}`,
    details: {
      before: { amount: existing.amount, event_tag: existing.event_tag, type_tag: existing.type_tag, note: existing.note },
      after: { amount: parsedAmount, event_tag: resolved.value, type_tag: cleanType, note: cleanNote },
    },
  });

  res.json({ message: 'Expense updated.' });
});

app.delete('/api/expenses/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid expense ID' });

  const existing = db.prepare('SELECT * FROM expenses WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Expense not found' });
  if (!H.canManageCentre(req.user, existing.centre_id)) {
    return res.status(403).json({ error: 'This expense belongs to a centre outside your jurisdiction.' });
  }

  db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  H.logAction(req, 'expense.delete', {
    targetType: 'expense', targetId: id, centreId: existing.centre_id,
    summary: `Deleted expense #${id} of ₹${existing.amount} (${existing.type_tag})`,
    details: existing,
  });

  res.json({ message: 'Expense deleted.' });
});

// ==========================================
// REPORT ROUTES (each report covers all centres, a region, a zone or one centre)
// ==========================================

function reportCentreIds(r) {
  return r.scope_type === 'all' ? H.allCentreIds() : H.centreIdsForScope(r.scope_type, r.scope_id);
}

function canViewReport(user, r) {
  if (H.isSuper(user)) return true;
  if (H.isAdmin(user) && H.canManageScope(user, r.scope_type, r.scope_id)) return true;
  // Members (and admins) can see any report that covers their own centre
  if (user.centre_id) return reportCentreIds(r).includes(Number(user.centre_id));
  return false;
}

function canDeleteReport(user, r) {
  return H.isSuper(user) || (H.isAdmin(user) && H.canManageScope(user, r.scope_type, r.scope_id));
}

app.get('/api/reports', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT r.id, r.report_type, r.title, r.period_label, r.created_at,
           r.scope_type, r.scope_id, r.scope_label,
           COALESCE(u.username, 'Former member') AS generated_by
    FROM reports r
    LEFT JOIN users u ON r.generated_by = u.id
    ORDER BY r.id DESC
  `).all();

  const reports = rows
    .filter((r) => canViewReport(req.user, r))
    .map((r) => ({
      id: r.id,
      report_type: r.report_type,
      title: r.title,
      period_label: r.period_label,
      scope_type: r.scope_type,
      scope_id: r.scope_id,
      scope_label: r.scope_label,
      generated_by: r.generated_by,
      created_at: r.created_at,
      can_delete: canDeleteReport(req.user, r),
    }));

  res.json({ count: reports.length, reports });
});

// Decide which centres a new report covers
function resolveReportScope(user, body) {
  if (body.report_type === 'event' && body.event_id) {
    const ev = db.prepare('SELECT id, title, centre_id FROM events WHERE id = ?').get(Number(body.event_id));
    if (!ev || ev.title.toLowerCase() === 'subtotal') return { error: 'Selected event does not exist' };
    if (!H.canManageCentre(user, ev.centre_id)) {
      return { error: 'That event belongs to a centre outside your jurisdiction.', status: 403 };
    }
    return { type: 'centre', id: ev.centre_id, event: ev };
  }

  const type = ['all', 'region', 'zone', 'centre'].includes(body.scope_type) ? body.scope_type : null;
  if (!type) return { error: 'Choose which centres the report covers' };
  const id = type === 'all' ? null : Number(body.scope_id);
  if (type !== 'all') {
    const exists = (type === 'region' && H.getRegion(id)) || (type === 'zone' && H.getZone(id)) || (type === 'centre' && H.getCentre(id));
    if (!exists) return { error: `Choose a ${type}` };
  }
  if (!H.canManageScope(user, type, id)) {
    return { error: 'You can only make reports for your own area.', status: 403 };
  }
  return { type, id };
}

app.post('/api/reports/generate', requireAuth, requireAdmin, (req, res) => {
  const body = req.body || {};
  const scope = resolveReportScope(req.user, body);
  if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });

  const spec = buildReportQuery({ ...body, event_title: scope.event ? scope.event.title : undefined });
  if (spec.error) return res.status(400).json({ error: spec.error });

  const centreIds = reportCentreIds({ scope_type: scope.type, scope_id: scope.id });
  const scopeFilter = H.centreIdsSql(centreIds, 'centre_id');
  const whereSql = `(${spec.whereSql}) AND ${scopeFilter.sql}`;
  const whereArgs = [...spec.whereArgs, ...scopeFilter.args];
  const scopeLabel = H.scopeLabel(scope.type, scope.id);
  const title = `${spec.title} · ${scope.type === 'all' ? 'All centres' : scopeLabel.replace(/ \(.*$/, '')}`;

  const donationTotals = db.prepare(`
    SELECT COUNT(*) AS count,
           COALESCE(SUM(amount), 0) AS total,
           COALESCE(SUM(CASE WHEN is_manual = 1 THEN amount ELSE 0 END), 0) AS manual_total
    FROM donations
    WHERE ${whereSql}
  `).get(...whereArgs);

  const donationsByCategory = db.prepare(`
    SELECT event_tag AS category, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
    FROM donations
    WHERE ${whereSql}
    GROUP BY event_tag
    ORDER BY total DESC
  `).all(...whereArgs);

  const donationsByCentre = db.prepare(`
    SELECT c.name AS category, COUNT(*) AS count, COALESCE(SUM(d.amount), 0) AS total
    FROM donations d LEFT JOIN centres c ON c.id = d.centre_id
    WHERE ${whereSql.replace(/\bcentre_id\b/g, 'd.centre_id').replace(/\bcreated_at\b/g, 'd.created_at').replace(/\bevent_tag\b/g, 'd.event_tag')}
    GROUP BY d.centre_id
    ORDER BY total DESC
  `).all(...whereArgs);

  const expenseWhereAliased = whereSql
    .replace(/\bcreated_at\b/g, 'ex.created_at')
    .replace(/\bevent_tag\b/g, 'ex.event_tag')
    .replace(/\bcentre_id\b/g, 'ex.centre_id');

  const matchingExpenses = db.prepare(`
    SELECT ex.id, ex.amount, ex.event_tag, ex.type_tag, ex.note, ex.created_at,
           COALESCE(u.username, 'Former member') AS recorded_by
    FROM expenses ex
    LEFT JOIN users u ON ex.created_by = u.id
    WHERE ${expenseWhereAliased}
    ORDER BY ex.id DESC
  `).all(...whereArgs);

  const totalExpenses = Math.round(matchingExpenses.reduce((sum, e) => sum + e.amount, 0) * 100) / 100;

  const summary = {
    total_donations: donationTotals.total,
    donation_count: donationTotals.count,
    manual_donations_total: donationTotals.manual_total,
    total_expenses: totalExpenses,
    expense_count: matchingExpenses.length,
    net_balance: Math.round((donationTotals.total - totalExpenses) * 100) / 100,
    donations_by_category: donationsByCategory,
    donations_by_centre: donationsByCentre,
    expenses_by_type: groupExpensesBy(matchingExpenses, 'type_tag'),
    expenses_by_event: groupExpensesBy(matchingExpenses, 'event_tag'),
    query: {
      report_type: body.report_type,
      event_tag: body.event_tag,
      event_id: scope.event ? scope.event.id : undefined,
      event_title: scope.event ? scope.event.title : undefined,
      year: body.year,
      month: body.month,
      quarter: body.quarter,
      half: body.half,
    },
  };

  const result = db.prepare(`
    INSERT INTO reports (report_type, title, period_label, summary_json, generated_by, scope_type, scope_id, scope_label)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(body.report_type, title, spec.periodLabel, JSON.stringify(summary), req.user.id, scope.type, scope.id, scopeLabel);

  H.logAction(req, 'report.generate', {
    targetType: 'report', targetId: result.lastInsertRowid, centreId: scope.type === 'centre' ? scope.id : null,
    summary: `Generated "${title}" (${scopeLabel})`,
  });

  res.status(201).json({
    message: `${title} generated! View it on the Reports page.`,
    report_id: result.lastInsertRowid,
    title,
    summary,
  });
});

app.delete('/api/reports/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report ID' });

  const report = db.prepare('SELECT id, title, scope_type, scope_id, scope_label FROM reports WHERE id = ?').get(id);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  if (!canDeleteReport(req.user, report)) {
    return res.status(403).json({ error: 'This report covers an area outside your jurisdiction.' });
  }

  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  H.logAction(req, 'report.delete', {
    targetType: 'report', targetId: id, centreId: report.scope_type === 'centre' ? report.scope_id : null,
    summary: `Deleted report "${report.title}" (${report.scope_label})`,
  });

  res.json({ message: 'Report deleted.' });
});

// Rebuild the query parameters for reports saved before parameters were stored
function reportQueryFromLabel(report) {
  const label = String(report.period_label || '');
  const type = report.report_type;
  let m;
  if (type === 'event' && label.startsWith('Event: ')) {
    return { report_type: 'event', event_tag: label.slice(7) };
  }
  if (type === 'monthly' && (m = /^(\w+) (\d{4})$/.exec(label))) {
    const month = MONTH_NAMES.indexOf(m[1]) + 1;
    return { report_type: 'monthly', year: Number(m[2]), month };
  }
  if (type === 'quarterly' && (m = /^Q([1-4]) (\d{4})/.exec(label))) {
    return { report_type: 'quarterly', year: Number(m[2]), quarter: Number(m[1]) };
  }
  if (type === 'half_yearly' && (m = /^H([12]) (\d{4})/.exec(label))) {
    return { report_type: 'half_yearly', year: Number(m[2]), half: Number(m[1]) };
  }
  if (type === 'yearly' && (m = /(\d{4})/.exec(label))) {
    return { report_type: 'yearly', year: Number(m[1]) };
  }
  return null;
}

app.get('/api/reports/:id/pdf', requireAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid report ID' });

    const row = db.prepare(`
      SELECT r.id, r.report_type, r.title, r.period_label, r.summary_json, r.created_at,
             r.scope_type, r.scope_id, r.scope_label,
             COALESCE(u.username, 'Former member') AS generated_by
      FROM reports r
      LEFT JOIN users u ON r.generated_by = u.id
      WHERE r.id = ?
    `).get(id);
    if (!row) return res.status(404).json({ error: 'Report not found' });
    if (!canViewReport(req.user, row)) return res.status(403).json({ error: 'You cannot view this report.' });

    const summary = JSON.parse(row.summary_json);
    const report = { ...row, summary };

    // Each centre's own major-donation limit applies
    const coveredCentres = reportCentreIds(row);
    const limits = coveredCentres.length
      ? db.prepare(`SELECT name, major_donation_min FROM centres WHERE id IN (${coveredCentres.map(() => '?').join(', ')})`).all(...coveredCentres)
      : [];
    const distinct = Array.from(new Set(limits.map((l) => l.major_donation_min)));
    const threshold = distinct.length === 1 ? distinct[0] : null; // null = differs per centre

    let majorDonations = [];
    const params = summary.query || reportQueryFromLabel(row);
    const spec = params ? buildReportQuery(params) : { error: 'unknown period' };
    if (!spec.error) {
      const scopeFilter = H.centreIdsSql(reportCentreIds(row), 'd.centre_id');
      const whereAliased = spec.whereSql
        .replace(/\bcreated_at\b/g, 'd.created_at')
        .replace(/\bevent_tag\b/g, 'd.event_tag')
        .replace(/\bcentre_id\b/g, 'd.centre_id');
      majorDonations = db.prepare(`
        SELECT d.id,
               CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS donor,
               CASE WHEN d.donor_name != '' AND d.donor_name != u.username THEN NULL ELSE h.house_name END AS house_name,
               c.name AS centre_name,
               d.amount, d.event_tag, d.note, d.is_manual, d.created_at
        FROM donations d
        JOIN users u ON d.user_id = u.id
        LEFT JOIN houses h ON u.house_id = h.id
        LEFT JOIN centres c ON c.id = d.centre_id
        WHERE (${whereAliased}) AND ${scopeFilter.sql} AND d.amount > c.major_donation_min
        ORDER BY d.amount DESC, d.id ASC
      `).all(...spec.whereArgs, ...scopeFilter.args);
    }

    const theme = db.getSetting('theme', null) || {};
    const pdf = await buildReportPdf({ report, majorDonations, threshold, theme });

    const safeName = String(row.title)
      .replace(/[—–·]/g, '-')
      .replace(/[^A-Za-z0-9 _-]+/g, '')
      .trim()
      .replace(/[\s-]+/g, '_')
      .slice(0, 80) || `report_${id}`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.setHeader('Content-Length', pdf.length);
    res.end(pdf);
  } catch (err) {
    next(err);
  }
});

// ==========================================
// ADMIN ACTIVITY LOG
// ==========================================

app.get('/api/admin/logs', requireAuth, requireAdmin, (req, res) => {
  // Only admins ABOVE someone can read that admin's actions (Super Admin reads everything)
  const vis = H.subordinateLogsSql(req.user, 'l');
  const visSql = vis.sql;
  const visArgs = vis.args;
  const where = [visSql];
  const args = [...visArgs];

  const q = String(req.query.q || '').trim();
  if (q) {
    where.push('(l.summary LIKE ? OR l.actor_name LIKE ? OR l.action LIKE ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (req.query.action) {
    where.push('l.action LIKE ?');
    args.push(`${String(req.query.action).replace(/[%_]/g, '')}%`);
  }
  if (req.query.actor_id) {
    where.push('l.actor_id = ?');
    args.push(Number(req.query.actor_id));
  }
  if (req.query.centre_id) {
    where.push('l.centre_id = ?');
    args.push(Number(req.query.centre_id));
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))) {
    where.push('l.created_at >= ?');
    args.push(`${req.query.from} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || ''))) {
    where.push('l.created_at < ?');
    args.push(`${req.query.to} 23:59:60`);
  }

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const total = db.prepare(`SELECT COUNT(*) AS n FROM admin_logs l ${whereSql}`).get(...args).n;
  const logs = db.prepare(`
    SELECT l.*, c.name AS centre_name
    FROM admin_logs l
    LEFT JOIN centres c ON c.id = l.centre_id
    ${whereSql}
    ORDER BY l.id DESC
    LIMIT ? OFFSET ?
  `).all(...args, limit, offset).map((l) => {
    let details = {};
    try { details = JSON.parse(l.details_json || '{}'); } catch {}
    return {
      id: l.id,
      created_at: l.created_at,
      actor_id: l.actor_id,
      actor_name: l.actor_name,
      actor_login_id: l.actor_login_id,
      actor_role: H.LEVEL_NAMES[l.actor_level] || '',
      action: l.action,
      target_type: l.target_type,
      target_id: l.target_id,
      centre_id: l.centre_id,
      centre_name: l.centre_name || '',
      summary: l.summary,
      details,
      ip: H.isSuper(req.user) ? l.ip : undefined,
    };
  });

  const actors = db.prepare(`
    SELECT l.actor_id AS id, MAX(l.actor_name) AS name FROM admin_logs l
    WHERE ${visSql} GROUP BY l.actor_id ORDER BY name COLLATE NOCASE
  `).all(...visArgs);

  res.json({ total, limit, offset, logs, actors });
});


// About page, Style Centre, uploads, gallery, event photos, People Lookup, report options
registerFeatureRoutes(app, { PUBLIC_DIR, UPLOADS_DIR });

// Census of people by centre, zone, region or the whole community
require('./census').registerCensusRoutes(app);

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