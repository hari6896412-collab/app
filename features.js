// ==========================================
// FEATURE ROUTES
// About page, Style Centre theme, media uploads, gallery,
// event photo albums, people lookup (directory) and report settings.
// ==========================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const db = require('./db');
const { requireAuth, requireAdmin, requireSuper } = require('./auth');
const H = require('./hierarchy');

const isAdmin = (user) => H.isAdmin(user);

// ------------------------------------------
// Upload rules
// ------------------------------------------

const MEDIA_TYPES = {
  'image/png': { ext: 'png', kind: 'image' },
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/jpg': { ext: 'jpg', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'video/mp4': { ext: 'mp4', kind: 'video' },
  'video/webm': { ext: 'webm', kind: 'video' },
  'video/quicktime': { ext: 'mov', kind: 'video' },
  'video/ogg': { ext: 'ogv', kind: 'video' },
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'gif', 'webp']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'ogv']);

const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_MEMBER_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB for non-admin event photos
const MAX_VIDEO_BYTES = 250 * 1024 * 1024; // 250 MB

function matchesMagicBytes(buf, ext) {
  if (!buf || buf.length < 12) return false;
  const ascii = (start, end) => buf.subarray(start, end).toString('latin1');
  switch (ext) {
    case 'png':
      return buf[0] === 0x89 && ascii(1, 4) === 'PNG';
    case 'jpg':
      return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'gif':
      return ascii(0, 4) === 'GIF8';
    case 'webp':
      return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'mp4':
    case 'mov':
      return ascii(4, 8) === 'ftyp' || ascii(4, 8) === 'moov' || ascii(4, 8) === 'mdat' || ascii(4, 8) === 'wide';
    case 'webm':
      return buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
    case 'ogv':
      return ascii(0, 4) === 'OggS';
    default:
      return false;
  }
}

const UPLOAD_URL_RE = /^\/uploads\/[A-Za-z0-9._-]+$/;

function isUploadUrl(url) {
  return UPLOAD_URL_RE.test(String(url || ''));
}

function uploadKind(url) {
  if (!isUploadUrl(url)) return null;
  const ext = String(url).split('.').pop().toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  return null;
}

