// ==========================================
// Account hierarchy, jurisdiction checks and the admin audit log
//
//   Level 0  Super Admin   — everything
//   Level 1  Region Admin  — every zone & centre in one region   (users.scope_id -> regions.id)
//   Level 2  Zone Admin    — every centre in one zone            (users.scope_id -> zones.id)
//   Level 3  Centre Admin  — one centre                          (users.scope_id -> centres.id)
//   Level 4  User          — belongs to a centre (users.centre_id); donations go to that centre
// ==========================================

const db = require('./db');

const LEVELS = { SUPER: 0, REGION: 1, ZONE: 2, CENTRE: 3, USER: 4 };
const LEVEL_NAMES = {
  0: 'Super Admin',
  1: 'Region Admin',
  2: 'Zone Admin',
  3: 'Centre Admin',
  4: 'User',
};
const SCOPE_TYPE_FOR_LEVEL = { 1: 'region', 2: 'zone', 3: 'centre' };

const isAdminLevel = (level) => [0, 1, 2, 3].includes(Number(level));
const isAdmin = (user) => Boolean(user) && isAdminLevel(user.access_level);
const isSuper = (user) => Boolean(user) && Number(user.access_level) === 0;

// ---------- Lookups ----------

function getCentre(id) {
  if (id === null || id === undefined || id === '') return null;
  return (
    db.prepare(`
      SELECT c.id, c.name, c.code, c.address, c.zone_id, z.name AS zone_name, z.region_id, r.name AS region_name
      FROM centres c
      JOIN zones z ON z.id = c.zone_id
      JOIN regions r ON r.id = z.region_id
      WHERE c.id = ?
    `).get(Number(id)) || null
  );
}

function getZone(id) {
  return (
    db.prepare(`
      SELECT z.id, z.name, z.region_id, r.name AS region_name
      FROM zones z JOIN regions r ON r.id = z.region_id WHERE z.id = ?
    `).get(Number(id)) || null
  );
}

function getRegion(id) {
  return db.prepare('SELECT id, name FROM regions WHERE id = ?').get(Number(id)) || null;
}

function allCentreIds() {
  return db.prepare('SELECT id FROM centres').all().map((r) => r.id);
}

// Centre ids covered by a scope (type: all | region | zone | centre)
function centreIdsForScope(type, id) {
  if (type === 'all') return allCentreIds();
  if (type === 'region') {
    return db.prepare('SELECT c.id FROM centres c JOIN zones z ON z.id = c.zone_id WHERE z.region_id = ?')
      .all(Number(id)).map((r) => r.id);
  }
  if (type === 'zone') return db.prepare('SELECT id FROM centres WHERE zone_id = ?').all(Number(id)).map((r) => r.id);
  if (type === 'centre') return getCentre(id) ? [Number(id)] : [];
  return [];
}

function scopeLabel(type, id) {
  if (type === 'all') return 'All centres';
  if (type === 'region') {
    const r = getRegion(id);
    return r ? `${r.name} (region)` : 'Unknown region';
  }
  if (type === 'zone') {
    const z = getZone(id);
    return z ? `${z.name} (zone, ${z.region_name})` : 'Unknown zone';
  }
  if (type === 'centre') {
    const c = getCentre(id);
    return c ? `${c.name} (centre, ${c.zone_name})` : 'Unknown centre';
  }
  return '';
}

// ---------- Jurisdiction ----------

// null = every centre (Super Admin); otherwise an array of centre ids the admin controls
function adminCentreIds(user) {
  if (!user) return [];
  const level = Number(user.access_level);
  if (level === 0) return null;
  const type = SCOPE_TYPE_FOR_LEVEL[level];
  if (!type || user.scope_id === null || user.scope_id === undefined) return [];
  return centreIdsForScope(type, user.scope_id);
}

function canManageCentre(user, centreId) {
  if (!isAdmin(user)) return false;
  if (isSuper(user)) return Boolean(getCentre(centreId));
  const ids = adminCentreIds(user);
  return ids.includes(Number(centreId));
}

