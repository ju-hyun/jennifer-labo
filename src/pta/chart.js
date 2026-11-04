/**
 * メインチャート (Chart.js)、月境界/範囲選択プラグイン、月別平均の統計グリッド
 */
import Chart from 'chart.js/auto';
import { toYMD, getMetricUnit, parseDateString } from './lib/format.js';
import { calculateSMA, computeMonthlyAverages, isHitWeighted, weightMap } from './lib/series.js';
import { state } from './state.js';
import { handleChartSelectionChanged } from './selection.js';

const MONTH_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80', '#34d399',
  '#2dd4bf', '#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#fb7185'
];

// Configure Chart.js global defaults
Chart.defaults.font.family = '"Pretendard JP", sans-serif';
Chart.defaults.color = "#64748b";
Chart.defaults.scale.grid.color = "#f1f5f9";
Chart.defaults.plugins.tooltip.backgroundColor = "rgba(30, 41, 59, 0.9)";
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 4;

const monthBoundaryPlugin = {
  id: 'monthBoundary',
  afterEvent(chart, args) {
    const event = args.event;
    if (event.type === 'mousemove') {
      const xPixel = event.x;
      const xAxis = chart.scales.x;
      const value = xAxis.getValueForPixel(xPixel);
      let index = Math.round(value);

      if (chart.data.labels && chart.data.labels.length > 0) {
        const maxIndex = chart.data.labels.length - 1;
        if (index < 0) index = 0;
        if (index > maxIndex) index = maxIndex;

        const hoveredMonth = chart.data.labels[index].split('/')[0];
        if (chart.hoveredMonth !== hoveredMonth) {
          chart.hoveredMonth = hoveredMonth;
          args.changed = true;
        }
      }
    } else if (event.type === 'mouseout') {
      if (chart.hoveredMonth !== null) {
        chart.hoveredMonth = null;
        args.changed = true;
      }
    }
  },
  beforeDraw(chart) {
    const { ctx, chartArea, scales: { x } } = chart;
    const labels = chart.data.labels;
    if (!labels || labels.length === 0) return;

    const getBoundaryX = (i) => (x.getPixelForValue(i - 1) + x.getPixelForValue(i)) / 2;

    const boundaries = [];
    const monthZones = {};

    let currentMonth = labels[0].split('/')[0];
    let startX = chartArea.left;

    for (let i = 1; i < labels.length; i++) {
      const month = labels[i].split('/')[0];
      if (month !== currentMonth) {
        const lineX = getBoundaryX(i);
        boundaries.push(lineX);
        monthZones[currentMonth] = { startX: startX, endX: lineX, month: currentMonth };
        currentMonth = month;
        startX = lineX;
      }
    }
    monthZones[currentMonth] = { startX: startX, endX: chartArea.right, month: currentMonth };

    // Draw Hover Highlight
    if (chart.hoveredMonth && monthZones[chart.hoveredMonth]) {
      const zone = monthZones[chart.hoveredMonth];
      ctx.save();
      const monthIdx = (parseInt(chart.hoveredMonth, 10) - 1) % 12;
      ctx.fillStyle = MONTH_COLORS[monthIdx] + '26'; // 15% opacity hex
      ctx.fillRect(zone.startX, chartArea.top, zone.endX - zone.startX, chartArea.bottom - chartArea.top);
      ctx.restore();
    }

    // Draw Dotted Boundaries
    ctx.save();
    ctx.beginPath();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)'; // lighter line color
    ctx.setLineDash([4, 4]);
    boundaries.forEach(lineX => {
      ctx.moveTo(lineX, chartArea.top);
      ctx.lineTo(lineX, chartArea.bottom);
    });
    ctx.stroke();
    ctx.restore();
  },
  afterDraw(chart) {
    // Stats are now rendered in HTML section instead of canvas
    const curMetricData = state.yearlyData[state.currentMetric] || [];
    if (chart.data.labels && curMetricData.length > 0) {
      updateChartStatsGrid(chart.data.labels, chart);
    }
  }
};

