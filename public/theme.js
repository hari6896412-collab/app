// Site-wide theme from the Style Centre.
// Include in <head> of every page: <script src="/theme.js"></script>
(function initSiteTheme() {
  const CACHE_KEY = 'site_theme_v1';

  const DEFAULTS = {
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

  function merge(theme) {
    const t = theme && typeof theme === 'object' ? theme : {};
    return {
      ...DEFAULTS,
      ...t,
      colors: { ...DEFAULTS.colors, ...(t.colors || {}) },
      background: t.background || DEFAULTS.background,
      pageBackgrounds: t.pageBackgrounds || {},
    };
  }

  function hexToRgba(hex, alpha) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    if (!m) return `rgba(0,0,0,${alpha})`;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
  }

  function cssUrl(url) {
    return `url(${JSON.stringify(String(url || ''))})`;
  }

  function isYouTube(url) {
    return /^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(String(url || ''));
  }

  // Fill `container` with the layers for a background object.
  // Used for the site background and for About-page sections.
  function renderBackground(container, bg, { fixedLayer = false } = {}) {
    container.innerHTML = '';
    if (!bg || bg.type === 'none' || bg.type === 'default') return false;

    const layer = document.createElement('div');
    layer.className = 'bg-layer';
    layer.style.cssText = 'position:absolute;inset:0;background-position:center;background-size:cover;background-repeat:no-repeat;';

    if (bg.blur) {
      layer.style.filter = `blur(${Number(bg.blur)}px)`;
      layer.style.inset = `-${Number(bg.blur) * 2}px`;
    }

    if (bg.type === 'color') {
      layer.style.background = bg.color;
    } else if (bg.type === 'gradient') {
      layer.style.background = `linear-gradient(${Number(bg.angle) || 135}deg, ${bg.color} 0%, ${bg.color2} 100%)`;
    } else if (bg.type === 'image' && bg.url) {
      layer.style.backgroundImage = cssUrl(bg.url);
      if (bg.fixed && !fixedLayer) layer.style.backgroundAttachment = 'fixed';
    } else if (bg.type === 'video' && bg.url) {
      const video = document.createElement('video');
      video.src = bg.url;
      if (bg.poster) video.poster = bg.poster;
      video.autoplay = true;
      video.muted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute('playsinline', '');
      video.setAttribute('muted', '');
      video.setAttribute('aria-hidden', 'true');
      video.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;';
      layer.appendChild(video);
      // Some browsers need an explicit play() for muted autoplay
      setTimeout(() => video.play && video.play().catch(() => {}), 0);
    } else {
      return false;
    }

    container.appendChild(layer);

    if (Number(bg.overlay) > 0) {
      const overlay = document.createElement('div');
      overlay.className = 'bg-overlay';
      overlay.style.cssText = `position:absolute;inset:0;background:${hexToRgba(bg.overlayColor || '#000000', Number(bg.overlay) / 100)};`;
      container.appendChild(overlay);
    }
    return true;
  }

  function sameColors(a, b) {
    return Object.keys(b).every((k) => String(a[k]).toLowerCase() === String(b[k]).toLowerCase());
  }

  function pageKey() {
    const p = window.location.pathname;
    return p === '/about' ? '/' : p;
  }

  function buildCss(t) {
    const c = t.colors;
    const css = [];
    const colorsChanged = !sameColors(c, DEFAULTS.colors);

    if (t.fontBody !== DEFAULTS.fontBody) {
      css.push(`*, input, select, textarea { font-family: '${t.fontBody}', 'Inter', system-ui, sans-serif; }`);
    }
    if (t.fontHeading !== DEFAULTS.fontHeading || t.fontBody !== DEFAULTS.fontBody) {
      css.push(`h1, h2, h3, button, .brand-link h1 { font-family: '${t.fontHeading}', '${t.fontBody}', sans-serif; }`);
    }

    if (colorsChanged) {
      css.push(`
        body {
          background-image:
            radial-gradient(ellipse 80% 45% at 50% -10%, ${hexToRgba(c.accent, 0.14)}, transparent 65%),
            radial-gradient(ellipse 55% 40% at 95% 10%, ${hexToRgba(c.primary, 0.08)}, transparent 60%);
        }
        .center-page {
          background-image:
            radial-gradient(circle at 82% 16%, ${hexToRgba(c.accent, 0.22)}, transparent 44%),
            radial-gradient(circle at 14% 84%, ${hexToRgba(c.primary, 0.18)}, transparent 48%);
        }
        .card { border-top-color: ${c.primary}; }
        .section { border-top-color: ${hexToRgba(c.accent, 0.32)}; }
      `);
    }

    // Header
    if (t.headerStyle === 'solid') {
      css.push(`header, header.has-kebab { background: ${c.primary}; background-image: none; }`);
    } else if (t.headerStyle === 'glass') {
      css.push(`header, header.has-kebab { background: ${hexToRgba(c.primaryDark, 0.62)}; background-image: none;
        -webkit-backdrop-filter: blur(16px) saturate(140%); backdrop-filter: blur(16px) saturate(140%); }`);
    } else if (t.headerStyle === 'dark') {
      css.push(`header, header.has-kebab { background: #15110f; background-image: none; border-bottom-color: rgba(255,255,255,0.08); }`);
    } else if (colorsChanged) {
      css.push(`header, header.has-kebab { background-image:
        radial-gradient(ellipse 45% 130% at 88% 0%, rgba(255,255,255,0.16), transparent 60%), var(--brand-gradient); }`);
    }

    // Cards
    if (t.cardStyle === 'glass' || Number(t.cardOpacity) < 100) {
      const a = Math.max(0.4, Math.min(1, Number(t.cardOpacity) / 100));
      const blur = t.cardStyle === 'glass' ? '-webkit-backdrop-filter: blur(14px) saturate(130%); backdrop-filter: blur(14px) saturate(130%);' : '';
      css.push(`.card, .section, .event-card, .report-card, .about-card {
        background: rgba(255, 255, 255, ${a}) !important; ${blur}
        ${t.cardStyle === 'glass' ? 'border-color: rgba(255,255,255,0.55);' : ''} }`);
    }

    // Site background: hide the stylesheet gradient when a custom layer is shown
    const bg = t.pageBackgrounds[pageKey()] || t.background;
    if (bg && bg.type && bg.type !== 'default' && bg.type !== 'none') {
      css.push(`body, .center-page { background: transparent !important; }
        html { background: ${c.canvas}; }
        #site-bg { position: fixed; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; }`);
    }

    if (t.customCss) css.push(t.customCss);
    return css.join('\n');
  }

  function loadFonts(t) {
    const families = Array.from(new Set([t.fontBody, t.fontHeading]))
      .filter((f) => f && !['Inter', 'Plus Jakarta Sans'].includes(f));
    let link = document.getElementById('site-theme-fonts');
    if (families.length === 0) {
      if (link) link.remove();
      return;
    }
    const href = 'https://fonts.googleapis.com/css2?' +
      families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;600;700;800`).join('&') +
      '&display=swap';
    if (!link) {
      link = document.createElement('link');
      link.id = 'site-theme-fonts';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }

  let lastBgKey = null;

  function applyBackgroundLayer(t) {
    const bg = t.pageBackgrounds[pageKey()] || t.background;
    const key = JSON.stringify(bg || null);
    if (key === lastBgKey && document.getElementById('site-bg')) return;
    lastBgKey = key;

    let holder = document.getElementById('site-bg');
    if (!bg || bg.type === 'default' || bg.type === 'none') {
      if (holder) holder.remove();
      return;
    }
    if (!holder) {
      holder = document.createElement('div');
      holder.id = 'site-bg';
      holder.setAttribute('aria-hidden', 'true');
      document.body.prepend(holder);
    }
    renderBackground(holder, bg, { fixedLayer: true });
  }

  function apply(rawTheme, { persist = false } = {}) {
    const t = merge(rawTheme);
    const root = document.documentElement.style;
    const c = t.colors;
    const r = Number(t.radius);

    root.setProperty('--primary', c.primary);
    root.setProperty('--primary-dark', c.primaryDark);
    root.setProperty('--accent', c.accent);
    root.setProperty('--accent-bright', c.accent);
    root.setProperty('--red', c.primary);
    root.setProperty('--orange', c.accent);
    root.setProperty('--lavender', c.accent);
    root.setProperty('--blue', c.accent);
    root.setProperty('--ink', c.ink);
    root.setProperty('--cream', c.canvas);
    root.setProperty('--brand-gradient', `linear-gradient(135deg, ${c.primaryDark} 0%, ${c.primary} 42%, ${c.accent} 100%)`);
    root.setProperty('--brand-gradient-hover', `linear-gradient(135deg, ${c.primaryDark} 0%, ${c.accent} 60%, ${c.accent} 100%)`);
    root.setProperty('--radius-lg', `${r}px`);
    root.setProperty('--radius-md', `${Math.round(r * 0.75)}px`);
    root.setProperty('--radius-sm', `${Math.round(r * 0.5)}px`);

    let style = document.getElementById('site-theme-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'site-theme-style';
      document.head.appendChild(style);
    }
    style.textContent = buildCss(t);
    loadFonts(t);

    if (document.body) {
      applyBackgroundLayer(t);
    } else {
      document.addEventListener('DOMContentLoaded', () => applyBackgroundLayer(t), { once: true });
    }

    window.SiteTheme.current = t;
    if (persist) {
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(t)); } catch {}
    }
    document.dispatchEvent(new CustomEvent('sitetheme', { detail: t }));
    return t;
  }

  async function refresh() {
    try {
      const res = await fetch('/api/theme', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const fresh = merge(data.theme);
      const cached = window.SiteTheme.current;
      if (JSON.stringify(fresh) !== JSON.stringify(cached)) {
        apply(fresh, { persist: true });
      } else {
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(fresh)); } catch {}
      }
    } catch {}
  }

  window.SiteTheme = {
    current: merge(null),
    defaults: DEFAULTS,
    apply,
    refresh,
    renderBackground,
    isYouTube,
    hexToRgba,
    previewMode: false,
  };

  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch {}
  apply(cached || DEFAULTS);
  refresh();
})();
