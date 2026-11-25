(function initTopMenu() {
  const header = document.querySelector('header');
  if (!header) return;

  // Accounts signed in before the centre hierarchy existed must sign in again
  if (localStorage.getItem('token') && localStorage.getItem('auth_v') !== '2') {
    localStorage.clear();
    window.location.href = '/index.html?relogin=1';
    return;
  }

  const LEVEL_NAMES = { 0: 'Super Admin', 1: 'Region Admin', 2: 'Zone Admin', 3: 'Centre Admin', 4: 'User' };
  const token = localStorage.getItem('token');
  const rawLevel = localStorage.getItem('access_level');
  const accessLevel = rawLevel !== null ? Number(rawLevel) : 4;
  const username = localStorage.getItem('username') || 'User';
  const loginId = localStorage.getItem('login_id');
  const currentPath = window.location.pathname;
  const isAdmin = Boolean(token && accessLevel <= 3);
  const isSuper = Boolean(token && accessLevel === 0);

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const menuItems = token
    ? [
        { href: '/', label: 'About' },
        { href: '/dashboard.html', label: 'Dashboard' },
        { href: '/events.html', label: 'Events' },
        { href: '/gallery.html', label: 'Gallery' },
        { href: '/people.html', label: 'People Lookup' },
        { href: '/funds.html', label: 'Funds' },
        { href: '/reports.html', label: 'Reports' },
        { href: '/major-donations.html', label: 'Major Donations' },
        ...(isAdmin
          ? [
              { href: '/houses.html', label: 'Houses & Donor Lookup' },
              { href: '/census.html', label: 'Census' },
              { href: '/centres.html', label: 'Centres', extraClass: 'menu-item-admin' },
              { href: '/admin-db.html', label: 'Database Control', extraClass: 'menu-item-admin' },
              // Logs show subordinate admins' actions, so Centre Admins (who have none) don't get this page
              ...(accessLevel <= 2 ? [{ href: '/admin-logs.html', label: 'Admin Log', extraClass: 'menu-item-admin' }] : []),
              ...(isSuper ? [{ href: '/style-centre.html', label: 'Style Centre', extraClass: 'menu-item-admin' }] : []),
              { href: '/upload-event.html', label: '+ Upload Event', extraClass: 'menu-item-admin' },
            ]
          : []),
      ]
    : [
        { href: '/', label: 'About' },
        { href: '/index.html', label: 'Sign In' },
        { href: '/signup.html', label: 'Sign Up', extraClass: 'menu-item-admin' },
      ];

  const linksHtml = menuItems
    .map((item) => {
      const isActive =
        currentPath === item.href ||
        (currentPath === '/about' && item.href === '/');
      const classes = ['menu-item', item.extraClass || '', isActive ? 'active' : '']
        .filter(Boolean)
        .join(' ');
      return `<a href="${item.href}" class="${classes}">${item.label}</a>`;
    })
    .join('');

  const logoutHtml = token
    ? `<div class="menu-divider"></div>
       <button type="button" class="menu-item menu-item-logout" id="kebabLogoutBtn">Logout</button>`
    : '';

  const idPart = loginId ? `#${escapeHtml(loginId)} · ` : '';
  const userPillHtml = token
    ? `<span class="user-pill" title="${escapeHtml(localStorage.getItem('role_label') || '')}">${idPart}${escapeHtml(username)} · ${escapeHtml(LEVEL_NAMES[accessLevel] || 'L' + accessLevel)}</span>`
    : '';

  function brandHtml() {
    const theme = (window.SiteTheme && window.SiteTheme.current) || {};
    const name = escapeHtml(theme.siteName || 'GSB ONLINE');
    const logo = theme.logoUrl
      ? `<img src="${escapeHtml(theme.logoUrl)}" alt="" class="brand-logo" />`
      : '';
    return `${logo}<h1>${name}</h1>`;
  }

  header.classList.add('has-kebab');
  header.innerHTML = `
    <a href="/" class="brand-link" id="brandLink">
      ${brandHtml()}
    </a>

    <div class="header-right">
      ${userPillHtml}
      <div class="kebab-wrap">
        <button
          type="button"
          class="kebab-btn"
          id="kebabToggleBtn"
          aria-label="Open navigation menu"
          aria-haspopup="true"
          aria-expanded="false"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="5" r="2.6"></circle>
            <circle cx="12" cy="12" r="2.6"></circle>
            <circle cx="12" cy="19" r="2.6"></circle>
          </svg>
        </button>

        <nav class="kebab-menu" id="kebabMenu" aria-label="Main navigation">
          ${linksHtml}
          ${logoutHtml}
        </nav>
      </div>
    </div>
  `;

  document.addEventListener('sitetheme', () => {
    const link = document.getElementById('brandLink');
    if (link) link.innerHTML = brandHtml();
  });

  const toggleBtn = document.getElementById('kebabToggleBtn');
  const menu = document.getElementById('kebabMenu');
  const logoutBtn = document.getElementById('kebabLogoutBtn');

  function closeMenu() {
    menu.classList.remove('open');
    toggleBtn.setAttribute('aria-expanded', 'false');
  }

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.classList.toggle('open');
    toggleBtn.setAttribute('aria-expanded', String(isOpen));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.kebab-wrap')) closeMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.clear();
      window.location.href = '/index.html';
    });
  }
})();