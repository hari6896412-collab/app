// Simple shared photo/video viewer.
// openLightbox([{ type: 'image'|'video', url, caption }], startIndex)
(function initLightbox() {
  let items = [];
  let index = 0;
  let el = null;

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render() {
    const item = items[index];
    if (!item) return;
    const media = item.type === 'video'
      ? `<video src="${esc(item.url)}" controls autoplay playsinline></video>`
      : `<img src="${esc(item.url)}" alt="${esc(item.caption || 'Photo')}" />`;
    const nav = items.length > 1
      ? `<button type="button" class="lightbox-btn lightbox-prev" aria-label="Previous">‹</button>
         <button type="button" class="lightbox-btn lightbox-next" aria-label="Next">›</button>`
      : '';
    const counter = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    const caption = [item.caption, counter].filter(Boolean).map(esc).join(' · ');
    el.innerHTML = `
      <button type="button" class="lightbox-btn lightbox-close" aria-label="Close">✕</button>
      ${nav}
      <figure>${media}${caption ? `<figcaption>${caption}</figcaption>` : ''}</figure>
    `;
  }

  function close() {
    if (el) el.remove();
    el = null;
    document.removeEventListener('keydown', onKey);
  }

  function step(dir) {
    index = (index + dir + items.length) % items.length;
    render();
  }

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  }

  window.openLightbox = function openLightbox(list, start = 0) {
    items = (list || []).filter((i) => i && i.url && (i.type === 'image' || i.type === 'video'));
    if (!items.length) return;
    index = Math.max(0, Math.min(items.length - 1, start));
    close();
    el = document.createElement('div');
    el.className = 'lightbox';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.addEventListener('click', (e) => {
      if (e.target === el || e.target.closest('.lightbox-close')) close();
      else if (e.target.closest('.lightbox-prev')) step(-1);
      else if (e.target.closest('.lightbox-next')) step(1);
    });
    document.body.appendChild(el);
    document.addEventListener('keydown', onKey);
    render();
  };
})();
