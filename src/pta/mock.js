/**
 * 開発時のみ使うモックデータ (API 全滅時)。運用では MOCK_ALLOWED が false なので呼ばれない
 */
import { state } from './state.js';
import { showNotice } from './notice.js';
import { updateChart } from './chart.js';
import { renderDayHourHeatmap, renderOverallHeatmap } from './heatmaps.js';
import { updateSummaryCardsPartial } from './summary.js';

// Fallback logic for when API is unreachable due to CORS or local network issues
export function mockDataOnFailPartial() {
  console.log("Using Mock Data (1 Year)");
  showNotice('JENNIFERサーバに接続できませんでした。以下はモックデータによる表示です。実データではありません。', 'error');

  // Generate 365 days of mock data
  const mockDates = [];
  const startYearDate = new Date();
  startYearDate.setFullYear(startYearDate.getFullYear() - 1);

  for (let i = 0; i < 365; i++) {
    const d = new Date(startYearDate.getTime() + i * 24 * 3600000);
    const dateStr = d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
    mockDates.push(dateStr);
  }

  state.yearlyData['service_time'] = mockDates.map(d => ({ time: d, value: 3000 + Math.random() * 2000 }));
  state.yearlyData['service_rate'] = mockDates.map(d => ({ time: d, value: 2 + Math.random() * 5 }));
  state.yearlyData['concurrent_user'] = mockDates.map(d => ({ time: d, value: 100 + Math.random() * 200 }));
  state.yearlyData['service_count'] = mockDates.map(d => ({ time: d, value: 5000 + Math.random() * 15000 }));
  state.yearlyData['service_err_count'] = mockDates.map(d => ({ time: d, value: Math.random() * 500 }));
  state.yearlyData['sys_cpu'] = mockDates.map(d => ({ time: d, value: 10 + Math.random() * 25 }));
  state.yearlyData['max_sys_cpu'] = mockDates.map(d => ({ time: d, value: 40 + Math.random() * 50 }));
  state.yearlyData['heap_usage'] = mockDates.map(d => ({ time: d, value: 30 + Math.random() * 40 }));

  // Update main chart
  const activeBtn = document.querySelector(`.metric-btn[data-metric="${state.currentMetric}"]`);
  const metricDisplayName = activeBtn ? activeBtn.textContent : '応答時間';

  updateChart('mainChart', metricDisplayName, state.yearlyData[state.currentMetric], '#22c55e', state.mainChartInstance, (instance) => {
    state.mainChartInstance = instance;
  });
  updateSummaryCardsPartial(0, state.yearlyData['service_time'].length - 1);

  // Mock Heatmap Data (last 30 days)
  const heatmapMockData = [];
  const start = new Date();
  start.setDate(start.getDate() - 30);
  for (let i = 0; i < 30 * 24; i++) {
    const d = new Date(start.getTime() + i * 3600000);
    const timeStr = d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0') +
      String(d.getHours()).padStart(2, '0') + "00";
    const value = 50 + Math.random() * 400;
    heatmapMockData.push({
      time: timeStr,
      value: value,
      yValue: value,
      count: Math.floor(Math.random() * 1000)
    });
  }
  renderDayHourHeatmap(heatmapMockData, false, state.currentMetric);
  renderOverallHeatmap(heatmapMockData, false, state.currentMetric);
}
