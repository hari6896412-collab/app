// Shared helper for uploading photos & videos to /api/uploads.
// Usage: const { url, media_type } = await uploadMedia(file, { onProgress: (pct) => ... });
(function initUploads() {
  const ACCEPT_IMAGES = 'image/png,image/jpeg,image/gif,image/webp';
  const ACCEPT_VIDEOS = 'video/mp4,video/webm,video/quicktime,video/ogg';

  function uploadMedia(file, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const token = localStorage.getItem('token');
      if (!token) {
        reject(new Error('Please sign in again.'));
        return;
      }

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/uploads');
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');

      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }

      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
        if (xhr.status === 401) {
          localStorage.removeItem('token');
          reject(new Error('Your session expired. Please sign in again.'));
          return;
        }
        if (xhr.status >= 200 && xhr.status < 300 && data.url) {
          resolve(data);
        } else {
          reject(new Error(data.error || `Upload failed (${xhr.status})`));
        }
      };
      xhr.onerror = () => reject(new Error('Could not connect to server.'));
      xhr.send(file);
    });
  }

  window.uploadMedia = uploadMedia;
  window.MEDIA_ACCEPT = {
    images: ACCEPT_IMAGES,
    videos: ACCEPT_VIDEOS,
    all: `${ACCEPT_IMAGES},${ACCEPT_VIDEOS}`,
  };
})();
