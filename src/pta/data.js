/**
 * 1 年分の日次データの取得と、メインチャート・サマリ・ヒートマップの更新
 */
import { formatDateParam } from './lib/format.js';
import { startOfMonth } from '../shared/tz.js';
import { mergeSeries, computeErrRate } from './lib/series.js';
import { MOCK_ALLOWED } from './config.js';
import { getCurrentDomainId, state } from './state.js';
import { businessSelect, instanceSelect } from './dom.js';
import { showNotice } from './notice.js';
import { fetchMetricData } from './api.js';
import { updateChart } from './chart.js';
import { handleChartSelectionChanged } from './selection.js';
import { mockDataOnFailPartial } from './mock.js';

// 連続呼び出し時、最後に開始した読み込みのみが画面を更新するための世代番号
let loadDataSeq = 0;

export async function loadData() {
  const seq = ++loadDataSeq;
  const isStale = () => seq !== loadDataSeq;
  const loadingOverlay = document.getElementById('loadingOverlay');
  if (loadingOverlay) loadingOverlay.classList.remove('hidden');

  // Get domainId from hierarchical selector state
  const domainId = getCurrentDomainId();

  if (!domainId) {
    console.warn('No domain selected. Skipping loadData.');
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
    return;
  }

  // Get target type and ID
  const targetType = document.querySelector('input[name="targetType"]:checked')?.value || 'instance';
  const instanceId = instanceSelect.value;
  const businessId = businessSelect.value;

  const targetId = targetType === 'instance' ? instanceId : businessId;


  // Reset thresholds when a new primary search is performed
  state.metricThresholds = {};
  state.overallYThresholds = {};

  try {
    const today = new Date();

    // Main Chart & Summary Metrics: 1년을 12개의 단위로 (월별 분할) 조회 - 최대 31일 제한 우회 및 일별 데이터(1440분) 지정
    // sys_cpu/heap_usage/max_sys_cpu are instance-only metrics; skip fetching them for business targets
    const isInstanceTarget = targetType === 'instance';
    const instanceOnlyMetrics = ['sys_cpu', 'heap_usage', 'max_sys_cpu'];
    if (!isInstanceTarget) {
      instanceOnlyMetrics.forEach(m => { if (m !== state.currentMetric) state.yearlyData[m] = []; });
    }
    const metricsToFetch = Array.from(new Set([
      state.currentMetric, 'service_time', 'service_rate', 'concurrent_user', 'service_count', 'service_err_count',
      ...(isInstanceTarget ? instanceOnlyMetrics : [])
    ])).filter(m => m !== 'err_rate');
    const fetchPromisesMap = {};
    metricsToFetch.forEach(m => fetchPromisesMap[m] = []);
    let totalRequests = 0;
    let failedRequests = 0;

    for (let i = 11; i >= 0; i--) {
      // 月の境界はサーバ時間帯の暦で決める (ブラウザと時間帯が違うと「今月」が異なるため)
      const monthStart = startOfMonth(today, -i);
      // API end_time is exclusive, so use the 1st day of the next month instead of the 0th day (last day of current month)
      const monthEnd = startOfMonth(today, -i + 1);

      metricsToFetch.forEach(m => {
        totalRequests++;
        fetchPromisesMap[m].push(
          fetchMetricData(domainId, targetId, targetType, formatDateParam(monthStart), formatDateParam(monthEnd), 1440, m)
            .catch(err => {
              console.warn(`Failed to fetch partially for ${formatDateParam(monthStart)} metric ${m}`, err);
              failedRequests++;
              return [];
            })
        );
      });
    }

    const results = {};
    for (const m of metricsToFetch) {
      results[m] = await Promise.all(fetchPromisesMap[m]);
    }

    // 待っている間に別の読み込みが始まっていたら、古い結果は破棄する
    if (isStale()) return;

    // 失敗したリクエストがあれば画面で知らせる (月単位で欠けたまま気付かれないのを防ぐ)
    if (failedRequests === 0) {
      showNotice('');
    } else if (failedRequests === totalRequests) {
      if (MOCK_ALLOWED) {
        mockDataOnFailPartial();
        return;
      }
      showNotice('JENNIFERサーバからデータを取得できませんでした。ネットワークとAPIプロキシの設定をご確認ください。', 'error');
    } else {
      showNotice(
        `${failedRequests}/${totalRequests} 件のAPIリクエストが失敗しました。一部の期間のデータが欠けている可能性があります。`,
        'warn'
      );
    }

    // 병합 및 시간순 정렬 및 중복 제거
    metricsToFetch.forEach(m => {
      state.yearlyData[m] = mergeSeries(results[m]);
    });

    // Calculate Error Rate (err_rate)
    state.yearlyData['err_rate'] = computeErrRate(state.yearlyData['service_count'] || [], state.yearlyData['service_err_count'] || []);

    // Update UI Elements for Chart
    const activeBtn = document.querySelector(`.metric-btn[data-metric="${state.currentMetric}"]`);
    const metricDisplayName = activeBtn ? activeBtn.textContent : '応答時間';

    // Update main chart
    updateChart('mainChart', metricDisplayName, state.yearlyData[state.currentMetric], '#22c55e', state.mainChartInstance, (instance) => {
      state.mainChartInstance = instance;
    });

    // Reset selection state; handleChartSelectionChanged() below refreshes the range
    // display, summary cards, and heatmaps for the full 1-year view in one pass.
    state.selectedStartMonth = null;
    state.selectedEndMonth = null;
    await handleChartSelectionChanged();

  } catch (error) {
    console.error('Data loading failed:', error);
    if (MOCK_ALLOWED) {
      mockDataOnFailPartial();
    } else {
      showNotice('データの処理中にエラーが発生しました。', 'error');
    }
  } finally {
    if (loadingOverlay && !isStale()) loadingOverlay.classList.add('hidden');
  }
}
