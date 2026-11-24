// Shared helpers for roles and centre pickers. Load before a page's own script.
(function initAccess() {
  const LEVEL_NAMES = { 0: 'Super Admin', 1: 'Region Admin', 2: 'Zone Admin', 3: 'Centre Admin', 4: 'User' };
  const token = localStorage.getItem('token');
  const raw = localStorage.getItem('access_level');
  const level = raw !== null ? Number(raw) : 4;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  let hierarchyPromise = null;

  function hierarchy(force = false) {
    if (!token) return Promise.resolve(null);
    if (!hierarchyPromise || force) {
      hierarchyPromise = fetch('/api/hierarchy', { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return hierarchyPromise;
  }

  // <option>s grouped as "Region › Zone"
  function centreOptionsHtml(centres, { selected = null, blank = '' } = {}) {
    const groups = new Map();
    for (const c of centres || []) {
      const key = `${c.region_name} › ${c.zone_name}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    let html = blank ? `<option value="">${esc(blank)}</option>` : '';
    for (const [label, list] of groups) {
      html += `<optgroup label="${esc(label)}">` +
        list.map((c) => `<option value="${c.id}" ${String(selected) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('') +
        '</optgroup>';
    }
    return html;
  }

  window.Access = {
    LEVEL_NAMES,
    token,
    level,
    isAdmin: Boolean(token) && level <= 3,
    isSuper: Boolean(token) && level === 0,
    centreId: localStorage.getItem('centre_id') ? Number(localStorage.getItem('centre_id')) : null,
    hierarchy,
    centreOptionsHtml,
    esc,
  };
})();
