// ==========================================
// CENSUS: population statistics for a centre, zone, region or the whole community.
// Admins can only take a census of their own area; the Super Admin can also do community-wide.
// ==========================================

const db = require('./db');
const H = require('./hierarchy');
const { requireAuth, requireAdmin } = require('./auth');

const TOP_VALUES = 12;
const AGE_BANDS = [
  { label: 'Under 18', min: 0, max: 17 },
  { label: '18–30', min: 18, max: 30 },
  { label: '31–45', min: 31, max: 45 },
  { label: '46–60', min: 46, max: 60 },
  { label: '61–75', min: 61, max: 75 },
  { label: 'Over 75', min: 76, max: 200 },
];

// Which area? 'all' (community-wide) | region | zone | centre
function resolveScope(user, type, id) {
  const t = ['all', 'region', 'zone', 'centre'].includes(type) ? type : null;
  if (!t) return { error: 'Choose an area for the census' };
  const scopeId = t === 'all' ? null : Number(id);
  if (t !== 'all') {
    const exists = (t === 'region' && H.getRegion(scopeId)) || (t === 'zone' && H.getZone(scopeId)) || (t === 'centre' && H.getCentre(scopeId));
    if (!exists) return { error: `That ${t} does not exist`, status: 404 };
  }
  if (!H.canManageScope(user, t, scopeId)) {
    return { error: 'You can only take a census of your own area.', status: 403 };
  }
  return { type: t, id: scopeId, label: t === 'all' ? 'Whole community' : H.scopeLabel(t, scopeId) };
}

function ageFrom(dateStr, today) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  let age = today.getFullYear() - Number(m[1]);
  const beforeBirthday = today.getMonth() + 1 < Number(m[2]) ||
    (today.getMonth() + 1 === Number(m[2]) && today.getDate() < Number(m[3]));
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 150 ? age : null;
}

// Count values of one field: [{ value, count }], most common first
function tally(rows, key, { normalise = false, limit = TOP_VALUES, fixedOrder = null } = {}) {
  const counts = new Map();
  let missing = 0;
  for (const r of rows) {
    const raw = r[key];
    const str = raw === null || raw === undefined ? '' : String(raw).trim();
    if (!str) {
      missing += 1;
      continue;
    }
    const k = normalise ? str.toLowerCase() : str;
    if (!counts.has(k)) counts.set(k, { value: str, count: 0 });
    counts.get(k).count += 1;
  }
  let values = Array.from(counts.values());
  if (fixedOrder) {
    values.sort((a, b) => fixedOrder.indexOf(a.value) - fixedOrder.indexOf(b.value));
  } else {
    values.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  }
  let other = 0;
  if (values.length > limit) {
    other = values.slice(limit).reduce((sum, v) => sum + v.count, 0);
    values = values.slice(0, limit);
  }
  if (other) values.push({ value: 'Others', count: other });
  return { values, missing };
}

