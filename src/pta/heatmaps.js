/**
 * 曜日×時間ヒートマップ / Overall (六角ビン) ヒートマップと、詳細スライドレイヤ
 */
import { select, selectAll } from 'd3-selection';
import { scaleLinear, scaleSequential } from 'd3-scale';
import { max, min } from 'd3-array';
import { hexbin } from 'd3-hexbin';
import { formatDateParam, getMetricUnit } from './lib/format.js';
import { flattenSorted } from './lib/series.js';
import { combineHeatmapData, buildDayHourMap, dayHourAverages, computeIqrThresholds, computeOverallStats } from './lib/heatmap-data.js';
import { escapeHtml } from '../shared/html.js';
import { state } from './state.js';
import { fetchMetricData } from './api.js';

// 既存コードの `d3.xxx` 呼び出しをそのまま使うための名前空間
const d3 = { select, selectAll, scaleLinear, scaleSequential, max, min, hexbin };

// 連続して選択範囲が変わったとき、古いリクエストの結果で画面を上書きしないための世代番号
let heatmapSeq = 0;

export async function reloadHeatmaps(domainId, targetId, targetType, startDate, endDate) {
  const seq = ++heatmapSeq;
  try {
    const fetchEndDate = new Date(endDate);
    fetchEndDate.setDate(fetchEndDate.getDate() + 1);

    const timePromises = [];
    const countPromises = [];
    const errCountPromises = []; // Add for Error Rate

    let currentStart = new Date(startDate);
    while (currentStart < fetchEndDate) {
      let currentEnd = new Date(currentStart);
      currentEnd.setDate(currentEnd.getDate() + 30); // 30-day chunks to bypass 31-day API limit
      if (currentEnd > fetchEndDate) {
        currentEnd = new Date(fetchEndDate);
      }

      const chunkStartStr = formatDateParam(currentStart);
      const chunkEndStr = formatDateParam(currentEnd);

      const isHitSelected = (state.currentMetric === 'service_count');
      const isErrRateSelected = (state.currentMetric === 'err_rate');

      timePromises.push(
        fetchMetricData(domainId, targetId, targetType, chunkStartStr, chunkEndStr, 60, (isHitSelected || isErrRateSelected) ? 'service_time' : state.currentMetric)
          .catch(err => { console.warn(`Heatmap primary chunk failed`, err); return []; })
      );
      countPromises.push(
        fetchMetricData(domainId, targetId, targetType, chunkStartStr, chunkEndStr, 60, 'service_count')
          .catch(err => { console.warn("Heatmap service_count chunk failed", err); return []; })
      );

      if (state.currentMetric === 'err_rate') {
        errCountPromises.push(
          fetchMetricData(domainId, targetId, targetType, chunkStartStr, chunkEndStr, 60, 'service_err_count')
            .catch(err => { console.warn("Heatmap service_err_count chunk failed", err); return []; })
        );
      }

      currentStart = currentEnd;
    }

    const timeResults = await Promise.all(timePromises);
    const countResults = await Promise.all(countPromises);
    const errCountResults = (state.currentMetric === 'err_rate') ? await Promise.all(errCountPromises) : [];
    if (seq !== heatmapSeq) return;

    const combinedHeatmapData = combineHeatmapData(
      flattenSorted(timeResults),
      flattenSorted(countResults),
      state.currentMetric === 'err_rate' ? flattenSorted(errCountResults) : [],
      state.currentMetric
    );

    const isHitSelected = (state.currentMetric === 'service_count');
    renderDayHourHeatmap(combinedHeatmapData, isHitSelected, state.currentMetric);
    renderOverallHeatmap(combinedHeatmapData, isHitSelected, state.currentMetric);
  } catch (error) {
    console.error("Heatmaps reloading failed:", error);
  }
}

