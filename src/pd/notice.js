/**
 * 画面上部の通知バー
 */
import { el } from './dom.js';

export function showNotice(message, level = 'info') {
  if (!message) {
    el.notice.classList.add('hidden');
    return;
  }
  el.notice.textContent = message;
  el.notice.className = `notice notice-${level}`;
}