function computeCensus(scope) {
  const centreIds = scope.type === 'all' ? H.allCentreIds() : H.centreIdsForScope(scope.type, scope.id);
  const inCentres = H.centreIdsSql(centreIds, 'centre_id');
  const userCols = db.getCustomColumns('users');
  const houseCols = db.getCustomColumns('houses');

  const people = db.prepare(`SELECT * FROM users WHERE status = 'approved' AND ${inCentres.sql}`).all(...inCentres.args);
  const pending = db.prepare(`SELECT centre_id FROM users WHERE status = 'pending' AND ${inCentres.sql}`).all(...inCentres.args);
  const houses = db.prepare(`SELECT * FROM houses WHERE ${inCentres.sql}`).all(...inCentres.args);

  const centreInfo = centreIds.map((id) => H.getCentre(id)).filter(Boolean)
    .sort((a, b) => `${a.region_name}${a.zone_name}${a.name}`.localeCompare(`${b.region_name}${b.zone_name}${b.name}`));

  const houseIds = new Set(houses.map((h) => h.id));
  const membersPerHouse = new Map(houses.map((h) => [h.id, 0]));
  for (const p of people) {
    if (p.house_id && membersPerHouse.has(p.house_id)) membersPerHouse.set(p.house_id, membersPerHouse.get(p.house_id) + 1);
  }
  const inFamily = people.filter((p) => p.house_id && houseIds.has(p.house_id)).length;

  // Per centre
  const byCentre = centreInfo.map((c) => {
    const cp = people.filter((p) => p.centre_id === c.id);
    const ch = houses.filter((h) => h.centre_id === c.id);
    const chIds = new Set(ch.map((h) => h.id));
    return {
      centre: c.name,
      zone: c.zone_name,
      region: c.region_name,
      people: cp.length,
      families: ch.length,
      without_family: cp.filter((p) => !p.house_id || !chIds.has(p.house_id)).length,
      pending: pending.filter((p) => p.centre_id === c.id).length,
    };
  });

  // Family sizes
  const sizeLabels = ['Empty', '1', '2', '3', '4', '5', '6+'];
  const sizes = Array.from(membersPerHouse.values()).map((n) => ({ size: n === 0 ? 'Empty' : n >= 6 ? '6+' : String(n) }));
  const familySizes = tally(sizes, 'size', { fixedOrder: sizeLabels, limit: 10 }).values;

  // Roles
  const roles = tally(people.map((p) => ({ role: H.LEVEL_NAMES[p.access_level] })), 'role', {
    fixedOrder: Object.values(H.LEVEL_NAMES), limit: 10,
  }).values;

  // Age groups from a date-of-birth column
  const dobCol = userCols.find((c) => c.data_type === 'date' && /birth|dob/i.test(`${c.display_label} ${c.column_name}`));
  let ageGroups = null;
  if (dobCol) {
    const today = new Date();
    const bands = AGE_BANDS.map((b) => ({ value: b.label, count: 0 }));
    let unknown = 0;
    let sum = 0;
    let known = 0;
    for (const p of people) {
      const age = ageFrom(p[dobCol.column_name], today);
      if (age === null) {
        unknown += 1;
        continue;
      }
      known += 1;
      sum += age;
      const idx = AGE_BANDS.findIndex((b) => age >= b.min && age <= b.max);
      if (idx >= 0) bands[idx].count += 1;
    }
    ageGroups = {
      field: dobCol.display_label,
      values: bands,
      missing: unknown,
      average_age: known ? Math.round((sum / known) * 10) / 10 : null,
    };
  }

  // Breakdowns of the Super Admin's custom columns
  // Free-text columns are only charted when people's answers repeat (e.g. Occupation),
  // not when every answer is different (e.g. a person's name)
  const breakdownable = (c, rows) => {
    if (c.data_type === 'select' || c.data_type === 'boolean') return true;
    if (c.data_type !== 'text') return false;
    if (/(^|\s|_)(full\s*)?name$/i.test(c.display_label.trim())) return false;
    const filled = rows.map((r) => String(r[c.column_name] ?? '').trim().toLowerCase()).filter(Boolean);
    return filled.length < 5 || new Set(filled).size <= filled.length * 0.8;
  };
  const peopleBreakdowns = userCols.filter((c) => breakdownable(c, people)).map((c) => ({
    label: c.display_label,
    type: c.data_type,
    ...tally(people, c.column_name, {
      normalise: c.data_type === 'text',
      fixedOrder: c.data_type === 'select' ? c.options : c.data_type === 'boolean' ? ['Yes', 'No'] : null,
      limit: c.data_type === 'select' ? 50 : TOP_VALUES,
    }),
  }));
  const familyBreakdowns = houseCols.filter((c) => breakdownable(c, houses)).map((c) => ({
    label: c.display_label,
    type: c.data_type,
    ...tally(houses, c.column_name, {
      normalise: c.data_type === 'text',
      fixedOrder: c.data_type === 'select' ? c.options : c.data_type === 'boolean' ? ['Yes', 'No'] : null,
      limit: c.data_type === 'select' ? 50 : TOP_VALUES,
    }),
  }));

  return {
    scope_type: scope.type,
    scope_id: scope.id,
    scope_label: scope.label,
    generated_at: new Date().toISOString(),
    totals: {
      people: people.length,
      families: houses.length,
      people_in_families: inFamily,
      people_without_family: people.length - inFamily,
      average_family_size: houses.length ? Math.round((inFamily / houses.length) * 10) / 10 : 0,
      pending_signups: pending.length,
      centres: centreInfo.length,
    },
    by_centre: byCentre,
    roles,
    family_sizes: familySizes,
    age_groups: ageGroups,
    people_breakdowns: peopleBreakdowns,
    family_breakdowns: familyBreakdowns,
  };
}

