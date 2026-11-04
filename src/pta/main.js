/**
 * Performance Trend Analysis (PTA) のエントリポイント。
 * 初期化とイベントの束ねのみを担当し、処理は各モジュールに委譲する。
 */
import './config.js'; // TIMEZONE の設定を、他のモジュールが時刻を扱う前に反映する
import { parseDateString } from './lib/format.js';
import { getCurrentDomainId, state } from './state.js';
import { btnHeapUsage, btnSysCpu, businessFilterArea, businessSelect, instanceFilterArea, instanceSelect, typeRadios } from './dom.js';
import { fetchBusinesses, loadDomains } from './targets.js';
import { loadData } from './data.js';
import { updateChart, updateChartStatsGrid } from './chart.js';
import { handleChartSelectionChanged, initKeyboardNavigation } from './selection.js';
import { initDetailLayers } from './heatmaps.js';
import { updateSummaryCardsDisabledState } from './summary.js';
import { initHelpSystem } from './help.js';

// 矢印キー / Esc による期間選択の操作 (従来どおりモジュール読み込み時に有効にする)
initKeyboardNavigation();

document.addEventListener('DOMContentLoaded', async () => {
  // 詳細レイヤ (スライドイン) の閉じる操作
  initDetailLayers();

  // config.js が無くても既定値 (同一オリジンの /api) で動作するため、起動はブロックしない
  if (!window.PTA_CONFIG) {
    console.warn('PTA_CONFIG が未設定です。pta/config.js が index.html と同じ場所に配置されているか確認してください。');
  }

  // Initial load: Load domains first, then data
  await loadDomains();

  // If a configuration/auth error was already shown by loadDomains, stop here
  if (document.querySelector('.config-error-overlay')) return;

  // 初回のデータ読み込みは loadDomains() 内の updateSelectedPath() -> loadInstances().then(loadData)
  // で行われる (ドメイン取得失敗時のモックドメインも同経路)。ここで loadData() を重ねて呼ぶと
  // 約 100 件の API リクエストが二重に発行されるため呼ばない。

  // Target Type Toggle
  typeRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
      const type = e.target.value;
      if (type === 'instance') {
        instanceFilterArea.classList.remove('hidden');
        businessFilterArea.classList.add('hidden');
      } else {
        instanceFilterArea.classList.add('hidden');
        businessFilterArea.classList.remove('hidden');
        const domainId = getCurrentDomainId();
        if (domainId) fetchBusinesses(domainId);
      }
      loadData();
    });
  });

  // Business Selection Change
  businessSelect.addEventListener('change', () => {
    loadData();
  });

  // Bind metric toggle buttons
  document.querySelectorAll('.metric-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Prevent clicking if any details layer is currently displayed
      const overallLayer = document.getElementById('overallDetailLayer');
      const dayHourLayer = document.getElementById('dayHourDetailLayer');
      if ((overallLayer && overallLayer.classList.contains('open')) ||
        (dayHourLayer && dayHourLayer.classList.contains('open'))) {
        return;
      }

      document.querySelectorAll('.metric-btn').forEach(b => b.classList.remove('active'));
      const targetBtn = e.currentTarget;
      targetBtn.classList.add('active');
      state.currentMetric = targetBtn.dataset.metric;

      const metricData = state.yearlyData[state.currentMetric];
      if (metricData && metricData.length > 0) {
        const metricDisplayName = targetBtn.textContent;
        updateChart('mainChart', metricDisplayName, metricData, '#22c55e', state.mainChartInstance, (instance) => {
          state.mainChartInstance = instance;
        });

        // Update summary cards for the selected range if exists
        handleChartSelectionChanged();
      }
    });
  });

  instanceSelect.addEventListener('change', () => {
    const isInstanceSelected = !!instanceSelect.value;
    if (isInstanceSelected) {
      btnSysCpu.classList.remove('hidden');
      btnHeapUsage.classList.remove('hidden');
    } else {
      btnSysCpu.classList.add('hidden');
      btnHeapUsage.classList.add('hidden');

      // If active metric is hidden, switch to response time
      if (state.currentMetric === 'sys_cpu' || state.currentMetric === 'heap_usage') {
        const defaultBtn = document.querySelector('.metric-btn[data-metric="service_time"]');
        if (defaultBtn) defaultBtn.click();
      }
    }
    updateSummaryCardsDisabledState();
    loadData(); // Auto-fetch data when instance changes
  });

  // Bind chart type toggles
  document.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
      const targetBtn = e.currentTarget;
      targetBtn.classList.add('active');
      state.currentChartType = targetBtn.dataset.type;

      const metricData = state.yearlyData[state.currentMetric];
      if (metricData && metricData.length > 0) {
        const metricDisplayName = document.querySelector(`.metric-btn[data-metric="${state.currentMetric}"]`).textContent;
        updateChart('mainChart', metricDisplayName, metricData, '#22c55e', state.mainChartInstance, (instance) => {
          state.mainChartInstance = instance;
        });
      }
    });
  });

  // Bind MA toggle buttons
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      const targetBtn = e.currentTarget;
      targetBtn.classList.add('active');
      state.showMA = targetBtn.dataset.ma === 'on';

      // Refresh chart with current metric
      const activeBtn = document.querySelector('.metric-btn.active');
      if (activeBtn) activeBtn.click();
    });
  });

  // Bind resize event to re-align stats
  window.addEventListener('resize', () => {
    const curMetricData = state.yearlyData[state.currentMetric] || [];
    if (state.mainChartInstance && curMetricData.length > 0) {
      const labels = curMetricData.map(item => parseDateString(item.time));
      updateChartStatsGrid(labels, state.mainChartInstance);
    }
  });

  // Help System Logic
  initHelpSystem();
});