const selectionRangePlugin = {
  id: 'selectionRange',
  afterEvent(chart, args) {
    const event = args.event;
    if (event.type === 'mousedown') {
      state.isSelecting = true;
      state.dragStartX = event.x;
      state.dragCurrentX = event.x;
      args.changed = true;
    } else if (event.type === 'mousemove' && state.isSelecting) {
      state.dragCurrentX = event.x;
      args.changed = true;
    } else if (event.type === 'mouseup' || (event.type === 'mouseout' && state.isSelecting)) {
      if (state.isSelecting) {
        state.isSelecting = false;

        // Calculate selected range based on pixel coordinates
        if (Math.abs(state.dragCurrentX - state.dragStartX) > 10) {
          // Drag selection
          const xAxis = chart.scales.x;
          let val1 = xAxis.getValueForPixel(state.dragStartX);
          let val2 = xAxis.getValueForPixel(state.dragCurrentX);

          if (val1 > val2) {
            const temp = val1;
            val1 = val2;
            val2 = temp;
          }

          let idx1 = Math.round(val1);
          let idx2 = Math.round(val2);

          const maxIndex = chart.data.labels.length - 1;
          idx1 = Math.max(0, Math.min(idx1, maxIndex));
          idx2 = Math.max(0, Math.min(idx2, maxIndex));

          state.selectedStartMonth = chart.data.labels[idx1].split('/')[0];
          state.selectedEndMonth = chart.data.labels[idx2].split('/')[0];

          // Set active boundary based on drag direction
          state.activeSelectionBoundary = (state.dragCurrentX < state.dragStartX) ? 'start' : 'end';

          // Trigger data update
          handleChartSelectionChanged();
        } else {
          // Click selection (single month or clear)
          const xAxis = chart.scales.x;
          let idx = Math.round(xAxis.getValueForPixel(event.x));
          const maxIndex = chart.data.labels.length - 1;

          if (idx >= 0 && idx <= maxIndex) {
            const clickedMonth = chart.data.labels[idx].split('/')[0];

            // Toggle off if clicking the already selected exactly
            if (state.selectedStartMonth === clickedMonth && state.selectedEndMonth === clickedMonth) {
              state.selectedStartMonth = null;
              state.selectedEndMonth = null;
              state.activeSelectionBoundary = 'end';
            } else {
              state.selectedStartMonth = clickedMonth;
              state.selectedEndMonth = clickedMonth;
              state.activeSelectionBoundary = 'end';
            }
            // Trigger data update
            handleChartSelectionChanged();
          }
        }

        args.changed = true;
      }
    }
  },
  beforeDraw(chart) {
    const { ctx, chartArea, scales: { x } } = chart;
    const labels = chart.data.labels;
    if (!labels || labels.length === 0) return;

    // Draw active drag selection box
    if (state.isSelecting && state.dragStartX !== null && state.dragCurrentX !== null) {
      ctx.save();
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'; // Blue tint for selection box
      const start = Math.min(state.dragStartX, state.dragCurrentX);
      const width = Math.abs(state.dragCurrentX - state.dragStartX);
      ctx.fillRect(start, chartArea.top, width, chartArea.bottom - chartArea.top);
      ctx.restore();
    }

    // Draw finalized selected months highlighting
    if (!state.isSelecting && state.selectedStartMonth && state.selectedEndMonth) {
      // Find start and end pixels for the selected months bounds
      let startPixel = null;
      let endPixel = null;

      const getBoundaryX = (i) => {
        if (i === 0) return chartArea.left;
        if (i >= labels.length) return chartArea.right;
        return (x.getPixelForValue(i - 1) + x.getPixelForValue(i)) / 2;
      };

      let currentMonth = labels[0].split('/')[0];
      let tStartIdx = 0;

      for (let i = 1; i <= labels.length; i++) {
        const month = i < labels.length ? labels[i].split('/')[0] : null;
        if (month !== currentMonth) {
          if (currentMonth === state.selectedStartMonth) {
            startPixel = getBoundaryX(tStartIdx);
          }
          if (currentMonth === state.selectedEndMonth) {
            endPixel = getBoundaryX(i);
          }
          currentMonth = month;
          tStartIdx = i;
        }
      }

      // Ensure start and end are ordered correctly in case of crossed year boundaries
      if (startPixel !== null && endPixel !== null) {
        if (startPixel > endPixel) {
          const temp = startPixel;
          startPixel = endPixel;
          endPixel = temp;
        }
        ctx.save();
        ctx.fillStyle = 'rgba(59, 130, 246, 0.15)'; // Blue tint for selected range
        ctx.fillRect(startPixel, chartArea.top, endPixel - startPixel, chartArea.bottom - chartArea.top);
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 1;
        ctx.strokeRect(startPixel, chartArea.top, endPixel - startPixel, chartArea.bottom - chartArea.top);
        ctx.restore();
      }
    }
  }
};