// Can `user` administer the whole region / zone / centre `(type, id)`?
function canManageScope(user, type, id) {
  if (!isAdmin(user)) return false;
  if (isSuper(user)) return true;
  const level = Number(user.access_level);
  const sid = Number(user.scope_id);
  if (type === 'all') return false;
  if (type === 'region') return level === 1 && sid === Number(id);
  if (type === 'zone') {
    const z = getZone(id);
    if (!z) return false;
    return (level === 1 && z.region_id === sid) || (level === 2 && z.id === sid);
  }
  if (type === 'centre') return canManageCentre(user, id);
  return false;
}

// SQL fragment limiting a centre_id column to the admin's jurisdiction
function scopeSql(user, column) {
  const ids = adminCentreIds(user);
  if (ids === null) return { sql: '1 = 1', args: [] };
  if (!ids.length) return { sql: '0 = 1', args: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, args: ids };
}

function centreIdsSql(ids, column) {
  if (!ids.length) return { sql: '0 = 1', args: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, args: ids };
}

// Can `actor` give someone the role (level, scopeId)?
function canAssignRole(actor, level, scopeId) {
  const lvl = Number(level);
  if (!isAdmin(actor) || ![0, 1, 2, 3, 4].includes(lvl)) return false;
  if (lvl <= Number(actor.access_level) && !isSuper(actor)) return false; // only roles below your own
  if (lvl === 0) return isSuper(actor);
  if (lvl === 4) return true;
  return canManageScope(actor, SCOPE_TYPE_FOR_LEVEL[lvl], scopeId);
}

// Can `actor` edit / delete / approve the account `target`?
function canManageUser(actor, target) {
  if (!isAdmin(actor) || !target) return false;
  if (isSuper(actor)) return true;
  const tLevel = Number(target.access_level);
  if (tLevel <= Number(actor.access_level)) return false;
  if (tLevel === 4) return canManageCentre(actor, target.centre_id);
  return canManageScope(actor, SCOPE_TYPE_FOR_LEVEL[tLevel], target.scope_id);
}

// If the admin controls exactly one centre, use it as the default
function defaultCentreFor(user) {
  const ids = adminCentreIds(user);
  if (ids && ids.length === 1) return ids[0];
  return null;
}

function roleLabel(level, scopeId) {
  const lvl = Number(level);
  const base = LEVEL_NAMES[lvl] || `Level ${lvl}`;
  const type = SCOPE_TYPE_FOR_LEVEL[lvl];
  if (!type) return base;
  let name = '';
  if (type === 'region') name = (getRegion(scopeId) || {}).name;
  if (type === 'zone') name = (getZone(scopeId) || {}).name;
  if (type === 'centre') name = (getCentre(scopeId) || {}).name;
  return name ? `${base} · ${name}` : `${base} (no area assigned)`;
}

// ---------- Audit log ----------

function clientIp(req) {
  const fwd = String((req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return (fwd || req.ip || (req.socket && req.socket.remoteAddress) || '').slice(0, 64);
}

/**
 * Record a privileged action.
 * logAction(req, 'donation.delete', { targetType: 'donation', targetId: 12, centreId: 3, summary: '...', details: {...} })
 */
function logAction(req, action, { targetType = '', targetId = null, centreId = null, summary = '', details = {} } = {}) {
  try {
    const u = req.user || {};
    db.prepare(`
      INSERT INTO admin_logs (actor_id, actor_name, actor_login_id, actor_level, action, target_type, target_id,
                              centre_id, summary, details_json, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      u.id ?? null,
      String(u.username || ''),
      u.login_id ?? null,
      u.access_level ?? null,
      String(action).slice(0, 60),
      String(targetType).slice(0, 40),
      targetId === null || targetId === undefined ? null : Number(targetId),
      centreId === null || centreId === undefined ? null : Number(centreId),
      String(summary).slice(0, 500),
      JSON.stringify(details || {}).slice(0, 20000),
      clientIp(req)
    );
  } catch (err) {
    console.error('Could not write admin log:', err.message);
  }
}

module.exports = {
  LEVELS,
  LEVEL_NAMES,
  SCOPE_TYPE_FOR_LEVEL,
  isAdminLevel,
  isAdmin,
  isSuper,
  getCentre,
  getZone,
  getRegion,
  allCentreIds,
  centreIdsForScope,
  scopeLabel,
  adminCentreIds,
  canManageCentre,
  canManageScope,
  scopeSql,
  centreIdsSql,
  canAssignRole,
  canManageUser,
  defaultCentreFor,
  roleLabel,
  logAction,
};