// Media may be an uploaded file or an external https link (e.g. a YouTube video)
function cleanMediaUrl(raw) {
  const url = String(raw || '').trim().slice(0, 600);
  if (!url) return '';
  if (isUploadUrl(url)) return url;
  if (/^https:\/\/[^\s"'<>]+$/i.test(url)) return url;
  return '';
}

function cleanLinkHref(raw) {
  const href = String(raw || '').trim().slice(0, 400);
  if (!href) return '';
  if (/^\/(?!\/)[^\s"'<>]*$/.test(href)) return href; // same-site path
  if (/^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/i.test(href)) return href;
  return '';
}

function cleanText(raw, max) {
  return String(raw ?? '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function pickEnum(raw, allowed, fallback) {
  const val = String(raw ?? '').trim();
  return allowed.includes(val) ? val : fallback;
}

function clampNumber(raw, min, max, fallback) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function cleanHex(raw, fallback) {
  const val = String(raw || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(val) ? val.toLowerCase() : fallback;
}

// ------------------------------------------
// Backgrounds (shared by About sections and Style Centre)
// ------------------------------------------

const BG_TYPES = ['none', 'color', 'gradient', 'image', 'video'];

function cleanBackground(raw, { allowDefault = false } = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const types = allowDefault ? ['default', ...BG_TYPES] : BG_TYPES;
  let type = pickEnum(src.type, types, allowDefault ? 'default' : 'none');
  let url = '';

  if (type === 'image' || type === 'video') {
    url = cleanMediaUrl(src.url);
    if (!url) type = allowDefault ? 'default' : 'none';
  }

  return {
    type,
    color: cleanHex(src.color, '#7f1d1d'),
    color2: cleanHex(src.color2, '#ea580c'),
    angle: clampNumber(src.angle, 0, 360, 135),
    url,
    poster: cleanMediaUrl(src.poster),
    overlay: clampNumber(src.overlay, 0, 90, type === 'video' || type === 'image' ? 35 : 0),
    overlayColor: cleanHex(src.overlayColor, '#000000'),
    blur: clampNumber(src.blur, 0, 20, 0),
    fixed: Boolean(src.fixed),
  };
}

// ------------------------------------------
// About page content
// ------------------------------------------

const ABOUT_LAYOUTS = ['hero', 'text', 'media', 'split'];

const DEFAULT_ABOUT = {
  sections: [
    {
      id: 'welcome',
      layout: 'hero',
      eyebrow: 'Welcome',
      heading: 'Our Community, Together',
      body: 'A home for our families — events, photos, funds and everyone in one place.',
      media: [],
      mediaSide: 'right',
      background: {
        type: 'gradient', color: '#7f1d1d', color2: '#ea580c', angle: 135,
        url: '', poster: '', overlay: 0, overlayColor: '#000000', blur: 0, fixed: false,
      },
      textTone: 'light',
      align: 'center',
      height: 'tall',
      button: { label: 'See Upcoming Events', href: '/events.html' },
    },
    {
      id: 'about-us',
      layout: 'text',
      eyebrow: 'About us',
      heading: 'Who we are',
      body:
        'Tell your community’s story here. Admins can edit this page from the “Edit page” button — add photos, videos, and photo or video backgrounds to any section.',
      media: [],
      mediaSide: 'right',
      background: {
        type: 'none', color: '#ffffff', color2: '#f2ece7', angle: 135,
        url: '', poster: '', overlay: 0, overlayColor: '#000000', blur: 0, fixed: false,
      },
      textTone: 'dark',
      align: 'left',
      height: 'auto',
      button: { label: '', href: '' },
    },
  ],
};

function cleanAboutSection(raw, index) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const layout = pickEnum(src.layout, ABOUT_LAYOUTS, 'text');
  const mediaIn = Array.isArray(src.media) ? src.media.slice(0, 24) : [];
  const media = [];

  for (const m of mediaIn) {
    const url = cleanMediaUrl(m && m.url);
    if (!url) continue;
    let type = pickEnum(m.type, ['image', 'video', 'youtube'], 'image');
    const kind = uploadKind(url);
    if (kind) type = kind; // trust the uploaded file's real type
    media.push({ type, url, caption: cleanText(m.caption, 200) });
  }

  const idRaw = String(src.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);

  return {
    id: idRaw || `section-${index + 1}-${crypto.randomBytes(3).toString('hex')}`,
    layout,
    eyebrow: cleanText(src.eyebrow, 80),
    heading: cleanText(src.heading, 160),
    body: cleanText(src.body, 6000),
    media,
    mediaSide: pickEnum(src.mediaSide, ['left', 'right'], 'right'),
    background: cleanBackground(src.background),
    textTone: pickEnum(src.textTone, ['dark', 'light'], 'dark'),
    align: pickEnum(src.align, ['left', 'center'], 'left'),
    height: pickEnum(src.height, ['auto', 'medium', 'tall', 'screen'], 'auto'),
    button: {
      label: cleanText(src.button && src.button.label, 60),
      href: cleanLinkHref(src.button && src.button.href),
    },
  };
}

function cleanAboutContent(raw) {
  const sectionsIn = raw && Array.isArray(raw.sections) ? raw.sections.slice(0, 40) : [];
  return { sections: sectionsIn.map(cleanAboutSection) };
}

// ------------------------------------------
// Theme (Style Centre)
// ------------------------------------------

const FONT_CHOICES = [
  'Inter', 'Plus Jakarta Sans', 'Poppins', 'Montserrat', 'Nunito', 'Lato', 'Mukta',
  'Baloo 2', 'Noto Sans', 'Merriweather', 'Lora', 'Playfair Display',
];

const THEME_PAGES = [
  '/', '/index.html', '/signup.html', '/dashboard.html', '/events.html', '/gallery.html',
  '/people.html', '/funds.html', '/reports.html', '/major-donations.html', '/houses.html',
  '/admin-db.html', '/upload-event.html', '/style-centre.html', '/centres.html', '/admin-logs.html',
  '/census.html',
];

const DEFAULT_THEME = {
  siteName: 'GSB ONLINE',
  logoUrl: '',
  colors: {
    primary: '#b91c1c',
    primaryDark: '#7f1d1d',
    accent: '#ea580c',
    ink: '#181412',
    canvas: '#f2ece7',
  },
  fontBody: 'Inter',
  fontHeading: 'Plus Jakarta Sans',
  radius: 16,
  headerStyle: 'gradient',
  cardStyle: 'solid',
  cardOpacity: 100,
  background: { type: 'default' },
  pageBackgrounds: {},
  customCss: '',
};

function cleanTheme(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const colorsIn = src.colors && typeof src.colors === 'object' ? src.colors : {};
  const pageBgIn = src.pageBackgrounds && typeof src.pageBackgrounds === 'object' ? src.pageBackgrounds : {};
  const pageBackgrounds = {};

  for (const page of THEME_PAGES) {
    if (pageBgIn[page]) {
      const bg = cleanBackground(pageBgIn[page], { allowDefault: true });
      if (bg.type !== 'default') pageBackgrounds[page] = bg;
    }
  }

  const logo = cleanMediaUrl(src.logoUrl);

  return {
    siteName: cleanText(src.siteName, 40) || DEFAULT_THEME.siteName,
    logoUrl: logo && uploadKind(logo) !== 'video' ? logo : '',
    colors: {
      primary: cleanHex(colorsIn.primary, DEFAULT_THEME.colors.primary),
      primaryDark: cleanHex(colorsIn.primaryDark, DEFAULT_THEME.colors.primaryDark),
      accent: cleanHex(colorsIn.accent, DEFAULT_THEME.colors.accent),
      ink: cleanHex(colorsIn.ink, DEFAULT_THEME.colors.ink),
      canvas: cleanHex(colorsIn.canvas, DEFAULT_THEME.colors.canvas),
    },
    fontBody: pickEnum(src.fontBody, FONT_CHOICES, DEFAULT_THEME.fontBody),
    fontHeading: pickEnum(src.fontHeading, FONT_CHOICES, DEFAULT_THEME.fontHeading),
    radius: clampNumber(src.radius, 0, 28, DEFAULT_THEME.radius),
    headerStyle: pickEnum(src.headerStyle, ['gradient', 'solid', 'glass', 'dark'], 'gradient'),
    cardStyle: pickEnum(src.cardStyle, ['solid', 'glass'], 'solid'),
    cardOpacity: clampNumber(src.cardOpacity, 40, 100, 100),
    background: cleanBackground(src.background, { allowDefault: true }),
    pageBackgrounds,
    customCss: String(src.customCss || '').slice(0, 20000),
  };
}

// ------------------------------------------
// Directory (People Lookup)
// ------------------------------------------

const DEFAULT_DIRECTORY_SETTINGS = { hidden_user_fields: [], hidden_house_fields: [] };

function getDirectorySettings() {
  const saved = db.getSetting('directory', DEFAULT_DIRECTORY_SETTINGS) || {};
  return {
    hidden_user_fields: Array.isArray(saved.hidden_user_fields) ? saved.hidden_user_fields : [],
    hidden_house_fields: Array.isArray(saved.hidden_house_fields) ? saved.hidden_house_fields : [],
  };
}

function directoryFieldDefs() {
  const userFields = [
    { key: 'login_id', label: 'Member ID', data_type: 'number' },
    { key: 'email', label: 'Email', data_type: 'email' },
    ...db.getCustomColumns('users').map((c) => ({
      key: c.column_name,
      label: c.display_label,
      data_type: c.data_type,
    })),
  ];
  const houseFields = [
    { key: 'house_number', label: 'House Code', data_type: 'text' },
    ...db.getCustomColumns('houses').map((c) => ({
      key: c.column_name,
      label: c.display_label,
      data_type: c.data_type,
    })),
  ];
  return { userFields, houseFields };
}

// ------------------------------------------
// File helpers
// ------------------------------------------

function makeFileRemover(publicDir) {
  return function removeUploadedFile(url) {
    if (!isUploadUrl(url)) return;
    const filePath = path.join(publicDir, 'uploads', path.basename(url));
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (err) {
      console.error('Could not delete upload', filePath, err.message);
    }
  };
}

function isUrlStillUsed(url) {
  const needle = `%${url}%`;
  const checks = [
    db.prepare('SELECT 1 FROM gallery_items WHERE url = ? LIMIT 1').get(url),
    db.prepare('SELECT 1 FROM event_photos WHERE url = ? LIMIT 1').get(url),
    db.prepare('SELECT 1 FROM events WHERE content_json LIKE ? LIMIT 1').get(needle),
    db.prepare('SELECT 1 FROM site_settings WHERE value_json LIKE ? LIMIT 1').get(needle),
  ];
  return checks.some(Boolean);
}

// ==========================================
// ROUTES
// ==========================================

function registerFeatureRoutes(app, { PUBLIC_DIR, UPLOADS_DIR }) {
  const removeUploadedFile = makeFileRemover(PUBLIC_DIR);
  const removeIfUnused = (url) => {
    if (isUploadUrl(url) && !isUrlStillUsed(url)) removeUploadedFile(url);
  };

  // ---------- Media upload (raw binary body; Content-Type = file type) ----------
  const rawBody = express.raw({ type: () => true, limit: MAX_VIDEO_BYTES + 1024 });

  app.post('/api/uploads', requireAuth, rawBody, (req, res) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const typeDef = MEDIA_TYPES[contentType];
    const admin = isAdmin(req.user);

    if (!typeDef) {
      return res.status(400).json({
        error: 'Unsupported file type. Use PNG, JPG, GIF, WEBP images or MP4, WEBM, MOV videos.',
      });
    }

    if (typeDef.kind === 'video' && !admin) {
      return res.status(403).json({ error: 'Only admins can upload videos.' });
    }

    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length === 0) {
      return res.status(400).json({ error: 'The uploaded file is empty.' });
    }

    const limit = typeDef.kind === 'video' ? MAX_VIDEO_BYTES : admin ? MAX_IMAGE_BYTES : MAX_MEMBER_IMAGE_BYTES;
    if (buf.length > limit) {
      return res.status(413).json({ error: `File too large (max ${Math.round(limit / 1024 / 1024)} MB).` });
    }

    if (!matchesMagicBytes(buf, typeDef.ext)) {
      return res.status(400).json({ error: 'The file contents do not match its type.' });
    }

    const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${typeDef.ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);

    res.status(201).json({
      url: `/uploads/${filename}`,
      media_type: typeDef.kind,
      size: buf.length,
    });
  });

  // ---------- About page ----------
  app.get('/api/about', (req, res) => {
    const content = db.getSetting('about_page', null) || DEFAULT_ABOUT;
    const meta = db.getSettingMeta('about_page');
    res.json({ content, updated_at: meta ? meta.updated_at : null, is_default: !meta });
  });

  app.put('/api/about', requireAuth, requireSuper, (req, res) => {
    const previous = db.getSetting('about_page', null);
    const content = cleanAboutContent(req.body || {});
    db.setSetting('about_page', content, req.user.id);

    // Tidy up files that were removed from the page
    if (previous) {
      const before = JSON.stringify(previous).match(/\/uploads\/[A-Za-z0-9._-]+/g) || [];
      for (const url of new Set(before)) removeIfUnused(url);
    }

    H.logAction(req, 'site.about_update', {
      targetType: 'site', summary: `Updated the About page (${content.sections.length} section(s))`,
    });
    res.json({ message: 'About page saved.', content });
  });

  // ---------- Theme / Style Centre ----------
  app.get('/api/theme', (req, res) => {
    const saved = db.getSetting('theme', null);
    const theme = saved ? cleanTheme(saved) : cleanTheme(DEFAULT_THEME);
    const meta = db.getSettingMeta('theme');
    res.json({
      theme,
      updated_at: meta ? meta.updated_at : null,
      fonts: FONT_CHOICES,
      pages: THEME_PAGES,
    });
  });

  app.put('/api/theme', requireAuth, requireSuper, (req, res) => {
    const previous = db.getSetting('theme', null);
    const theme = cleanTheme((req.body && req.body.theme) || req.body || {});
    db.setSetting('theme', theme, req.user.id);

    if (previous) {
      const before = JSON.stringify(previous).match(/\/uploads\/[A-Za-z0-9._-]+/g) || [];
      for (const url of new Set(before)) removeIfUnused(url);
    }

    H.logAction(req, 'site.theme_update', { targetType: 'site', summary: 'Changed the website style in the Style Centre' });
    res.json({ message: 'Style saved. It is now live on every page.', theme });
  });

  app.delete('/api/theme', requireAuth, requireSuper, (req, res) => {
    db.setSetting('theme', cleanTheme(DEFAULT_THEME), req.user.id);
    H.logAction(req, 'site.theme_reset', { targetType: 'site', summary: 'Reset the website style to the original look' });
    res.json({ message: 'Style reset to the original look.', theme: cleanTheme(DEFAULT_THEME) });
  });

  // ---------- Galleries ----------
  // One General gallery (Super Admin) plus one gallery per region, zone and centre.
  // Each is run by that area's admins; higher admins can run every gallery below them.

  const GALLERY_TYPES = ['general', 'region', 'zone', 'centre'];

  function parseGalleryScope(type, id) {
    const t = GALLERY_TYPES.includes(type) ? type : 'general';
    if (t === 'general') return { type: 'general', id: null };
    const num = Number(id);
    const exists = (t === 'region' && H.getRegion(num)) || (t === 'zone' && H.getZone(num)) || (t === 'centre' && H.getCentre(num));
    return exists ? { type: t, id: num } : null;
  }

  function canManageGallery(user, type, id) {
    if (type === 'general') return H.isSuper(user);
    return H.canManageScope(user, type, id);
  }

  function galleryLabel(type, id) {
    if (type === 'general') return 'General gallery';
    if (type === 'region') return `${(H.getRegion(id) || {}).name || 'Region'} (region)`;
    if (type === 'zone') return `${(H.getZone(id) || {}).name || 'Zone'} (zone)`;
    return `${(H.getCentre(id) || {}).name || 'Centre'} (centre)`;
  }

  // Every gallery, with item counts and what this account may manage
  app.get('/api/galleries', requireAuth, (req, res) => {
    const counts = new Map(
      db.prepare('SELECT scope_type, scope_id, COUNT(*) AS n FROM gallery_items GROUP BY scope_type, scope_id').all()
        .map((r) => [`${r.scope_type}:${r.scope_id ?? ''}`, r.n])
    );
    const count = (type, id) => counts.get(`${type}:${id ?? ''}`) || 0;

    const myCentre = H.getCentre(req.user.centre_id);
    const regions = db.prepare('SELECT id, name FROM regions ORDER BY name COLLATE NOCASE').all();
    const zones = db.prepare('SELECT id, region_id, name FROM zones ORDER BY name COLLATE NOCASE').all();
    const centres = db.prepare('SELECT id, zone_id, name FROM centres ORDER BY name COLLATE NOCASE').all();

    res.json({
      general: { type: 'general', id: null, name: 'General gallery', count: count('general', null), can_manage: H.isSuper(req.user) },
      regions: regions.map((r) => ({
        type: 'region', id: r.id, name: r.name, count: count('region', r.id),
        can_manage: canManageGallery(req.user, 'region', r.id),
        zones: zones.filter((z) => z.region_id === r.id).map((z) => ({
          type: 'zone', id: z.id, name: z.name, count: count('zone', z.id),
          can_manage: canManageGallery(req.user, 'zone', z.id),
          centres: centres.filter((c) => c.zone_id === z.id).map((c) => ({
            type: 'centre', id: c.id, name: c.name, count: count('centre', c.id),
            can_manage: canManageGallery(req.user, 'centre', c.id),
          })),
        })),
      })),
      mine: myCentre
        ? { centre_id: myCentre.id, zone_id: myCentre.zone_id, region_id: myCentre.region_id }
        : null,
    });
  });

  app.get('/api/gallery', requireAuth, (req, res) => {
    const scope = parseGalleryScope(req.query.scope_type, req.query.scope_id);
    if (!scope) return res.status(404).json({ error: 'Gallery not found' });

    const canManage = canManageGallery(req.user, scope.type, scope.id);
    const items = db.prepare(`
      SELECT g.id, g.media_type, g.url, g.caption, g.album, g.created_at, g.uploaded_by AS uploaded_by_id,
             COALESCE(u.username, 'Former member') AS uploaded_by
      FROM gallery_items g
      LEFT JOIN users u ON u.id = g.uploaded_by
      WHERE g.scope_type = ? AND g.scope_id IS ?
      ORDER BY g.id DESC
    `).all(scope.type, scope.id).map((i) => ({ ...i, can_manage: canManage }));

    const albums = Array.from(new Set(items.map((i) => i.album).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );

    res.json({
      scope_type: scope.type,
      scope_id: scope.id,
      name: galleryLabel(scope.type, scope.id),
      can_manage: canManage,
      count: items.length,
      albums,
      items,
    });
  });

  app.post('/api/gallery', requireAuth, requireAdmin, (req, res) => {
    const scope = parseGalleryScope(req.body && req.body.scope_type, req.body && req.body.scope_id);
    if (!scope) return res.status(400).json({ error: 'Choose a gallery' });
    if (!canManageGallery(req.user, scope.type, scope.id)) {
      return res.status(403).json({ error: 'You can only add to galleries in your own area.' });
    }

    const itemsIn = Array.isArray(req.body && req.body.items) ? req.body.items.slice(0, 100) : [];
    if (itemsIn.length === 0) {
      return res.status(400).json({ error: 'Upload at least one photo or video.' });
    }

    const insert = db.prepare(`
      INSERT INTO gallery_items (media_type, url, caption, album, uploaded_by, scope_type, scope_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const saved = [];
    const addAll = db.transaction(() => {
      for (const item of itemsIn) {
        const url = String(item && item.url || '');
        const kind = uploadKind(url);
        if (!kind) continue;
        const caption = cleanText(item.caption, 200);
        const album = cleanText(item.album, 60);
        const info = insert.run(kind, url, caption, album, req.user.id, scope.type, scope.id);
        saved.push({ id: info.lastInsertRowid, media_type: kind, url, caption, album });
      }
    });
    addAll();

    if (saved.length === 0) {
      return res.status(400).json({ error: 'No valid uploaded files were provided.' });
    }

    const label = galleryLabel(scope.type, scope.id);
    H.logAction(req, 'gallery.add', {
      targetType: 'gallery', centreId: scope.type === 'centre' ? scope.id : null,
      summary: `Added ${saved.length} item(s) to ${label}${saved[0].album ? ` (album "${saved[0].album}")` : ''}`,
      details: { gallery: label, ids: saved.map((i) => i.id) },
    });
    res.status(201).json({ message: `${saved.length} item(s) added to ${label}.`, items: saved });
  });

  function findManageableItem(req, res) {
    const id = Number(req.params.id);
    const existing = Number.isInteger(id) && db.prepare('SELECT * FROM gallery_items WHERE id = ?').get(id);
    if (!existing) {
      res.status(404).json({ error: 'Gallery item not found' });
      return null;
    }
    if (!canManageGallery(req.user, existing.scope_type, existing.scope_id)) {
      res.status(403).json({ error: 'This gallery is outside your area.' });
      return null;
    }
    return existing;
  }

  app.put('/api/gallery/:id', requireAuth, requireAdmin, (req, res) => {
    const existing = findManageableItem(req, res);
    if (!existing) return;

    const caption = req.body && req.body.caption !== undefined ? cleanText(req.body.caption, 200) : existing.caption;
    const album = req.body && req.body.album !== undefined ? cleanText(req.body.album, 60) : existing.album;
    db.prepare('UPDATE gallery_items SET caption = ?, album = ? WHERE id = ?').run(caption, album, existing.id);
    H.logAction(req, 'gallery.update', {
      targetType: 'gallery', targetId: existing.id,
      centreId: existing.scope_type === 'centre' ? existing.scope_id : null,
      summary: `Edited item #${existing.id} in ${galleryLabel(existing.scope_type, existing.scope_id)}`,
      details: { before: { caption: existing.caption, album: existing.album }, after: { caption, album } },
    });
    res.json({ message: 'Gallery item updated.' });
  });

  app.delete('/api/gallery/:id', requireAuth, requireAdmin, (req, res) => {
    const existing = findManageableItem(req, res);
    if (!existing) return;

    db.prepare('DELETE FROM gallery_items WHERE id = ?').run(existing.id);
    removeIfUnused(existing.url);
    H.logAction(req, 'gallery.delete', {
      targetType: 'gallery', targetId: existing.id,
      centreId: existing.scope_type === 'centre' ? existing.scope_id : null,
      summary: `Deleted ${existing.media_type} #${existing.id}${existing.caption ? ` "${existing.caption}"` : ''} from ${galleryLabel(existing.scope_type, existing.scope_id)}`,
    });
    res.json({ message: 'Removed from gallery.' });
  });

  // ---------- Event photo albums ----------
  app.post('/api/events/:id/photos', requireAuth, (req, res) => {
    const eventId = Number(req.params.id);
    const event = Number.isInteger(eventId) && db.prepare('SELECT id, title, centre_id FROM events WHERE id = ?').get(eventId);
    if (!event || event.title.toLowerCase() === 'subtotal') {
      return res.status(404).json({ error: 'Event not found' });
    }

    const photosIn = Array.isArray(req.body && req.body.photos) ? req.body.photos.slice(0, 50) : [];
    const insert = db.prepare(`
      INSERT INTO event_photos (event_id, url, caption, uploaded_by) VALUES (?, ?, ?, ?)
    `);

    let added = 0;
    const addAll = db.transaction(() => {
      for (const p of photosIn) {
        const url = String(p && p.url || '');
        if (uploadKind(url) !== 'image') continue;
        insert.run(eventId, url, cleanText(p.caption, 200), req.user.id);
        added += 1;
      }
    });
    addAll();

    if (added === 0) return res.status(400).json({ error: 'No valid photos were provided.' });
    res.status(201).json({ message: `${added} photo(s) added to "${event.title}".` });
  });

  app.delete('/api/events/:eventId/photos/:photoId', requireAuth, (req, res) => {
    const photoId = Number(req.params.photoId);
    const eventId = Number(req.params.eventId);
    const photo =
      Number.isInteger(photoId) &&
      db.prepare('SELECT * FROM event_photos WHERE id = ? AND event_id = ?').get(photoId, eventId);
    if (!photo) return res.status(404).json({ error: 'Photo not found' });

    const event = db.prepare('SELECT title, centre_id FROM events WHERE id = ?').get(eventId) || {};
    const ownPhoto = photo.uploaded_by === req.user.id;
    if (!ownPhoto && !H.canManageCentre(req.user, event.centre_id)) {
      return res.status(403).json({ error: 'You can only remove photos you uploaded.' });
    }

    db.prepare('DELETE FROM event_photos WHERE id = ?').run(photoId);
    removeIfUnused(photo.url);
    if (!ownPhoto) {
      H.logAction(req, 'event.photo_remove', {
        targetType: 'event', targetId: eventId, centreId: event.centre_id,
        summary: `Removed a member's photo from event "${event.title}"`,
        details: { photo_id: photoId, uploaded_by: photo.uploaded_by },
      });
    }
    res.json({ message: 'Photo removed.' });
  });

  // ---------- People Lookup (directory) ----------
  app.get('/api/directory', requireAuth, (req, res) => {
    const admin = isAdmin(req.user);
    const superAdmin = H.isSuper(req.user);
    const settings = getDirectorySettings();
    const { userFields, houseFields } = directoryFieldDefs();
    const hiddenUser = new Set(settings.hidden_user_fields);
    const hiddenHouse = new Set(settings.hidden_house_fields);

    // Hidden details are only shown to admins, and only for people/families in their own centres
    const managed = H.adminCentreIds(req.user);
    const managedSet = managed === null ? null : new Set(managed);
    const seesHiddenFor = (centreId) => admin && (managedSet === null || managedSet.has(Number(centreId)));

    const userCols = new Set(db.getSafeTableColumns('users'));
    const houseCols = new Set(db.prepare('PRAGMA table_info(houses)').all().map((c) => c.name));

    const userSelect = ['id', 'username', 'house_id', 'centre_id', 'access_level', ...userFields.map((f) => f.key)]
      .filter((c, i, arr) => userCols.has(c) && arr.indexOf(c) === i)
      .map((c) => `"${c}"`)
      .join(', ');
    const houseSelect = ['id', 'house_name', 'centre_id', ...houseFields.map((f) => f.key)]
      .filter((c, i, arr) => houseCols.has(c) && arr.indexOf(c) === i)
      .map((c) => `"${c}"`)
      .join(', ');

    const centres = new Map(db.prepare(`
      SELECT c.id, c.name, z.name AS zone_name, r.name AS region_name
      FROM centres c JOIN zones z ON z.id = c.zone_id JOIN regions r ON r.id = z.region_id
    `).all().map((c) => [c.id, c]));

    const people = db.prepare(`
      SELECT ${userSelect} FROM users WHERE status = 'approved' ORDER BY username COLLATE NOCASE ASC
    `).all().map((p) => {
      if (!seesHiddenFor(p.centre_id)) for (const key of hiddenUser) delete p[key];
      const c = centres.get(p.centre_id);
      p.centre_name = c ? c.name : '';
      p.role = H.LEVEL_NAMES[p.access_level] || '';
      delete p.access_level;
      return p;
    });
    const houses = db.prepare(`SELECT ${houseSelect} FROM houses ORDER BY house_name COLLATE NOCASE ASC`).all()
      .map((h) => {
        if (!seesHiddenFor(h.centre_id)) for (const key of hiddenHouse) delete h[key];
        const c = centres.get(h.centre_id);
        h.centre_name = c ? c.name : '';
        return h;
      });

    const houseById = new Map(houses.map((h) => [h.id, { ...h, members: [] }]));
    for (const p of people) {
      const h = houseById.get(p.house_id);
      p.house_name = h ? h.house_name : '';
      if (h) h.members.push({ id: p.id, username: p.username });
    }

    // Columns are listed if at least one row may show them
    const visibleUserFields = userFields.filter((f) => !hiddenUser.has(f.key) || admin);
    const visibleHouseFields = houseFields.filter((f) => !hiddenHouse.has(f.key) || admin);

    res.json({
      is_admin: admin,
      is_super: superAdmin,
      settings: superAdmin ? settings : undefined,
      hidden_user_fields: admin ? settings.hidden_user_fields : undefined,
      user_fields: visibleUserFields,
      house_fields: visibleHouseFields,
      all_user_fields: superAdmin ? userFields : undefined,
      all_house_fields: superAdmin ? houseFields : undefined,
      centres: Array.from(centres.values()).sort((a, b) => a.name.localeCompare(b.name)),
      my_centre_id: req.user.centre_id,
      people,
      houses: Array.from(houseById.values()),
    });
  });

  app.put('/api/directory/settings', requireAuth, requireSuper, (req, res) => {
    const { userFields, houseFields } = directoryFieldDefs();
    const userKeys = new Set(userFields.map((f) => f.key));
    const houseKeys = new Set(houseFields.map((f) => f.key));
    const body = req.body || {};

    const settings = {
      hidden_user_fields: (Array.isArray(body.hidden_user_fields) ? body.hidden_user_fields : [])
        .map(String)
        .filter((k) => userKeys.has(k)),
      hidden_house_fields: (Array.isArray(body.hidden_house_fields) ? body.hidden_house_fields : [])
        .map(String)
        .filter((k) => houseKeys.has(k)),
    };

    const before = getDirectorySettings();
    db.setSetting('directory', settings, req.user.id);
    H.logAction(req, 'site.directory_privacy', {
      targetType: 'site', summary: 'Changed which details members can see in People Lookup',
      details: { before, after: settings },
    });
    res.json({ message: 'People Lookup privacy settings saved.', settings });
  });

}

module.exports = {
  registerFeatureRoutes,
  isUploadUrl,
  makeFileRemover,
  isUrlStillUsed,
};