// Draw or Update Chart
export function updateChart(canvasId, label, data, color, chartInstance, setInstanceCallback) {
  const ctx = document.getElementById(canvasId).getContext('2d');

  const labels = data.map(item => parseDateString(item.time));
  const values = data.map(item => item.value);

  const getMonthColor = (chartCtx, defaultColor, alpha = '80') => {
    if (!chartCtx || !chartCtx.chart || !chartCtx.chart.data || !chartCtx.chart.data.labels) return defaultColor;
    const lbls = chartCtx.chart.data.labels;
    const dataIdx = chartCtx.p0DataIndex !== undefined ? chartCtx.p0DataIndex : chartCtx.dataIndex;
    if (dataIdx === undefined) return defaultColor;
    const lbl = lbls[dataIdx];
    if (!lbl) return defaultColor;
    const mStr = lbl.split('/')[0];
    const idx = (parseInt(mStr, 10) - 1) % 12;
    return (MONTH_COLORS[idx] || defaultColor) + (alpha === '' ? '' : alpha);
  };

  // Compute month-by-month averages BEFORE creating/updating chart so afterDraw has data
  calculateMonthlyAverages(data, label);

  const datasets = [];

  // Primary Dataset
  const primaryDataset = {
    label: label,
    data: values,
    borderWidth: 2,
  };

  if (state.currentChartType === 'line') {
    primaryDataset.fill = true;
    primaryDataset.tension = 0;
    primaryDataset.pointRadius = 0;
    primaryDataset.pointHoverRadius = 5;
    primaryDataset.segment = {
      borderColor: ctx => getMonthColor(ctx, color, state.showMA ? '4d' : ''), // Increased border alpha (0.15 -> 0.3)
      backgroundColor: ctx => getMonthColor(ctx, color, state.showMA ? '26' : '66') // Increased fill alpha (0.08 -> 0.15)
    };
  } else { // bar
    primaryDataset.backgroundColor = ctx => getMonthColor(ctx, color, state.showMA ? '26' : '66');
    primaryDataset.borderColor = ctx => getMonthColor(ctx, color, state.showMA ? '4d' : '');
  }
  datasets.push(primaryDataset);

  // Handle System CPU dual line (Avg + Max) - Force combo chart for visibility
  if (state.currentMetric === 'sys_cpu' && state.yearlyData['max_sys_cpu'].length > 0) {
    // 1. Re-adjust Primary (Avg) style for CPU
    primaryDataset.label = '平均CPU';
    primaryDataset.order = 2; // Behind max line

    // 2. Add Max CPU as a forced Line
    const maxCpuData = state.yearlyData['max_sys_cpu'].map(item => item.value);
    const maxDataset = {
      label: '最大CPU',
      type: 'line', // Always line
      data: maxCpuData,
      borderWidth: 2,
      borderColor: '#ef9eaba1', // Rose Red
      backgroundColor: 'transparent',
      pointRadius: 0,
      tension: 0.4, // Smooth curve
      order: 1 // In front
    };
    datasets.push(maxDataset);
  }

  // Add 7-day and 30-day Moving Averages only if enabled
  if (state.showMA) {
    const ma7Data = calculateSMA(values, 7);
    const ma30Data = calculateSMA(values, 30);

    datasets.push({
      label: '7日移動平均',
      type: 'line',
      data: ma7Data,
      borderColor: '#ff4d00', // More vibrant orange-red for better visibility
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      borderDash: [1, 1], // Optional: dashed line for MA
      order: 0, // Top-most
      pointStyle: 'line' // Ensure legend shows as line
    });

    datasets.push({
      label: '30日移動平均',
      type: 'line',
      data: ma30Data,
      borderColor: '#682cf3ff', // Violet
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0.3,
      order: 0,
      pointStyle: 'line' // Ensure legend shows as line
    });
  }

  if (chartInstance && chartInstance.config.type !== state.currentChartType) {
    chartInstance.destroy();
    chartInstance = null;
  }

  if (chartInstance) {
    chartInstance.data.labels = labels;
    chartInstance.data.datasets = datasets;
    chartInstance.update();
  } else {
    // Create new chart
    const newChart = new Chart(ctx, {
      type: state.currentChartType,
      data: {
        labels: labels,
        datasets: datasets
      },
      plugins: [monthBoundaryPlugin, selectionRangePlugin],
      options: {
        events: ['mousemove', 'mouseout', 'click', 'touchstart', 'touchmove', 'mousedown', 'mouseup'], // Required to capture drag start/end
        responsive: true,
        maintainAspectRatio: false,
        layout: {
          padding: {
            bottom: 10
          }
        },
        interaction: {
          intersect: false,
          mode: 'index',
        },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            align: 'end',
            labels: {
              boxWidth: 20,
              padding: 10,
              font: { size: 10 },
              usePointStyle: true,
              filter: function (item) {
                // Filter out the primary metric and Max CPU from the legend
                return item.text.includes('移動平均');
              }
            }
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                let label = context.dataset.label || '';
                if (label) {
                  label += ': ';
                }
                if (context.parsed.y !== null) {
                  const unit = getMetricUnit(state.currentMetric);
                  label += new Intl.NumberFormat().format(context.parsed.y) + (unit ? ' ' + unit : '');
                }
                return label;
              }
            }
          }
        },
        scales: {
          x: {
            border: { display: false },
            grid: { display: false },
            ticks: {
              maxRotation: 0,
              autoSkip: false,
              font: { size: 10 },
              callback: function (value) {
                const label = this.getLabelForValue(value);
                if (label && label.endsWith('/15')) {
                  return label;
                }
                return null;
              }
            }
          },
          y: {
            border: { display: false },
            beginAtZero: true,
            ticks: {
              maxTicksLimit: 6,
              callback: function (value) {
                const unit = getMetricUnit(state.currentMetric);
                if (unit === '%') return value + '%';
                if (value >= 1000) {
                  return (value / 1000).toFixed(0) + 'k';
                }
                return value;
              },
              font: { size: 10 }
            }
          }
        }
      }
    });
    setInstanceCallback(newChart);
  }
}

