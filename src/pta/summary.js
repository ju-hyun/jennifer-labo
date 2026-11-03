/**
 * サマリカード (平均応答時間・TPS など) の表示
 */
import { toYMD } from './lib/format.js';
import { summarizeRange } from './lib/series.js';
import { state } from './state.js';
import { businessSelect, instanceSelect } from './dom.js';

export function updateSummaryCardsDisabledState() {
  const targetType = document.querySelector('input[name="targetType"]:checked')?.value || 'instance';
  const instanceId = instanceSelect.value;
  const businessId = businessSelect.value;

  const isTargetSelected = targetType === 'instance' ? !!instanceId : !!businessId;
  const cpuCard = document.getElementById('avgSysCpu')?.closest('.summary-card');
  const memCard = document.getElementById('avgHeapUsage')?.closest('.summary-card');

  if (cpuCard && memCard) {
    // CPU/Memory are instance-only metrics
    if (targetType === 'instance' && isTargetSelected) {
      cpuCard.classList.remove('disabled');
      memCard.classList.remove('disabled');
    } else {
      cpuCard.classList.add('disabled');
      memCard.classList.add('disabled');
    }
  }
}

export function updateSummaryCardsPartial(startIdx, endIdx) {
  const summary = summarizeRange(state.yearlyData, startIdx, endIdx, { metric: state.currentMetric, todayStr: toYMD(new Date()) });
  if (!summary) {
    document.getElementById('peakDate').textContent = '-';
    document.getElementById('avgResponseTime').innerHTML = `0 <span class="unit">ms</span>`;
    document.getElementById('avgTps').textContent = '0';
    document.getElementById('avgConcurrentUsers').textContent = '0';
    document.getElementById('avgHits').textContent = '0';
    return;
  }

  const fixed2 = { minimumFractionDigits: 2, maximumFractionDigits: 2 };
  document.getElementById('peakDate').textContent = summary.peakDate ?? '-';
  document.getElementById('avgResponseTime').innerHTML = `${Math.round(summary.avgResponseTime).toLocaleString()} <span class="unit">ms</span>`;
  document.getElementById('avgTps').textContent = summary.avgTps.toLocaleString(undefined, fixed2);
  document.getElementById('avgConcurrentUsers').textContent = Math.round(summary.avgConcurrentUsers).toLocaleString();
  document.getElementById('avgHits').textContent = Math.round(summary.avgHits).toLocaleString();
  const isInstanceSelected = !!(document.getElementById('instanceSelect').value);
  document.getElementById('avgErrRate').textContent = `${summary.avgErrRate.toLocaleString(undefined, fixed2)}%`;
  document.getElementById('avgSysCpu').textContent = isInstanceSelected ? `${Math.round(summary.avgSysCpu)}%` : '-';
  document.getElementById('avgHeapUsage').textContent = isInstanceSelected ? `${Math.round(summary.avgHeapUsage)}%` : '-';
}