export function renderDayHourHeatmap(data, isHitSelected, metric) {
  const container = document.getElementById('dayHourHeatmap');
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="heatmap-placeholder">有効なデータがありません。</div>';
    return;
  }

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hours = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));

  // 曜日×時間 (7×24) に集計。dayHourMap[曜日][時] = { sum, count, data[] }
  const dayHourMap = buildDayHourMap(data);

  // 各セルの平均値 (しきい値の算出に使う)
  const allAverages = dayHourAverages(dayHourMap);

  // Calculate dynamic thresholds if not already stored for the current metric
  let goodThreshold, warningThreshold;

  if (state.metricThresholds[metric]) {
    goodThreshold = state.metricThresholds[metric].good;
    warningThreshold = state.metricThresholds[metric].warning;
  } else {
    // Default fallback
    goodThreshold = 100;
    warningThreshold = 300;

    const computed = computeIqrThresholds(allAverages);
    if (computed) {
      goodThreshold = computed.good;
      warningThreshold = computed.warning;
      // Cache these thresholds so they persist during chart selections (filtering period)
      state.metricThresholds[metric] = { good: goodThreshold, warning: warningThreshold };
    }
  }

  // Update Legend with calculated thresholds
  const legendGoodText = document.getElementById('legendGoodText');
  const legendWarningText = document.getElementById('legendWarningText');
  const legendDangerText = document.getElementById('legendDangerText');

  if (legendGoodText && legendWarningText && legendDangerText) {
    // ヒートマップのセル値は選択中の指標そのもの (ヒット数選択時はヒット数) なので、単位も指標に従う
    const unit = getMetricUnit(metric);
    if (allAverages.length > 0) {
      const formatThreshold = (val) => val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      legendGoodText.innerHTML = `安定 <span style="font-size: 0.65rem; color: #94a3b8; margin-left: 2px;">(≤ ${formatThreshold(goodThreshold)}${unit})</span>`;
      legendWarningText.innerHTML = `警戒 <span style="font-size: 0.65rem; color: #94a3b8; margin-left: 2px;">(≤ ${formatThreshold(warningThreshold)}${unit})</span>`;
      legendDangerText.innerHTML = `高負荷 <span style="font-size: 0.65rem; color: #94a3b8; margin-left: 2px;">(> ${formatThreshold(warningThreshold)}${unit})</span>`;
    } else {
      legendGoodText.textContent = '安定';
      legendWarningText.textContent = '警戒';
      legendDangerText.textContent = '高負荷';
    }
  }

  let html = '<table class="heatmap-table">';
  html += '<thead><tr><th></th>';
  hours.forEach(h => {
    html += `<th>${h}</th>`;
  });
  html += '</tr></thead><tbody>';

  days.forEach((day, dIdx) => {
    html += `<tr><td class="cell-label">${day}</td>`;
    hours.forEach((h) => {
      const cell = dayHourMap[dIdx][parseInt(h)];
      const avg = cell.count > 0 ? cell.sum / cell.count : 0;

      // Interpolate colors based on value
      // 0: Light background, Low: Green, Mid: Yellow, High: Red
      let bgColor = 'rgba(0, 0, 0, 0.05)'; // Default for no data in light theme
      if (cell.count > 0) {
        // Create a custom scale:
        // 0 -> #dcfce7 (Very Light Green)
        // goodThreshold -> #22c55e (Green - 양호)
        // warningThreshold -> #facc15 (Yellow - 주의)
        // Max -> #ef4444 (Red - 나쁨)

        const maxVal = Math.max(warningThreshold * 1.5, avg); // Ensure red is reached
        const colorScale = d3.scaleLinear()
          .domain([0, goodThreshold, warningThreshold, maxVal])
          .range(['#dcfce7', '#22c55e', '#facc15', '#ef4444'])
          .clamp(true);

        bgColor = colorScale(avg);
      }

      const unit = getMetricUnit(metric);
      const formattedAvg = avg.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const tooltipText = cell.count > 0 ? `${day} ${h}:00<br/>Avg: ${formattedAvg}${unit}` : 'No data';
      html += `<td style="background-color: ${bgColor}; cursor: ${cell.count > 0 ? 'pointer' : 'default'};"
                class="dayhour-cell"
                data-day="${dIdx}"
                data-hour="${h}"
                data-count="${cell.count}"
                data-tooltip="${escapeHtml(tooltipText)}">
              </td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';

  container.innerHTML = html;

  // Bind click events to meaningful cells
  const cells = container.querySelectorAll('.dayhour-cell');
  cells.forEach(cellElement => {
    // ツールチップ (インラインの onmouseover ではなくリスナーで登録する)
    cellElement.addEventListener('mouseover', (e) => showHeatmapTooltip(e, cellElement.dataset.tooltip));
    cellElement.addEventListener('mouseout', () => hideHeatmapTooltip());
    const count = parseInt(cellElement.getAttribute('data-count'), 10);
    if (count > 0) {
      cellElement.addEventListener('click', () => {
        const dIdx = parseInt(cellElement.getAttribute('data-day'), 10);
        const hInt = parseInt(cellElement.getAttribute('data-hour'), 10);
        const cellData = dayHourMap[dIdx][hInt].data;
        if (cellData && cellData.length > 0) {
          showDayHourListLayer(cellData, metric, isHitSelected);
        }
      });
    }
  });
}

function showDayHourListLayer(binData, metric, isHitSelected) {
  const layer = document.getElementById('dayHourDetailLayer');
  if (!layer) return;

  layer.classList.add('open');

  const tbody = document.getElementById('dayHourDetailListBody');
  const metricHeader = document.getElementById('dayHourDetailMetricHeader');

  // Set Metric Header Unit
  const unit = isHitSelected ? 'ms' : getMetricUnit(metric);
  // 一覧に表示する値は yValue (ヒット数選択時は応答時間) なので、見出しもそれに合わせる
  const labelName = isHitSelected
    ? '応答時間'
    : (document.querySelector(`.metric-btn[data-metric="${metric}"]`)?.textContent || 'Value');
  metricHeader.textContent = `${labelName}`; // Kept short, unit included in text

  // Sort chronologically
  const sortedData = [...binData].sort((a, b) => String(a.time).localeCompare(String(b.time)));

  // Find max value for the horizontal bar graph scaling
  const maxVal = d3.max(sortedData, d => (d.yValue !== undefined ? d.yValue : d.value)) || 1;

  tbody.innerHTML = '';

  const formatVal = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  sortedData.forEach((item, index) => {
    const timeStr = String(item.time);
    const yyyy = timeStr.substring(0, 4);
    const MM = timeStr.substring(4, 6);
    const dd = timeStr.substring(6, 8);
    const dateFormatted = `${yyyy}.${MM}.${dd}`;

    const value = item.yValue !== undefined ? item.yValue : item.value;
    const metricFormatted = escapeHtml(`${formatVal(value)}${unit}`);
    const barWidthPercent = Number.isFinite(value / maxVal) ? (value / maxVal) * 100 : 0;

    // Horizontal Bar with value
    const barHtml = `
      <div class="value-bar-wrapper">
        <div class="value-bar-container">
          <div class="value-bar-fill" style="width: ${barWidthPercent}%;"></div>
        </div>
        <div class="value-text">${metricFormatted}</div>
      </div>
    `;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(dateFormatted)}</td>
      <td>${barHtml}</td>
    `;

    tbody.appendChild(tr);
  });
}

export function renderOverallHeatmap(data, isHitSelected, metric) {
  const container = document.getElementById('overallHeatmap');
  if (!container) return;

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="heatmap-placeholder">有効なデータがありません。</div>';
    return;
  }

  // 1. 件数 0 の項目を除いた有効データ (散布図の点)
  const validData = data.filter(d => d.count > 0);
  if (validData.length === 0) {
    container.innerHTML = '<div class="heatmap-placeholder">有効なデータがありません。</div>';
    return;
  }

  container.innerHTML = ''; // Clear previous

  // 2. 軸の基準値 (中央値・最大値)。X 軸 (ヒット数) は常に現在のデータから、
  //    Y 軸 (指標値) は指標ごとに最初に求めた値を固定して使う
  const stats = computeOverallStats(data);
  const medianX = stats.medianX;
  const maxX = stats.maxX;
  let medianY, maxY;
  if (state.overallYThresholds[metric]) {
    medianY = state.overallYThresholds[metric].median;
    maxY = state.overallYThresholds[metric].max;
  } else {
    medianY = stats.medianY;
    maxY = stats.maxY;
    state.overallYThresholds[metric] = { median: medianY, max: maxY };
  }

  // 3. Prepare Labels and Dynamic Margins
  const formatNum = (num) => {
    if (num >= 1000) return (num / 1000).toFixed(1).replace('.0', '') + 'k';
    // If it's not an integer, show 2 decimal places. Otherwise show as is.
    return Number.isInteger(num) ? num.toString() : num.toFixed(2);
  };

  const unit = isHitSelected ? 'ms' : getMetricUnit(metric);
  const yLabelText = formatNum(medianY) + unit;
  const xLabelText = formatNum(medianX) + ' Hits';

  // Dynamic left margin calculation to prevent text clipping regardless of value length
  const estimatedYLabelWidth = Math.ceil(yLabelText.length * 8.5) + 25;
  const marginLeft = Math.max(75, estimatedYLabelWidth);

  // Setup SVG Canvas with adjusted margins
  const margin = { top: 20, right: 25, bottom: 40, left: marginLeft };
  const containerWidth = container.clientWidth || 500;
  const containerHeight = Math.max(container.clientHeight, 350) || 350;

  const width = containerWidth - margin.left - margin.right;
  const height = containerHeight - margin.top - margin.bottom;

  const svg = d3.select(container)
    .append("svg")
    .attr("width", containerWidth)
    .attr("height", containerHeight)
    .style("overflow", "visible")
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // 4. Scales mapping (0 -> Median -> Max) to (0 -> Width/2 -> Width)
  // Swapped: X is now Hits, Y is now Metric Value
  const xScale = d3.scaleLinear()
    .domain([0, medianX, maxX]) // medianX is counts (dynamic)
    .range([0, width / 2, width])
    .clamp(true);

  const yScale = d3.scaleLinear()
    .domain([0, medianY, maxY]) // medianY is metric value (fixed)
    .range([height, height / 2, 0])
    .clamp(true);

  // 5. Hexbin configuration
  const radius = 12;
  const hexbin = d3.hexbin()
    .x(d => xScale(d.count))
    .y(d => yScale(d.yValue))
    .radius(radius)
    .extent([[0, 0], [width, height]]);

  const bins = hexbin(validData);
  const maxBinLength = d3.max(bins, d => d.length);

  // Define a color scale mapping density to green opacity
  // Non-linear mapping adjusted for a wider gradient and better distinctiveness.
  // Base opacity lowered to 0.15, using a square root (0.5) curve to spread the mid-ranges better.
  const colorScale = d3.scaleSequential(
    (t) => `rgba(10, 210, 50, ${Math.min(0.10 + (Math.pow(t, 0.5) * 0.85), 1)})`
  ).domain([1, maxBinLength || 1]);

  // 6. Draw the 4-Quadrant Axes (Centered on Median)
  svg.append("line")
    .attr("x1", width / 2)
    .attr("x2", width / 2)
    .attr("y1", 0)
    .attr("y2", height)
    .attr("class", "quadrant-axis");

  svg.append("line")
    .attr("x1", 0)
    .attr("x2", width)
    .attr("y1", height / 2)
    .attr("y2", height / 2)
    .attr("class", "quadrant-axis");

  // 7. Render Hexagons
  svg.append("g")
    .attr("class", "hexagon-group")
    .selectAll("path")
    .data(bins)
    .join("path")
    .attr("d", hexbin.hexagon())
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .attr("fill", d => colorScale(d.length))
    .attr("stroke", "white")
    .attr("stroke-width", "0.5")
    .on("mouseover", function (event, d) {
      if (!d3.select(this).classed("selected-hex")) {
        d3.select(this).attr("stroke", "#333").attr("stroke-width", "1.5");
      }
      // Find min ~ max ranges of the bin for the tooltip
      const formatVal = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const minTime = d3.min(d, p => p.yValue); // Changed from p.responseTime to p.value
      const maxTime = d3.max(d, p => p.yValue); // Changed from p.responseTime to p.value
      const minCount = d3.min(d, p => p.count);
      const maxCount = d3.max(d, p => p.count);

      const timeRange = minTime === maxTime ? formatVal(minTime) : `${formatVal(minTime)} ~ ${formatVal(maxTime)}`;
      const countRange = minCount === maxCount ? formatVal(minCount) : `${formatVal(minCount)} ~ ${formatVal(maxCount)}`;

      const unit = isHitSelected ? 'Hits' : getMetricUnit(metric);
      const labelName = document.querySelector(`.metric-btn[data-metric="${metric}"]`)?.textContent || 'Value';
      const tooltipText = `Hits: ${countRange}<br/>${labelName}: ${timeRange} ${unit}<br/>Points: ${d.length}`;
      showHeatmapTooltip(event, tooltipText);
    })
    .on("mouseout", function () {
      if (!d3.select(this).classed("selected-hex")) {
        d3.select(this).attr("stroke", "white").attr("stroke-width", "0.5");
      }
      hideHeatmapTooltip();
    })
    .on("click", function (event, d) {
      d3.selectAll(".hexagon-group path.selected-hex")
        .classed("selected-hex", false)
        .attr("stroke", "white")
        .attr("stroke-width", "0.5");

      d3.select(this)
        .classed("selected-hex", true)
        .attr("stroke", "#ef4444")
        .attr("stroke-width", "2");

      showOverallListLayer(d, metric, isHitSelected);
    });

  // 8. Minimalist Labels (Only Medians)
  // X-Axis Median Label (Hits)
  svg.append("text")
    .attr("x", width / 2)
    .attr("y", height + 25)
    .attr("class", "quadrant-label")
    .attr("text-anchor", "middle")
    .text(xLabelText);

  // Y-Axis Median Label (Value)
  svg.append("text")
    .attr("x", -10)
    .attr("y", height / 2)
    .attr("class", "quadrant-label")
    .attr("text-anchor", "end")
    .attr("alignment-baseline", "middle")
    .text(yLabelText);

  // Update Footer Label (External to SVG)
  const labelY = document.getElementById('overallHeatmapLabelY');
  if (labelY) {
    const metricDisplayName = isHitSelected ? '応答時間' : (document.querySelector(`.metric-btn[data-metric="${metric}"]`)?.textContent || metric);
    labelY.textContent = `${metricDisplayName} (${unit})`;
  }
}

