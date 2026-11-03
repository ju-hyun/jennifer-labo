/**
 * 詳細スライドパネル
 *
 * ヒストグラムの棒をクリックすると、その応答時間区間に属するトランザクションを
 * 画面左からスライドインするオーバーレイで一覧表示する。
 * PTA の detail slide layer を踏襲。
 */

import { fmtInt } from './chart.js';
import { escapeHtml } from '../shared/html.js';

let overlayEl = null;
let panelEl = null;

export const MAX_ROWS = 200;

function ensureElements() {
  if (panelEl) return;

  overlayEl = document.createElement('div');
  overlayEl.className = 'detail-overlay hidden';
  overlayEl.addEventListener('click', () => closePanel());

  panelEl = document.createElement('div');
  panelEl.className = 'detail-panel hidden';
  panelEl.addEventListener('click', (e) => e.stopPropagation());

  document.body.appendChild(overlayEl);
  document.body.appendChild(panelEl);
}

function formatTime(ms) {
  if (!Number.isFinite(ms)) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * @param {object} params
 * @param {string} params.title      パネル見出し (例: "150 〜 175ms")
 * @param {string} params.subtitle   補足 (件数・比率など)
 * @param {object[]} params.rows     store.row(i) の配列
 * @param {number} params.totalCount 区間の総件数 (サンプル制限前)
 */
export function openPanel({ title, subtitle, rows, totalCount }) {
  ensureElements();

  const shown = rows.slice(0, MAX_ROWS);
  const maxRt = shown.reduce((m, r) => Math.max(m, r.responseTime), 0) || 1;

  const truncatedNote =
    totalCount > shown.length
      ? `<div class="detail-note">表示は応答時間の降順で上位 ${fmtInt(shown.length)} 件です (区間全体は ${fmtInt(totalCount)} 件)。</div>`
      : '';

  const rowsHtml = shown
    .map((r) => {
      const ratio = (r.responseTime / maxRt) * 100;
      const isError = r.errorType && r.errorType !== '';
      return `
        <tr class="${isError ? 'is-error' : ''}">
          <td class="col-time">${formatTime(r.startTime)}</td>
          <td class="col-app" title="${escapeHtml(r.applicationName)}">${escapeHtml(r.applicationName || '-')}</td>
          <td class="col-rt">
            <div class="rt-cell">
              <span class="rt-bar" style="width:${ratio.toFixed(1)}%"></span>
              <span class="rt-value">${fmtInt(r.responseTime)}</span>
            </div>
          </td>
          <td class="col-num">${fmtInt(r.cpuTime)}</td>
          <td class="col-num">${fmtInt(r.sqlTime)}</td>
          <td class="col-inst" title="${escapeHtml(r.instanceName)}">${escapeHtml(r.instanceName || '-')}</td>
          <td class="col-err">${isError ? escapeHtml(r.errorType) : ''}</td>
        </tr>`;
    })
    .join('');

  panelEl.innerHTML = `
    <div class="detail-header">
      <div>
        <h3>${escapeHtml(title)}</h3>
        <p class="detail-sub">${escapeHtml(subtitle)}</p>
      </div>
      <button type="button" class="detail-close" aria-label="閉じる">&times;</button>
    </div>
    ${truncatedNote}
    <div class="detail-body">
      <table class="detail-table">
        <thead>
          <tr>
            <th>時刻</th>
            <th>アプリケーション</th>
            <th>応答時間(ms)</th>
            <th>CPU</th>
            <th>SQL</th>
            <th>インスタンス</th>
            <th>エラー</th>
          </tr>
        </thead>
        <tbody>${rowsHtml || '<tr><td colspan="7" class="detail-empty">該当データがありません</td></tr>'}</tbody>
      </table>
    </div>`;

  panelEl.querySelector('.detail-close').addEventListener('click', () => closePanel());

  overlayEl.classList.remove('hidden');
  panelEl.classList.remove('hidden');
  requestAnimationFrame(() => {
    overlayEl.classList.add('is-open');
    panelEl.classList.add('is-open');
  });
  document.body.classList.add('panel-open');
}

export function closePanel() {
  if (!panelEl || panelEl.classList.contains('hidden')) return;
  overlayEl.classList.remove('is-open');
  panelEl.classList.remove('is-open');
  document.body.classList.remove('panel-open');
  setTimeout(() => {
    overlayEl.classList.add('hidden');
    panelEl.classList.add('hidden');
  }, 240);
}

export function isPanelOpen() {
  return !!panelEl && !panelEl.classList.contains('hidden');
}
