/**
 * メインチャートの期間選択 (クリック/ドラッグ/キーボード) と、選択に応じた再描画
 */
import { formatYMDLocal, parseDateString } from './lib/format.js';
import { escapeHtml } from '../shared/html.js';
import { getCurrentDomainId, state } from './state.js';
import { businessSelect, instanceSelect } from './dom.js';
import { reloadHeatmaps } from './heatmaps.js';
import { updateSummaryCardsPartial } from './summary.js';

// キーボード操作で選択範囲が連続して変わるとき、API 再取得を最後の 1 回にまとめる
let selectionTimer = null;

function scheduleSelectionChanged(delay = 150) {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(handleChartSelectionChanged, delay);
}

// Selection Change Handler
export async function handleChartSelectionChanged() {
  const rangeDisplay = document.getElementById('selectedRangeDisplay');
  const domainId = getCurrentDomainId();

  const targetType = document.querySelector('input[name="targetType"]:checked')?.value || 'instance';
  const targetId = targetType === 'instance' ? instanceSelect.value : businessSelect.value;

  const currentMetricData = state.yearlyData[state.currentMetric] || [];
  let startIdx = -1;
  let endIdx = -1;

  if (!state.selectedStartMonth || !state.selectedEndMonth) {
    rangeDisplay.textContent = '全体 (1年)';
    // Reset to full data
    updateSummaryCardsPartial(0, currentMetricData.length - 1);

    // Fetch full data bounds from currentMetricData
    if (currentMetricData && currentMetricData.length > 0) {
      const startStr = currentMetricData[0].time;
      const endStr = currentMetricData[currentMetricData.length - 1].time;

      rangeDisplay.innerHTML = `${escapeHtml(formatYMDLocal(startStr))} <span style="color: var(--text-secondary); margin: 0 4px; font-weight: 500;">-</span> ${escapeHtml(formatYMDLocal(endStr))}`;

      const sYear = parseInt(startStr.substring(0, 4), 10);
      const sMonth = parseInt(startStr.substring(4, 6), 10) - 1;
      const sDay = parseInt(startStr.substring(6, 8), 10);

      const eYear = parseInt(endStr.substring(0, 4), 10);
      const eMonth = parseInt(endStr.substring(4, 6), 10) - 1;
      const eDay = parseInt(endStr.substring(6, 8), 10);

      const exactStartDate = new Date(sYear, sMonth, sDay);
      const exactEndDate = new Date(eYear, eMonth, eDay);

      await reloadHeatmaps(domainId, targetId, targetType, exactStartDate, exactEndDate);
    }
    return;
  }

  // Because state.selectedStartMonth/EndMonth could be out of order in the UI drag (already sorted in plugin)
  const tStartMonth = state.selectedStartMonth;
  const tEndMonth = state.selectedEndMonth;

  // Use the already declared currentMetricData

  // Find first occurrence of start month
  const labels = currentMetricData.map(item => parseDateString(item.time));

  // Find first occurrence of start month
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].startsWith(tStartMonth + '/')) {
      startIdx = i;
      break;
    }
  }

  // Find last occurrence of end month
  for (let i = labels.length - 1; i >= 0; i--) {
    if (labels[i].startsWith(tEndMonth + '/')) {
      endIdx = i;
      break;
    }
  }

  if (startIdx !== -1 && endIdx !== -1) {
    if (startIdx > endIdx) {
      const temp = startIdx;
      startIdx = endIdx;
      endIdx = temp;
    }

    // 1. Update Display Text
    const startStr = currentMetricData[startIdx].time.substring(0, 8); // yyyymmdd
    const endStr = currentMetricData[endIdx].time.substring(0, 8);

    rangeDisplay.innerHTML = `${escapeHtml(formatYMDLocal(startStr))} <span style="color: var(--text-secondary); margin: 0 4px; font-weight: 500;">-</span> ${escapeHtml(formatYMDLocal(endStr))}`;

    // 2. Filter data for Summary Cards
    updateSummaryCardsPartial(startIdx, endIdx);

    // 3. Reload Heatmaps with Precise Date Range
    // Create actual Date objects for the start and end of the exact data bounds
    const sYear = parseInt(startStr.substring(0, 4), 10);
    const sMonth = parseInt(startStr.substring(4, 6), 10) - 1;
    const sDay = parseInt(startStr.substring(6, 8), 10);

    const eYear = parseInt(endStr.substring(0, 4), 10);
    const eMonth = parseInt(endStr.substring(4, 6), 10) - 1;
    const eDay = parseInt(endStr.substring(6, 8), 10);

    const exactStartDate = new Date(sYear, sMonth, sDay);
    const exactEndDate = new Date(eYear, eMonth, eDay);

    await reloadHeatmaps(domainId, targetId, targetType, exactStartDate, exactEndDate);
  }
}

