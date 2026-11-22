require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { getAuthUser, hasLevel } = require('./auth');
const { sendDonationAcknowledgement } = require('./mailer');

if (!process.env.JWT_SECRET) {
  console.error('ERROR: JWT_SECRET is missing in your .env file.');
  process.exit(1);
}

const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    const MAX_BYTES = 15 * 1024 * 1024;

    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });

    req.on('error', reject);
  });
}

function saveBase64Image(dataUrl) {
  const match = String(dataUrl).match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('INVALID_IMAGE');
  }

  const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);

  return `/uploads/${filename}`;
}

function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const fullPath = path.resolve(PUBLIC_DIR, '.' + requested);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  fs.readFile(fullPath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function resolveEventTag(rawTag) {
  const cleanTag = String(rawTag || 'General').trim();
  if (!cleanTag || cleanTag.toLowerCase() === 'general') {
    return { valid: true, value: 'General' };
  }
  if (cleanTag.toLowerCase() === 'subtotal') {
    return { valid: false, error: 'Cannot assign "Subtotal" directly as an event tag' };
  }
  const matched = db.prepare(`
    SELECT title FROM events WHERE title = ? AND LOWER(title) != 'subtotal'
  `).get(cleanTag);
  if (!matched) {
    return { valid: false, error: 'Selected event does not exist' };
  }
  return { valid: true, value: matched.title };
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

// Group individual expense records under each category key
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const { method } = req;

  try {
    // 1. POST /api/login
    if (method === 'POST' && pathname === '/api/login') {
      const { username, password } = await readJsonBody(req);
      if (!username || !password) {
        return sendJson(res, 400, { error: 'Username and password are required' });
      }

      const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return sendJson(res, 401, { error: 'Invalid credentials' });
      }

      if (user.status !== 'approved') {
        return sendJson(res, 403, {
          error: `Account is currently '${user.status}' and requires Level 1 approval`,
        });
      }

      const token = jwt.sign(
        { id: user.id, username: user.username, access_level: user.access_level },
        process.env.JWT_SECRET,
        { expiresIn: '2h' }
      );

      return sendJson(res, 200, { token, access_level: user.access_level });
    }

    // 2. POST /api/signup
    if (method === 'POST' && pathname === '/api/signup') {
      const { username, email, password, access_level = 2 } = await readJsonBody(req);

      if (!username || !email || !password) {
        return sendJson(res, 400, { error: 'Username, email, and password are required' });
      }

      if (![1, 2].includes(Number(access_level))) {
        return sendJson(res, 400, { error: 'access_level must be 1 or 2' });
      }

      const passwordHash = bcrypt.hashSync(password, 10);

      try {
        const result = db.prepare(`
          INSERT INTO users (username, email, password_hash, access_level, status, created_by, approved_by)
          VALUES (?, ?, ?, ?, 'pending', NULL, NULL)
        `).run(username, email, passwordHash, Number(access_level));

        return sendJson(res, 201, {
          message: 'Account request submitted! Wait for Level 1 approval before logging in.',
          user: {
            id: result.lastInsertRowid,
            username,
            email,
            access_level: Number(access_level),
            status: 'pending',
          },
        });
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return sendJson(res, 409, { error: 'Username or email already exists' });
        }
        return sendJson(res, 500, { error: 'Database error' });
      }
    }

    // 3. GET /api/users (Level 1 ONLY — passwords excluded)
    if (method === 'GET' && pathname === '/api/users') {
      const user = getAuthUser(req);
      if (!user) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(user, 1)) return sendJson(res, 403, { error: 'Forbidden: Level 1 required' });

      const users = db.prepare(`
        SELECT id, username, email, access_level, status, created_by, approved_by, created_at
        FROM users
      `).all();

      return sendJson(res, 200, { count: users.length, users });
    }

    // 4. POST /api/users (Level 1 or 2)
    if (method === 'POST' && pathname === '/api/users') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1, 2)) {
        return sendJson(res, 403, { error: 'Forbidden: insufficient access level' });
      }

      const { username, email, password, access_level = 2 } = await readJsonBody(req);
      if (!username || !email || !password) {
        return sendJson(res, 400, { error: 'username, email, and password are required' });
      }

      if (![1, 2].includes(Number(access_level))) {
        return sendJson(res, 400, { error: 'access_level must be 1 or 2' });
      }

      const passwordHash = bcrypt.hashSync(password, 10);
      const isLevel1 = authUser.access_level === 1;
      const status = isLevel1 ? 'approved' : 'pending';
      const approvedBy = isLevel1 ? authUser.id : null;

      try {
        const result = db.prepare(`
          INSERT INTO users (username, email, password_hash, access_level, status, created_by, approved_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(username, email, passwordHash, Number(access_level), status, authUser.id, approvedBy);

        return sendJson(res, 201, {
          message: isLevel1
            ? 'Account created and approved.'
            : 'Account created and awaiting Level 1 approval.',
          user: {
            id: result.lastInsertRowid,
            username,
            email,
            access_level: Number(access_level),
            status,
            created_by: authUser.id,
            approved_by: approvedBy,
          },
        });
      } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
          return sendJson(res, 409, { error: 'Username or email already exists' });
        }
        return sendJson(res, 500, { error: 'Database error' });
      }
    }

    // 5. PATCH /api/users/:id/decision (Level 1 ONLY)
    const decisionMatch = pathname.match(/^\/api\/users\/(\d+)\/decision$/);
    if (method === 'PATCH' && decisionMatch) {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) return sendJson(res, 403, { error: 'Forbidden: Level 1 required' });

      const id = Number(decisionMatch[1]);
      const { decision } = await readJsonBody(req);

      if (!['approved', 'rejected'].includes(decision)) {
        return sendJson(res, 400, { error: 'decision must be "approved" or "rejected"' });
      }

      const targetUser = db.prepare('SELECT id, status FROM users WHERE id = ?').get(id);
      if (!targetUser) return sendJson(res, 404, { error: 'User not found' });
      if (targetUser.status !== 'pending') {
        return sendJson(res, 400, { error: `User is already ${targetUser.status}` });
      }

      db.prepare('UPDATE users SET status = ?, approved_by = ? WHERE id = ?')
        .run(decision, authUser.id, id);

      return sendJson(res, 200, {
        message: `User ${id} has been ${decision}.`,
        approved_by: authUser.id,
      });
    }

    // 6. GET /api/donations (Logged-in user's OWN donations only)
    if (method === 'GET' && pathname === '/api/donations') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });

      const donations = db.prepare(`
        SELECT d.id,
               CASE WHEN d.donor_name != '' THEN d.donor_name ELSE u.username END AS username,
               d.amount, d.event_tag, d.note, d.is_manual, d.created_at
        FROM donations d
        JOIN users u ON d.user_id = u.id
        WHERE d.user_id = ? AND (d.donor_name = '' OR d.donor_name = u.username)
        ORDER BY d.id DESC
      `).all(authUser.id);

      const total = donations.reduce((sum, d) => sum + d.amount, 0);
      return sendJson(res, 200, { total, count: donations.length, donations });
    }

    // 6b. GET /api/donations/major (All donations above ₹10,000)
    if (method === 'GET' && pathname === '/api/donations/major') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });

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
      return sendJson(res, 200, { total, count: donations.length, donations });
    }

    // 7. POST /api/donations (Standard user donation -> sends acknowledgement email)
    if (method === 'POST' && pathname === '/api/donations') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });

      const { amount, event_tag = 'General', note = '' } = await readJsonBody(req);
      const parsedAmount = Math.round(Number(amount) * 100) / 100;

      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return sendJson(res, 400, { error: 'Please enter a valid amount greater than 0' });
      }

      const resolved = resolveEventTag(event_tag);
      if (!resolved.valid) return sendJson(res, 400, { error: resolved.error });

      const cleanNote = String(note).trim().slice(0, 150);

      const result = db.prepare(`
        INSERT INTO donations (user_id, amount, event_tag, note, donor_name, is_manual, recorded_by)
        VALUES (?, ?, ?, ?, '', 0, NULL)
      `).run(authUser.id, parsedAmount, resolved.value, cleanNote);

      db.syncEventFunds();

      const donationId = result.lastInsertRowid;
      const donor = db.prepare('SELECT username, email FROM users WHERE id = ?').get(authUser.id);

      let emailStatus = 'not_sent';
      let emailPreviewUrl = null;

      if (donor && donor.email) {
        try {
          const mailResult = await sendDonationAcknowledgement({
            to: donor.email,
            username: donor.username,
            donationId,
            amount: parsedAmount,
            eventTag: resolved.value,
            note: cleanNote,
            date: new Date().toISOString(),
          });
          emailStatus = 'sent';
          emailPreviewUrl = mailResult.previewUrl;
        } catch (mailErr) {
          console.error('Failed to send acknowledgement email:', mailErr.message);
          emailStatus = 'failed';
        }
      }

      const emailNote =
        emailStatus === 'sent'
          ? ` Acknowledgement letter emailed to ${donor.email}.`
          : ' (Donation saved, but acknowledgement email could not be sent — check SMTP settings.)';

      return sendJson(res, 201, {
        message: `Thank you! Test donation of ₹${parsedAmount} (${resolved.value}) recorded.${emailNote}`,
        emailPreviewUrl,
        donation: {
          id: donationId,
          username: authUser.username,
          amount: parsedAmount,
          event_tag: resolved.value,
          note: cleanNote,
          is_manual: 0,
        },
      });
    }

    // 7a. POST /api/admin/donations (Level 1 ONLY: offline entry in someone's name — NO payment, NO email)
    if (method === 'POST' && pathname === '/api/admin/donations') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Only Level 1 admins can record donations for others' });
      }

      const {
        target_user_id,
        custom_donor_name = '',
        amount,
        event_tag = 'General',
        note = '',
      } = await readJsonBody(req);

      const parsedAmount = Math.round(Number(amount) * 100) / 100;
      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return sendJson(res, 400, { error: 'Please enter a valid amount greater than 0' });
      }

      const resolved = resolveEventTag(event_tag);
      if (!resolved.valid) return sendJson(res, 400, { error: resolved.error });

      let linkedUserId = authUser.id;
      let displayName = '';

      if (target_user_id && target_user_id !== 'custom') {
        const targetUser = db.prepare('SELECT id, username FROM users WHERE id = ?').get(Number(target_user_id));
        if (!targetUser) {
          return sendJson(res, 404, { error: 'Selected user not found' });
        }
        linkedUserId = targetUser.id;
        displayName = targetUser.username;
      } else {
        displayName = String(custom_donor_name).trim().slice(0, 80);
        if (!displayName) {
          return sendJson(res, 400, { error: 'Select a user or enter a donor name' });
        }
      }

      const cleanNote = String(note).trim().slice(0, 150);

      const result = db.prepare(`
        INSERT INTO donations (user_id, amount, event_tag, note, donor_name, is_manual, recorded_by)
        VALUES (?, ?, ?, ?, ?, 1, ?)
      `).run(linkedUserId, parsedAmount, resolved.value, cleanNote, displayName, authUser.id);

      db.syncEventFunds();

      return sendJson(res, 201, {
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
    }

    // 7b. GET /api/funds (PUBLIC — everyone can view event funds and Subtotal)
    if (method === 'GET' && pathname === '/api/funds') {
      const subtotal = db.prepare(`
        SELECT id, title, total_fund
        FROM events
        WHERE LOWER(title) = 'subtotal'
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

      return sendJson(res, 200, {
        subtotal,
        general_fund: generalRow.total,
        events: eventFunds,
      });
    }

    // 8. GET /api/events (All logged-in users — Subtotal returned separately)
    if (method === 'GET' && pathname === '/api/events') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });

      const subtotal = db.prepare(`
        SELECT id, title, total_fund
        FROM events
        WHERE LOWER(title) = 'subtotal'
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
        total_fund: row.total_fund,
        author: row.author,
        created_at: row.created_at,
        blocks: JSON.parse(row.content_json),
      }));

      return sendJson(res, 200, {
        count: events.length,
        subtotal,
        general_fund: generalRow.total,
        events,
      });
    }

    // 9. POST /api/events (Level 1 Admin ONLY — blocks creating "Subtotal")
    if (method === 'POST' && pathname === '/api/events') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Only Level 1 admins can upload events' });
      }

      const { title, event_date = '', blocks } = await readJsonBody(req);
      const cleanTitle = String(title || '').trim();

      if (!cleanTitle) {
        return sendJson(res, 400, { error: 'Event title is required' });
      }

      if (cleanTitle.toLowerCase() === 'subtotal') {
        return sendJson(res, 400, { error: '"Subtotal" is a reserved system event and cannot be created' });
      }

      if (!Array.isArray(blocks) || blocks.length === 0) {
        return sendJson(res, 400, { error: 'Add at least one heading, text, or picture block' });
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
          return sendJson(res, 400, { error: 'Invalid image format (use PNG, JPG, GIF, or WEBP)' });
        }
        throw imgErr;
      }

      if (savedBlocks.length === 0) {
        return sendJson(res, 400, { error: 'Article cannot be empty' });
      }

      const result = db.prepare(`
        INSERT INTO events (title, event_date, content_json, total_fund, created_by)
        VALUES (?, ?, ?, 0, ?)
      `).run(cleanTitle, String(event_date).trim(), JSON.stringify(savedBlocks), authUser.id);

      db.syncEventFunds();

      return sendJson(res, 201, {
        message: 'Event article published!',
        id: result.lastInsertRowid,
      });
    }

    // 10. DELETE /api/events/:id (Level 1 Admin ONLY — blocks deleting "Subtotal")
    const deleteEventMatch = pathname.match(/^\/api\/events\/(\d+)$/);
    if (method === 'DELETE' && deleteEventMatch) {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Only Level 1 admins can delete events' });
      }

      const id = Number(deleteEventMatch[1]);
      const existing = db.prepare('SELECT title, content_json FROM events WHERE id = ?').get(id);
      if (!existing) return sendJson(res, 404, { error: 'Event not found' });

      if (existing.title.toLowerCase() === 'subtotal') {
        return sendJson(res, 403, { error: 'The "Subtotal" event cannot be deleted' });
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

      return sendJson(res, 200, { message: 'Event deleted.' });
    }

    // 11. GET /api/expenses (Level 1 Admin ONLY)
    if (method === 'GET' && pathname === '/api/expenses') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Only Level 1 admins can view raw expenses' });
      }

      const expenses = db.prepare(`
        SELECT ex.id, ex.amount, ex.event_tag, ex.type_tag, ex.note, ex.created_at, u.username AS recorded_by
        FROM expenses ex
        JOIN users u ON ex.created_by = u.id
        ORDER BY ex.id DESC
      `).all();

      const total = expenses.reduce((sum, e) => sum + e.amount, 0);
      return sendJson(res, 200, { total, count: expenses.length, expenses });
    }

    // 12. POST /api/expenses (Level 1 Admin ONLY)
    if (method === 'POST' && pathname === '/api/expenses') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Only Level 1 admins can record expenses' });
      }

      const { amount, event_tag = 'General', type_tag = '', note = '' } = await readJsonBody(req);
      const parsedAmount = Math.round(Number(amount) * 100) / 100;

      if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return sendJson(res, 400, { error: 'Please enter a valid expense amount greater than 0' });
      }

      const resolved = resolveEventTag(event_tag);
      if (!resolved.valid) return sendJson(res, 400, { error: resolved.error });

      const cleanType = String(type_tag).trim().slice(0, 60);
      if (!cleanType) {
        return sendJson(res, 400, { error: 'Expense type tag is required' });
      }

      const cleanNote = String(note).trim().slice(0, 150);

      const result = db.prepare(`
        INSERT INTO expenses (amount, event_tag, type_tag, note, created_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(parsedAmount, resolved.value, cleanType, cleanNote, authUser.id);

      return sendJson(res, 201, {
        message: `Expense of ₹${parsedAmount} (${cleanType} · ${resolved.value}) recorded.`,
        expense: {
          id: result.lastInsertRowid,
          amount: parsedAmount,
          event_tag: resolved.value,
          type_tag: cleanType,
          note: cleanNote,
        },
      });
    }

    // 13. DELETE /api/expenses/:id (Level 1 Admin ONLY)
    const deleteExpenseMatch = pathname.match(/^\/api\/expenses\/(\d+)$/);
    if (method === 'DELETE' && deleteExpenseMatch) {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Level 1 required' });
      }

      const id = Number(deleteExpenseMatch[1]);
      const info = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      if (info.changes === 0) return sendJson(res, 404, { error: 'Expense not found' });

      return sendJson(res, 200, { message: 'Expense deleted.' });
    }

    // 14. GET /api/reports (Level 1 Admin & Level 2 Operator)
    if (method === 'GET' && pathname === '/api/reports') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1, 2)) {
        return sendJson(res, 403, { error: 'Forbidden: insufficient access level' });
      }

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

      return sendJson(res, 200, { count: reports.length, reports });
    }

    // 15. POST /api/reports/generate (Level 1 Admin ONLY)
    if (method === 'POST' && pathname === '/api/reports/generate') {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Only Level 1 admins can generate reports' });
      }

      const body = await readJsonBody(req);
      const spec = buildReportQuery(body);
      if (spec.error) {
        return sendJson(res, 400, { error: spec.error });
      }

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

      // Fetch all matching expenses so each category includes both its total AND individual expenses
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

      const totalExpenses = Math.round(
        matchingExpenses.reduce((sum, e) => sum + e.amount, 0) * 100
      ) / 100;

      const expensesByType = groupExpensesBy(matchingExpenses, 'type_tag');
      const expensesByEvent = groupExpensesBy(matchingExpenses, 'event_tag');

      const summary = {
        total_donations: donationTotals.total,
        donation_count: donationTotals.count,
        manual_donations_total: donationTotals.manual_total,
        total_expenses: totalExpenses,
        expense_count: matchingExpenses.length,
        net_balance: Math.round((donationTotals.total - totalExpenses) * 100) / 100,
        donations_by_category: donationsByCategory,
        expenses_by_type: expensesByType,
        expenses_by_event: expensesByEvent,
      };

      const result = db.prepare(`
        INSERT INTO reports (report_type, title, period_label, summary_json, generated_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(body.report_type, spec.title, spec.periodLabel, JSON.stringify(summary), authUser.id);

      return sendJson(res, 201, {
        message: `${spec.title} generated! View it on the Reports page.`,
        report_id: result.lastInsertRowid,
        title: spec.title,
        summary,
      });
    }

    // 16. DELETE /api/reports/:id (Level 1 Admin ONLY)
    const deleteReportMatch = pathname.match(/^\/api\/reports\/(\d+)$/);
    if (method === 'DELETE' && deleteReportMatch) {
      const authUser = getAuthUser(req);
      if (!authUser) return sendJson(res, 401, { error: 'Invalid or missing token' });
      if (!hasLevel(authUser, 1)) {
        return sendJson(res, 403, { error: 'Forbidden: Level 1 required' });
      }

      const id = Number(deleteReportMatch[1]);
      const info = db.prepare('DELETE FROM reports WHERE id = ?').run(id);
      if (info.changes === 0) return sendJson(res, 404, { error: 'Report not found' });

      return sendJson(res, 200, { message: 'Report deleted.' });
    }

    // Unknown API route (MUST stay below all /api/... routes)
    if (pathname.startsWith('/api/')) {
      return sendJson(res, 404, { error: 'API endpoint not found' });
    }

    // Static files
    if (method === 'GET') {
      return serveStatic(res, pathname);
    }

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
  } catch (err) {
    if (err.message === 'INVALID_JSON') {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    if (err.message === 'PAYLOAD_TOO_LARGE') {
      return sendJson(res, 413, { error: 'Request body too large' });
    }
    console.error(err);
    sendJson(res, 500, { error: 'Internal server error' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running without Express on http://localhost:${PORT}`);
});