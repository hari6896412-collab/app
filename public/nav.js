(function initTopMenu() {
  const header = document.querySelector('header');
  if (!header) return;

  const token = localStorage.getItem('token');
  const accessLevel = Number(localStorage.getItem('access_level'));
  const username = localStorage.getItem('username') || 'User';
  const currentPath = window.location.pathname;

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  const menuItems = token
    ? [
        { href: '/dashboard.html', label: 'Dashboard' },
        { href: '/events.html', label: 'Events' },
        { href: '/funds.html', label: 'Funds' },
        { href: '/reports.html', label: 'Reports' },
        { href: '/major-donations.html', label: '₹10,000+ Donations' },
        ...(accessLevel === 1
          ? [{ href: '/upload-event.html', label: '+ Upload Event', extraClass: 'menu-item-admin' }]
          : []),
      ]
    : [
        { href: '/funds.html', label: 'Funds' },
        { href: '/index.html', label: 'Sign In' },
        { href: '/signup.html', label: 'Sign Up', extraClass: 'menu-item-admin' },
      ];

  const linksHtml = menuItems
    .map((item) => {
      const isActive =
        currentPath === item.href ||
        (currentPath === '/' && item.href === '/index.html');
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

  const userPillHtml = token
    ? `<span class="user-pill">${escapeHtml(username)} · L${accessLevel}</span>`
    : '';

  header.classList.add('has-kebab');
  header.innerHTML = `
    <a href="${token ? '/dashboard.html' : '/index.html'}" class="brand-link">
      <h1>Account Hub</h1>
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
    if (!e.target.closest('.kebab-wrap')) {
      closeMenu();
    }
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