function csvCell(v) {
  const str = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(str) || /^[=+\-@]/.test(str) ? `"${str.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : str;
}

function registerCensusRoutes(app) {
  // Live census of an area
  app.get('/api/census', requireAuth, requireAdmin, (req, res) => {
    const scope = resolveScope(req.user, req.query.scope_type, req.query.scope_id);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });
    res.json(computeCensus(scope));
  });

  // Everyone in the area as a spreadsheet (CSV)
  app.get('/api/census/export', requireAuth, requireAdmin, (req, res) => {
    const scope = resolveScope(req.user, req.query.scope_type, req.query.scope_id);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });

    const centreIds = scope.type === 'all' ? H.allCentreIds() : H.centreIdsForScope(scope.type, scope.id);
    const inCentres = H.centreIdsSql(centreIds, 'u.centre_id');
    const userCols = db.getCustomColumns('users');
    const houseCols = db.getCustomColumns('houses');

    const rows = db.prepare(`
      SELECT u.*, h.house_name, h.house_number, ${houseCols.map((c) => `h."${c.column_name}" AS "house__${c.column_name}"`).join(', ') || 'NULL AS no_house_cols'},
             c.name AS centre_name, z.name AS zone_name, r.name AS region_name
      FROM users u
      LEFT JOIN houses h ON h.id = u.house_id
      LEFT JOIN centres c ON c.id = u.centre_id
      LEFT JOIN zones z ON z.id = c.zone_id
      LEFT JOIN regions r ON r.id = z.region_id
      WHERE u.status = 'approved' AND ${inCentres.sql}
      ORDER BY r.name, z.name, c.name, h.house_name, u.username
    `).all(...inCentres.args);

    const header = ['Region', 'Zone', 'Centre', 'Family', 'Family code', ...houseCols.map((c) => `Family: ${c.display_label}`),
      'Member ID', 'Username', 'Email', 'Role', ...userCols.map((c) => c.display_label)];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push([
        r.region_name, r.zone_name, r.centre_name, r.house_name || '', r.house_number || '',
        ...houseCols.map((c) => r[`house__${c.column_name}`]),
        r.login_id, r.username, r.email, H.LEVEL_NAMES[r.access_level],
        ...userCols.map((c) => r[c.column_name]),
      ].map(csvCell).join(','));
    }

    H.logAction(req, 'census.export', {
      targetType: 'census', centreId: scope.type === 'centre' ? scope.id : null,
      summary: `Downloaded the people list for ${scope.label} (${rows.length} people)`,
    });

    const fileName = `census-${scope.label.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.end('﻿' + lines.join('\r\n')); // BOM so Excel reads Indian names correctly
  });

  // Saved census records (a dated snapshot you can compare later)
  app.post('/api/census/records', requireAuth, requireAdmin, (req, res) => {
    const body = req.body || {};
    const scope = resolveScope(req.user, body.scope_type, body.scope_id);
    if (scope.error) return res.status(scope.status || 400).json({ error: scope.error });

    const data = computeCensus(scope);
    const title = String(body.title || '').trim().slice(0, 100) ||
      `Census ${new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' })}`;
    const id = db.prepare(`
      INSERT INTO census_records (scope_type, scope_id, scope_label, title, data_json, taken_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(scope.type, scope.id, scope.label, title, JSON.stringify(data), req.user.id).lastInsertRowid;

    H.logAction(req, 'census.save', {
      targetType: 'census', targetId: id, centreId: scope.type === 'centre' ? scope.id : null,
      summary: `Saved census "${title}" for ${scope.label} (${data.totals.people} people, ${data.totals.families} families)`,
    });
    res.status(201).json({ message: `Census "${title}" saved.`, id });
  });

  app.get('/api/census/records', requireAuth, requireAdmin, (req, res) => {
    const rows = db.prepare(`
      SELECT r.id, r.scope_type, r.scope_id, r.scope_label, r.title, r.created_at, r.data_json,
             COALESCE(u.username, 'Former member') AS taken_by
      FROM census_records r LEFT JOIN users u ON u.id = r.taken_by
      ORDER BY r.id DESC
    `).all();
    const records = rows
      .filter((r) => H.canManageScope(req.user, r.scope_type, r.scope_id))
      .map((r) => {
        const totals = (JSON.parse(r.data_json).totals) || {};
        return {
          id: r.id, scope_type: r.scope_type, scope_id: r.scope_id, scope_label: r.scope_label,
          title: r.title, created_at: r.created_at, taken_by: r.taken_by,
          people: totals.people, families: totals.families,
        };
      });
    res.json({ records });
  });

  function findRecord(req, res) {
    const rec = db.prepare('SELECT * FROM census_records WHERE id = ?').get(Number(req.params.id));
    if (!rec) {
      res.status(404).json({ error: 'Census record not found' });
      return null;
    }
    if (!H.canManageScope(req.user, rec.scope_type, rec.scope_id)) {
      res.status(403).json({ error: 'This census covers an area outside your jurisdiction.' });
      return null;
    }
    return rec;
  }

  app.get('/api/census/records/:id', requireAuth, requireAdmin, (req, res) => {
    const rec = findRecord(req, res);
    if (!rec) return;
    res.json({ id: rec.id, title: rec.title, created_at: rec.created_at, data: JSON.parse(rec.data_json) });
  });

  app.delete('/api/census/records/:id', requireAuth, requireAdmin, (req, res) => {
    const rec = findRecord(req, res);
    if (!rec) return;
    db.prepare('DELETE FROM census_records WHERE id = ?').run(rec.id);
    H.logAction(req, 'census.delete', {
      targetType: 'census', targetId: rec.id, centreId: rec.scope_type === 'centre' ? rec.scope_id : null,
      summary: `Deleted census "${rec.title}" (${rec.scope_label})`,
    });
    res.json({ message: 'Census record deleted.' });
  });
}

module.exports = { registerCensusRoutes };