/** 矢印キー / Esc による選択範囲の操作を有効にする */
export function initKeyboardNavigation() {
  // Keyboard Navigation for Chart Selection
  window.addEventListener('keydown', (e) => {
    // Handle ESC key to deselect or close help
    // Handle ESC key to deselect
    if (e.key === 'Escape') {
      if (state.selectedStartMonth || state.selectedEndMonth) {
        state.selectedStartMonth = null;
        state.selectedEndMonth = null;
        handleChartSelectionChanged();
        if (state.mainChartInstance) state.mainChartInstance.update();
      }
      return;
    }

    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    // 入力欄・セレクトボックスの操作や修飾キー付きの操作は奪わない
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (!state.mainChartInstance || !state.selectedStartMonth || !state.selectedEndMonth) return;

    const labels = state.mainChartInstance.data.labels;
    if (!labels || labels.length === 0) return;

    // Get unique months in order
    const uniqueMonths = [];
    labels.forEach(lbl => {
      const m = lbl.split('/')[0];
      if (!uniqueMonths.includes(m)) uniqueMonths.push(m);
    });

    let startIdx = uniqueMonths.indexOf(state.selectedStartMonth);
    let endIdx = uniqueMonths.indexOf(state.selectedEndMonth);

    if (startIdx === -1 || endIdx === -1) return;

    // Swap if needed to ensure normalized range
    if (startIdx > endIdx) {
      [startIdx, endIdx] = [endIdx, startIdx];
    }

    const shift = e.key === 'ArrowLeft' ? -1 : 1;

    if (e.shiftKey) {
      if (e.key === 'ArrowLeft') {
        if (state.activeSelectionBoundary === 'start') {
          const newStartIdx = startIdx - 1;
          if (newStartIdx >= 0) {
            state.selectedStartMonth = uniqueMonths[newStartIdx];
          } else return;
        } else {
          // state.activeSelectionBoundary === 'end'
          if (startIdx === endIdx) {
            // Switch to start and move left
            const newStartIdx = startIdx - 1;
            if (newStartIdx >= 0) {
              state.selectedStartMonth = uniqueMonths[newStartIdx];
              state.activeSelectionBoundary = 'start';
            } else return;
          } else {
            const newEndIdx = endIdx - 1;
            state.selectedEndMonth = uniqueMonths[newEndIdx];
          }
        }
      } else {
        // ArrowRight
        if (state.activeSelectionBoundary === 'end') {
          const newEndIdx = endIdx + 1;
          if (newEndIdx < uniqueMonths.length) {
            state.selectedEndMonth = uniqueMonths[newEndIdx];
          } else return;
        } else {
          // state.activeSelectionBoundary === 'start'
          if (startIdx === endIdx) {
            // Switch to end and move right
            const newEndIdx = endIdx + 1;
            if (newEndIdx < uniqueMonths.length) {
              state.selectedEndMonth = uniqueMonths[newEndIdx];
              state.activeSelectionBoundary = 'end';
            } else return;
          } else {
            const newStartIdx = startIdx + 1;
            state.selectedStartMonth = uniqueMonths[newStartIdx];
          }
        }
      }
      scheduleSelectionChanged();
      state.mainChartInstance.update();
    } else {
      // Shift the entire range
      const newStartIdx = startIdx + shift;
      const newEndIdx = endIdx + shift;
      if (newStartIdx >= 0 && newEndIdx < uniqueMonths.length) {
        state.selectedStartMonth = uniqueMonths[newStartIdx];
        state.selectedEndMonth = uniqueMonths[newEndIdx];
        scheduleSelectionChanged();
        state.mainChartInstance.update();
      }
    }
  });
}