// Ensure a single global tooltip exists
let globalHeatmapTooltip = document.getElementById('globalHeatmapTooltip');
if (!globalHeatmapTooltip) {
  globalHeatmapTooltip = document.createElement('div');
  globalHeatmapTooltip.id = 'globalHeatmapTooltip';
  globalHeatmapTooltip.className = 'heatmap-tooltip';
  document.body.appendChild(globalHeatmapTooltip);
}

function showHeatmapTooltip(event, text) {
  if (!globalHeatmapTooltip) return;

  globalHeatmapTooltip.innerHTML = text;
  globalHeatmapTooltip.style.display = 'block';

  const x = event.pageX + 15;
  const y = event.pageY + 15;

  globalHeatmapTooltip.style.left = x + 'px';
  globalHeatmapTooltip.style.top = y + 'px';
}

function hideHeatmapTooltip() {
  if (globalHeatmapTooltip) globalHeatmapTooltip.style.display = 'none';
}

// Helper function to close all detail slide-in layers
function closeAllDetailLayers() {
  const overallLayer = document.getElementById('overallDetailLayer');
  if (overallLayer && overallLayer.classList.contains('open')) {
    overallLayer.classList.remove('open');

    // Remove hexagon highlight when layer is closed
    d3.selectAll('.hexagon-group path.selected-hex')
      .classed('selected-hex', false)
      .attr('stroke', 'white')
      .attr('stroke-width', '0.5');
  }

  const dayHourLayer = document.getElementById('dayHourDetailLayer');
  if (dayHourLayer && dayHourLayer.classList.contains('open')) {
    dayHourLayer.classList.remove('open');
  }
}