let monthlyAveragesCache = {};

let currentMetricLabelCache = '';

function calculateMonthlyAverages(data, label) {
  currentMetricLabelCache = label;
  monthlyAveragesVersion++;
  // 応答時間・エラー率の月平均は、その日のリクエスト数で加重する (閑散日と繁忙日を同じ重みにしない)
  const weights = isHitWeighted(state.currentMetric) ? weightMap(state.yearlyData.service_count) : null;
  monthlyAveragesCache = computeMonthlyAverages(data, { metric: state.currentMetric, todayStr: toYMD(new Date()), weights });
}

// 統計グリッドの再描画をスキップするための署名と、月別平均の更新世代
let statsGridSig = '';

let monthlyAveragesVersion = 0;

export function updateChartStatsGrid(labels, chart) {
  const avgWrapper = document.getElementById('statsAvgValues');
  const rateWrapper = document.getElementById('statsRateValues');
  if (!avgWrapper || !rateWrapper || !chart) return;

  const { chartArea, scales: { x } } = chart;
  if (!chartArea) return;

  // マウス移動などで afterDraw が頻繁に呼ばれるが、データ・サイズ・位置が同じなら DOM は作り直さない
  const offsetX = Math.round(chart.canvas.getBoundingClientRect().left - avgWrapper.getBoundingClientRect().left);
  const sig = [
    labels.length, labels[0], labels[labels.length - 1],
    Math.round(chartArea.left), Math.round(chartArea.right), offsetX, monthlyAveragesVersion
  ].join('|');
  if (sig === statsGridSig && avgWrapper.childElementCount > 0) return;
  statsGridSig = sig;

  avgWrapper.innerHTML = '';
  rateWrapper.innerHTML = '';

  // Re-calculate month zones to get exact center positions
  const monthZones = [];
  let currentMonth = labels[0].split('/')[0];
  let startIdx = 0;

  for (let i = 1; i < labels.length; i++) {
    const month = labels[i].split('/')[0];
    if (month !== currentMonth) {
      const startX = x.getPixelForValue(startIdx);
      const endX = x.getPixelForValue(i - 1);
      monthZones.push({ month: currentMonth, centerX: (startX + endX) / 2 });
      currentMonth = month;
      startIdx = i;
    }
  }
  const startXLast = x.getPixelForValue(startIdx);
  const endXLast = x.getPixelForValue(labels.length - 1);
  monthZones.push({ month: currentMonth, centerX: (startXLast + endXLast) / 2 });

  monthZones.forEach(zone => {
    const d = monthlyAveragesCache[zone.month];
    if (!d) return;

    // Calculate relative left based on wrapper (which starts from ChartArea.left offset ideally,
    // but here wrapper starts after 60px label + 1.25rem padding-left)
    // Wrapper's absolute left = stats-row.padding-left(20px) + stats-label.width(60px) = 80px
    // ChartArea.left is usually around 40-60px.
    // Let's use getBoundingClientRect for perfect precision or just offset it.

    const wrapperRect = avgWrapper.getBoundingClientRect();
    const chartRect = chart.canvas.getBoundingClientRect();
    const xOffset = zone.centerX + (chartRect.left - wrapperRect.left);

    // Avg Item
    const avgItem = document.createElement('div');
    avgItem.className = 'stat-item';
    avgItem.style.left = `${xOffset}px`;

    let avgText;
    const metricLabel = currentMetricLabelCache || '';
    if (metricLabel.includes('応答時間') || metricLabel.includes('Response Time')) {
      avgText = Math.round(d.avg).toLocaleString();
    } else if (metricLabel.includes('TPS')) {
      avgText = d.avg.toFixed(2);
    } else {
      avgText = Math.round(d.avg).toLocaleString();
    }
    avgItem.textContent = avgText;
    avgWrapper.appendChild(avgItem);

    // Rate Item
    const rateItem = document.createElement('div');
    rateItem.className = 'stat-item';
    rateItem.style.left = `${xOffset}px`;
    if (d.rate !== null) {
      const rateAbs = Math.abs(d.rate).toFixed(1);
      if (d.rate > 0) {
        rateItem.textContent = `+${rateAbs}%`;
        rateItem.classList.add('rate-up');
      } else if (d.rate < 0) {
        rateItem.textContent = `-${rateAbs}%`;
        rateItem.classList.add('rate-down');
      } else {
        rateItem.textContent = '0%';
        rateItem.classList.add('rate-none');
      }
    } else {
      rateItem.textContent = '-';
      rateItem.classList.add('rate-none');
    }
    rateWrapper.appendChild(rateItem);
  });
}
