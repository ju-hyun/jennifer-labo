/**
 * 画面上部の通知バーと、設定/認証エラーのオーバーレイ
 */

/** 画面上部の通知バーに表示する (message が空なら隠す) */
export function showNotice(message, level = 'info') {
  const bar = document.getElementById('noticeBar');
  if (!bar) return;
  if (!message) {
    bar.classList.add('hidden');
    return;
  }
  bar.textContent = message;
  bar.className = `notice notice-${level}`;
}

export function showConfigError(message, title = 'Configuration Error') {
  // 同時多発するリクエストが全て 401 になっても、オーバーレイは 1 つだけ表示する
  if (document.querySelector('.config-error-overlay') || showConfigError.pending) return;
  showConfigError.pending = true;

  const overlay = document.createElement('div');
  overlay.className = 'config-error-overlay';
  overlay.innerHTML = `
    <div class="config-error-content">
      <div class="config-error-icon">⚠️</div>
      <h2>${title}</h2>
      <p>${message}</p>
      <div class="config-error-box">
        <code>Please check <strong>pta/config.js</strong> and the server-side API proxy (token) settings.</code>
      </div>
    </div>
  `;
  // Ensure the overlay is shown after a tiny delay so the background content is rendered
  setTimeout(() => {
    document.body.appendChild(overlay);

    // Completely hide/remove loading overlay if it exists
    const loadingOverlay = document.getElementById('loadingOverlay');
    if (loadingOverlay) {
      loadingOverlay.style.opacity = '0';
      setTimeout(() => loadingOverlay.style.display = 'none', 300);
    }
  }, 50);
}