// Setup Slide-in Layer Logic
export function initDetailLayers() {
  const closeBtn = document.getElementById('closeDetailLayer');
  if (closeBtn) {
    closeBtn.addEventListener('click', closeAllDetailLayers);
  }

  const closeDayHourBtn = document.getElementById('closeDayHourLayer');
  if (closeDayHourBtn) {
    closeDayHourBtn.addEventListener('click', closeAllDetailLayers);
  }

  // Close detail layers when ESC key is pressed
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeAllDetailLayers();
    }
  });
}

function showOverallListLayer(dataPoints, metric, isHitSelected) {
  const layer = document.getElementById('overallDetailLayer');
  const tbody = document.getElementById('detailListBody');
  const metricHeader = document.getElementById('detailMetricHeader');
  if (!layer || !tbody || !metricHeader) return;

  const unit = isHitSelected ? 'ms' : getMetricUnit(metric);
  const metricDisplayName = isHitSelected ? '応答時間' : (document.querySelector(`.metric-btn[data-metric="${metric}"]`)?.textContent || metric);
  metricHeader.textContent = `${metricDisplayName}(${unit})`;

  // Sort data points by time ascending
  const sortedData = [...dataPoints].sort((a, b) => String(a.time).localeCompare(String(b.time)));

  tbody.innerHTML = '';

  const formatVal = (v) => v.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  sortedData.forEach((item, index) => {
    const timeStr = String(item.time);
    const yyyy = timeStr.substring(0, 4);
    const MM = timeStr.substring(4, 6);
    const dd = timeStr.substring(6, 8);
    const HH = timeStr.substring(8, 10);

    // Default format requested: date(yyyy.MM.dd) and time(HH)
    const dateFormatted = `${yyyy}.${MM}.${dd}`;
    const timeFormatted = `${HH}`;
    const hitsFormatted = `${item.count}件`;
    const metricFormatted = `${formatVal(item.yValue)}${unit}`;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${index + 1}</td>
      <td>${escapeHtml(dateFormatted)}</td>
      <td>${escapeHtml(timeFormatted)}</td>
      <td>${escapeHtml(hitsFormatted)}</td>
      <td>${escapeHtml(metricFormatted)}</td>
    `;

    // 상세 팝업 오픈 로직 제거 (detail_overall.html 삭제됨)

    tbody.appendChild(tr);
  });

  layer.classList.add('open');
}
