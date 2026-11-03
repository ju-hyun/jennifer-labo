import Chart from 'chart.js/auto';
// d3 は CDN ではなく npm 依存として同梱する (外部ネットワーク遮断環境でも動作し、
// package-lock.json の整合性ハッシュでバージョンが固定されるため)。必要なモジュールのみ読み込む。
import { select, selectAll } from 'd3-selection';
import { scaleLinear, scaleSequential } from 'd3-scale';
import { max, min } from 'd3-array';
import { hexbin } from 'd3-hexbin';

import {
  formatDateParam, toYMD, getMetricUnit, escapeHtml, formatYMDLocal, parseDateString
} from './lib/format.js';
import {
  mergeSeries, flattenSorted, computeErrRate, calculateSMA, computeMonthlyAverages, summarizeRange
} from './lib/series.js';
import {
  combineHeatmapData, buildDayHourMap, dayHourAverages, computeIqrThresholds, computeOverallStats
} from './lib/heatmap-data.js';

// 既存コードの `d3.xxx` 呼び出しをそのまま使うための名前空間
const d3 = { select, selectAll, scaleLinear, scaleSequential, max, min, hexbin };

// Runtime configuration (pta/config.js에서 window.PTA_CONFIG로 로드)
const PTA_CFG = window.PTA_CONFIG || {};

/**
 * 接続失敗時にダミー(モック)データを表示してよいか。
 * 運用環境で実データと誤認されないよう、開発ビルドか、config.js の ALLOW_MOCK: true の明示指定時のみ許可する。
 */
const MOCK_ALLOWED = !!(import.meta.env?.DEV || PTA_CFG.ALLOW_MOCK === true);

/** 画面上部の通知バーに表示する (message が空なら隠す) */
function showNotice(message, level = 'info') {
  const bar = document.getElementById('noticeBar');
  if (!bar) return;
  if (!message) {
    bar.classList.add('hidden');
    return;
  }
  bar.textContent = message;
  bar.className = `notice notice-${level}`;
}

// Global variables
const API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/dbmetrics';
const BUSINESS_METRICS_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/dbmetrics/business';
const DOMAIN_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/domain';
const INSTANCE_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/instance';
const BUSINESS_API_BASE = (PTA_CFG.API_DOMAIN || '') + '/api/business';
// API 인증 토큰은 클라이언트에 두지 않는다. nginx(운영)/Vite 프록시(로컬)가 요청을
// 업스트림으로 전달할 때 서버 측에서 주입한다.

const MONTH_COLORS = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80', '#34d399',
  '#2dd4bf', '#60a5fa', '#818cf8', '#a78bfa', '#e879f9', '#fb7185'
];

// Store chart instances
let mainChartInstance = null;
let currentChartType = 'line';
let showMA = true;
let yearlyData = {
  service_time: [],
  service_rate: [],
  concurrent_user: [],
  service_count: [],
  sys_cpu: [],
  heap_usage: [],
  max_sys_cpu: [],
  service_err_count: [],
  err_rate: []
};

let currentMetric = 'service_time';

function getCurrentDomainId() {
  const lastItem = currentSelectedPath[currentSelectedPath.length - 1];
  return (lastItem && lastItem.type === 'domain') ? lastItem.id : null;
}

// Chart Selection State
let selectedStartMonth = null;
let selectedEndMonth = null;
let isSelecting = false;
let dragStartX = null;
let dragCurrentX = null;
let activeSelectionBoundary = 'end'; // 'start' or 'end'

// Global metric thresholds for heatmaps (persisted across period selections)
let metricThresholds = {};
let overallYThresholds = {};

function updateSummaryCardsDisabledState() {
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

// DOM Elements
const instanceSelect = document.getElementById('instanceSelect');
const businessSelect = document.getElementById('businessSelect');
const instanceFilterArea = document.getElementById('instanceFilterArea');
const businessFilterArea = document.getElementById('businessFilterArea');
const typeRadios = document.querySelectorAll('input[name="targetType"]');
const btnSysCpu = document.getElementById('btnSysCpu');
const btnHeapUsage = document.getElementById('btnHeapUsage');

// Configure Chart.js global defaults
Chart.defaults.font.family = '"Pretendard JP", sans-serif';
Chart.defaults.color = "#64748b";
Chart.defaults.scale.grid.color = "#f1f5f9";
Chart.defaults.plugins.tooltip.backgroundColor = "rgba(30, 41, 59, 0.9)";
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 4;

document.addEventListener('DOMContentLoaded', async () => {
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
      currentMetric = targetBtn.dataset.metric;

      const metricData = yearlyData[currentMetric];
      if (metricData && metricData.length > 0) {
        const metricDisplayName = targetBtn.textContent;
        updateChart('mainChart', metricDisplayName, metricData, '#22c55e', mainChartInstance, (instance) => {
          mainChartInstance = instance;
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
      if (currentMetric === 'sys_cpu' || currentMetric === 'heap_usage') {
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
      currentChartType = targetBtn.dataset.type;

      const metricData = yearlyData[currentMetric];
      if (metricData && metricData.length > 0) {
        const metricDisplayName = document.querySelector(`.metric-btn[data-metric="${currentMetric}"]`).textContent;
        updateChart('mainChart', metricDisplayName, metricData, '#22c55e', mainChartInstance, (instance) => {
          mainChartInstance = instance;
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
      showMA = targetBtn.dataset.ma === 'on';

      // Refresh chart with current metric
      const activeBtn = document.querySelector('.metric-btn.active');
      if (activeBtn) activeBtn.click();
    });
  });

  // Bind resize event to re-align stats
  window.addEventListener('resize', () => {
    const curMetricData = yearlyData[currentMetric] || [];
    if (mainChartInstance && curMetricData.length > 0) {
      const labels = curMetricData.map(item => parseDateString(item.time));
      updateChartStatsGrid(labels, mainChartInstance);
    }
  });

  // Help System Logic
  initHelpSystem();
});


function showConfigError(message, title = 'Configuration Error') {
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

function initHelpSystem() {
  const mainHelpBtn = document.getElementById('mainHelpBtn');
  const contextHelpBtns = document.querySelectorAll('.help-btn-small');

  const openHelpPopup = (sectionId = 'general') => {
    const url = `help.html#${sectionId}`;
    const windowName = 'PerformanceHelpPopup';
    const features = 'width=900,height=850,scrollbars=yes,resizable=yes';

    // Using a global property to maintain the reference across possible re-initializations
    if (window.ptaHelpWindow && !window.ptaHelpWindow.closed) {
      // Update just the hash to trigger internal navigation/scrolling
      window.ptaHelpWindow.location.hash = sectionId;
      window.ptaHelpWindow.focus();
    } else {
      // Open new window and save to global property
      window.ptaHelpWindow = window.open(url, windowName, features);
    }
  };

  if (mainHelpBtn) {
    mainHelpBtn.addEventListener('click', () => openHelpPopup('main-chart'));
  }

  contextHelpBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const sectionId = btn.getAttribute('data-help-section') || 'general';
      openHelpPopup(sectionId);
    });
  });
}

// Hierarchical Selector State
let domainTree = [];
let currentSelectedPath = []; // Array of { id: string, name: string, type: 'group' | 'domain' }

async function loadDomains() {
  const url = new URL(DOMAIN_API_BASE, window.location.origin);
  const urlString = url.toString();

  try {
    const response = await fetch(urlString, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (response.status === 401) {
      showConfigError('Authentication failed. Please contact the site administrator to check the server-side API token.', 'Unauthorized (401)');
      return false;
    }

    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

    const data = await response.json();
    let flatDomains = data.result || [];

    // Sort by domainId ascending
    flatDomains.sort((a, b) => a.domainId - b.domainId);

    // Transform flat list to tree structure based on groupHierarchy
    domainTree = buildDomainTree(flatDomains);

    // Initial selection: First domain found in the tree
    const firstDomain = findFirstDomain(domainTree);
    if (firstDomain) {
      updateSelectedPath(firstDomain.path);
    }

    renderHierarchicalSelector();
    return true;

  } catch (error) {
    console.error('Failed to load domains. URL:', urlString, '\nError:', error);
    if (error.name === 'TypeError') {
      console.warn('Network error or CORS issue suspected.');
    }

    if (document.querySelector('.config-error-overlay')) return false;

    if (!MOCK_ALLOWED) {
      showNotice('ドメイン一覧を取得できませんでした。ネットワークとAPIプロキシの設定をご確認ください。', 'error');
      domainTree = [];
      currentSelectedPath = [];
      renderHierarchicalSelector();
      return false;
    }

    // 開発時のみ: モックのドメイン階層で画面を確認できるようにする
    showNotice('ドメイン一覧を取得できなかったため、モックのドメインで表示しています。実データではありません。', 'warn');
    const mockFlatDomains = [
      { domainId: '1000', name: 'REALTIME, ANALYSIS', groupHierarchy: ['JENNIFER DEMO', 'MSA'] },
      { domainId: '1001', name: 'MSA-2nd', groupHierarchy: ['JENNIFER DEMO', 'MSA'] },
      { domainId: '1002', name: 'MSA-3rd', groupHierarchy: ['JENNIFER DEMO', 'MSA'] },
      { domainId: '1003', name: 'K8s ASYNC', groupHierarchy: ['JENNIFER DEMO', 'K8s ASYNC'] },
      { domainId: '1004', name: 'Total', groupHierarchy: ['Total'] },
      { domainId: '1005', name: 'Azure-1', groupHierarchy: ['kevin', 'Azure'] },
    ];

    domainTree = buildDomainTree(mockFlatDomains);
    const firstDomain = findFirstDomain(domainTree);
    if (firstDomain) {
      updateSelectedPath(firstDomain.path);
    }
    renderHierarchicalSelector();
    return false;
  }
}

function buildDomainTree(flatDomains) {
  const tree = [];

  flatDomains.forEach(domain => {
    let currentLevel = tree;
    const hierarchy = domain.groupHierarchy?.length ? domain.groupHierarchy : ['未分類ドメイン'];

    hierarchy.forEach((groupName) => {
      let group = currentLevel.find(item => item.name === groupName && item.type === 'group');
      if (!group) {
        group = {
          name: groupName,
          type: 'group',
          children: []
        };
        currentLevel.push(group);
      }
      currentLevel = group.children;
    });

    currentLevel.push({
      id: domain.domainId,
      name: domain.name,
      type: 'domain'
    });
  });

  return tree;
}

function findFirstDomain(nodes, path = []) {
  for (const node of nodes) {
    const currentPath = [...path, { id: node.id, name: node.name, type: node.type }];
    if (node.type === 'domain') {
      return { node, path: currentPath };
    }
    if (node.children && node.children.length > 0) {
      const found = findFirstDomain(node.children, currentPath);
      if (found) return found;
    }
  }
  return null;
}

function updateSelectedPath(path) {
  currentSelectedPath = path;
  const lastItem = path[path.length - 1];
  if (lastItem && lastItem.type === 'domain') {
    // Sync with existing logic
    // We need a way to trigger data reload when domainId changes
    const domainId = lastItem.id;
    // Call existing loadInstances or whatever was bound to domainSelect change
    loadInstances(domainId).then(() => {
      updateSummaryCardsDisabledState();
      loadData();
    });
  }
}

function renderHierarchicalSelector() {
  const container = document.getElementById('breadcrumbContainer');
  if (!container) return;
  container.innerHTML = '';

  if (currentSelectedPath.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'breadcrumb-item loading';
    empty.textContent = '選択できるドメインがありません';
    container.appendChild(empty);
    return;
  }

  currentSelectedPath.forEach((item, index) => {
    // Add separator if not the first item
    if (index > 0) {
      const sep = document.createElement('div');
      sep.className = 'breadcrumb-separator';
      sep.textContent = '>';
      container.appendChild(sep);
    }

    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'breadcrumb-item';

    // Icon (Cube style)
    const icon = document.createElement('span');
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;

    const text = document.createElement('span');
    text.textContent = item.name;

    breadcrumb.appendChild(icon);
    breadcrumb.appendChild(text);

    // Dropdown arrow for groups
    if (item.type === 'group' || index === currentSelectedPath.length - 1) {
      const arrow = document.createElement('span');
      arrow.style.marginLeft = '4px';
      arrow.style.fontSize = '0.7rem';
      arrow.textContent = '▼';
      breadcrumb.appendChild(arrow);
    }

    breadcrumb.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.selector-popover').forEach(p => p.classList.remove('active'));

      let levelItems = domainTree;
      const basePath = currentSelectedPath.slice(0, index);
      for (let i = 0; i < index; i++) {
        const found = levelItems.find(n => n.name === currentSelectedPath[i].name);
        if (found) levelItems = found.children;
      }

      const popover = createPopover(levelItems, (selectedPath) => {
        const finalPath = [...basePath, ...selectedPath];
        const lastSelected = finalPath[finalPath.length - 1];

        if (lastSelected.type === 'domain') {
          updateSelectedPath(finalPath);
          renderHierarchicalSelector();
        } else {
          // Find first domain in selected subgroup
          // We need to look into the node tree to find it
          let targetNode = domainTree;
          for (let i = 0; i < finalPath.length; i++) {
            const found = targetNode.find(n => n.name === finalPath[i].name);
            if (found) targetNode = (found.type === 'group') ? found.children : [found];
          }
          const firstInGroup = findFirstDomain(targetNode, finalPath);
          if (firstInGroup) {
            updateSelectedPath(firstInGroup.path);
            renderHierarchicalSelector();
          }
        }
      });

      breadcrumb.appendChild(popover);
      setTimeout(() => popover.classList.add('active'), 0);
    });

    container.appendChild(breadcrumb);
  });
}

function createPopover(items, onSelect, level = 0, currentLevelPath = []) {
  const popover = document.createElement('div');
  popover.className = 'selector-popover';
  if (level > 0) popover.classList.add('submenu');

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'popover-item';
    if (item.children && item.children.length > 0) el.classList.add('has-children');

    // Path including current item
    const itemPath = [...currentLevelPath, { id: item.id, name: item.name, type: item.type }];

    el.innerHTML = `
      <div class="popover-item-content">
        <span class="popover-item-icon">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>
        </span>
        <span class="popover-item-name"></span>
      </div>
    `;
    // ドメイン/グループ名は API 由来の文字列なので、HTML として解釈させず textContent で入れる
    el.querySelector('.popover-item-name').textContent = item.name;

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelect(itemPath);
      document.querySelectorAll('.selector-popover').forEach(p => p.classList.remove('active'));
    });

    if (item.type === 'group' && item.children && item.children.length > 0) {
      let submenu = null;
      const showSubmenu = () => {
        if (!submenu) {
          submenu = createPopover(item.children, onSelect, level + 1, itemPath);
          el.appendChild(submenu);
        }
        submenu.classList.add('active');
        submenu.style.position = 'absolute';
        submenu.style.left = '100.2%';
        submenu.style.top = '-6px';
      };
      const hideSubmenu = () => { if (submenu) submenu.classList.remove('active'); };
      el.addEventListener('mouseenter', showSubmenu);
      el.addEventListener('mouseleave', hideSubmenu);
    }
    popover.appendChild(el);
  });

  if (level === 0) {
    const closeHandler = (e) => {
      if (!popover.contains(e.target) && !e.target.closest('.breadcrumb-item')) {
        popover.classList.remove('active');
        document.removeEventListener('click', closeHandler);
      }
    };
    document.addEventListener('click', closeHandler);
  }
  return popover;
}

async function loadInstances(domainId) {
  if (!domainId) {
    instanceSelect.innerHTML = '<option value="">全体インスタンス</option>';
    return;
  }

  const url = new URL(INSTANCE_API_BASE, window.location.origin);
  url.searchParams.append('domain_id', domainId);
  const urlString = url.toString();

  try {
    const response = await fetch(urlString, {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (response.status === 401) {
      showConfigError('Authentication failed. Please contact the site administrator to check the server-side API token.', 'Unauthorized (401)');
      return;
    }

    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

    const data = await response.json();
    let instances = data.result || [];

    // Sort by instanceId ascending
    instances.sort((a, b) => a.instanceId - b.instanceId);

    // Clear and populate select box
    instanceSelect.innerHTML = '<option value="">全体インスタンス</option>';
    instances.forEach(instance => {
      const option = document.createElement('option');
      option.value = instance.instanceId;
      option.textContent = instance.name;
      instanceSelect.appendChild(option);
    });
  } catch (error) {
    console.error(`Failed to load instances for domain ${domainId}. URL: ${urlString}`, error);

    // 本番ではダミーのインスタンスを出さない (実在しないインスタンスを選ばせないため)
    const mockInstances = MOCK_ALLOWED
      ? [
        { instanceId: '1', name: `Instance-${domainId}-1` },
        { instanceId: '2', name: `Instance-${domainId}-2` }
      ]
      : [];
    if (!MOCK_ALLOWED) showNotice('インスタンス一覧を取得できませんでした。', 'warn');

    instanceSelect.innerHTML = '<option value="">全体インスタンス</option>';
    mockInstances.forEach(instance => {
      const option = document.createElement('option');
      option.value = instance.instanceId;
      option.textContent = instance.name;
      instanceSelect.appendChild(option);
    });
  }

  // Also load businesses for this domain
  fetchBusinesses(domainId);
}

async function fetchBusinesses(domainId) {
  if (!domainId) return;

  const url = new URL(BUSINESS_API_BASE, window.location.origin);
  url.searchParams.append('domain_id', domainId);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

    const data = await response.json();
    let businesses = data.result || [];

    // Clear and populate business select box
    businessSelect.innerHTML = '<option value="">全体ビジネス</option>';

    businesses.forEach(biz => {
      const option = document.createElement('option');
      option.value = biz.businessId;

      // Indentation based on businessIndex (e.g. "0.0" -> 1 level)
      const dotCount = (String(biz.businessIndex ?? '').match(/\./g) || []).length;
      const indent = '\u00A0\u00A0'.repeat(dotCount); // 2 spaces per level

      option.textContent = indent + biz.name;
      businessSelect.appendChild(option);
    });
  } catch (error) {
    console.error(`Failed to load businesses for domain ${domainId}`, error);
    businessSelect.innerHTML = '<option value="">全体ビジネス</option>';
  }
}

// 連続呼び出し時、最後に開始した読み込みのみが画面を更新するための世代番号
let loadDataSeq = 0;

async function loadData() {
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
  metricThresholds = {};
  overallYThresholds = {};

  try {
    const today = new Date();

    // Main Chart & Summary Metrics: 1년을 12개의 단위로 (월별 분할) 조회 - 최대 31일 제한 우회 및 일별 데이터(1440분) 지정
    // sys_cpu/heap_usage/max_sys_cpu are instance-only metrics; skip fetching them for business targets
    const isInstanceTarget = targetType === 'instance';
    const instanceOnlyMetrics = ['sys_cpu', 'heap_usage', 'max_sys_cpu'];
    if (!isInstanceTarget) {
      instanceOnlyMetrics.forEach(m => { if (m !== currentMetric) yearlyData[m] = []; });
    }
    const metricsToFetch = Array.from(new Set([
      currentMetric, 'service_time', 'service_rate', 'concurrent_user', 'service_count', 'service_err_count',
      ...(isInstanceTarget ? instanceOnlyMetrics : [])
    ])).filter(m => m !== 'err_rate');
    const fetchPromisesMap = {};
    metricsToFetch.forEach(m => fetchPromisesMap[m] = []);
    let totalRequests = 0;
    let failedRequests = 0;

    for (let i = 11; i >= 0; i--) {
      const monthStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
      // API end_time is exclusive, so use the 1st day of the next month instead of the 0th day (last day of current month)
      const monthEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 1);

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
      yearlyData[m] = mergeSeries(results[m]);
    });

    // Calculate Error Rate (err_rate)
    yearlyData['err_rate'] = computeErrRate(yearlyData['service_count'] || [], yearlyData['service_err_count'] || []);

    // Update UI Elements for Chart
    const activeBtn = document.querySelector(`.metric-btn[data-metric="${currentMetric}"]`);
    const metricDisplayName = activeBtn ? activeBtn.textContent : '応答時間';

    // Update main chart
    updateChart('mainChart', metricDisplayName, yearlyData[currentMetric], '#22c55e', mainChartInstance, (instance) => {
      mainChartInstance = instance;
    });

    // Reset selection state; handleChartSelectionChanged() below refreshes the range
    // display, summary cards, and heatmaps for the full 1-year view in one pass.
    selectedStartMonth = null;
    selectedEndMonth = null;
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

async function fetchMetricData(domainId, targetId, targetType, startTime, endTime, intervalMinute, metrics) {
  if (!domainId) {
    console.error('fetchMetricData called without domainId');
    return [];
  }

  let endpoint;
  if (!targetId) {
    endpoint = `${API_BASE}/domain`;
  } else {
    endpoint = targetType === 'instance' ? `${API_BASE}/instance` : BUSINESS_METRICS_API_BASE;
  }

  const url = new URL(endpoint, window.location.origin);

  // Construct params
  url.searchParams.append('domain_id', domainId);

  if (targetId) {
    if (targetType === 'instance') {
      url.searchParams.append('instance_id', targetId);
    } else {
      url.searchParams.append('business_id', targetId);
    }
  }
  url.searchParams.append('time_pattern', 'yyyyMMddHH');
  url.searchParams.append('start_time', startTime);
  url.searchParams.append('end_time', endTime);
  url.searchParams.append('interval_minute', intervalMinute);
  url.searchParams.append('metrics', metrics);

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });

    if (response.status === 401) {
      showConfigError('Authentication failed. Please contact the site administrator to check the server-side API token.', 'Unauthorized (401)');
      return [];
    }

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const data = await response.json();
    return data.result || [];
  } catch (error) {
    console.warn(`API fetch for ${metrics} failed. URL: ${url.toString()}`, error);
    if (error.name === 'TypeError') {
      console.warn('Network error or CORS issue. If this is a local development environment, ensure the proxy is correctly configured.');
    }
    throw error;
  }
}

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
    const curMetricData = yearlyData[currentMetric] || [];
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
      isSelecting = true;
      dragStartX = event.x;
      dragCurrentX = event.x;
      args.changed = true;
    } else if (event.type === 'mousemove' && isSelecting) {
      dragCurrentX = event.x;
      args.changed = true;
    } else if (event.type === 'mouseup' || (event.type === 'mouseout' && isSelecting)) {
      if (isSelecting) {
        isSelecting = false;

        // Calculate selected range based on pixel coordinates
        if (Math.abs(dragCurrentX - dragStartX) > 10) {
          // Drag selection
          const xAxis = chart.scales.x;
          let val1 = xAxis.getValueForPixel(dragStartX);
          let val2 = xAxis.getValueForPixel(dragCurrentX);

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

          selectedStartMonth = chart.data.labels[idx1].split('/')[0];
          selectedEndMonth = chart.data.labels[idx2].split('/')[0];

          // Set active boundary based on drag direction
          activeSelectionBoundary = (dragCurrentX < dragStartX) ? 'start' : 'end';

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
            if (selectedStartMonth === clickedMonth && selectedEndMonth === clickedMonth) {
              selectedStartMonth = null;
              selectedEndMonth = null;
              activeSelectionBoundary = 'end';
            } else {
              selectedStartMonth = clickedMonth;
              selectedEndMonth = clickedMonth;
              activeSelectionBoundary = 'end';
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
    if (isSelecting && dragStartX !== null && dragCurrentX !== null) {
      ctx.save();
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'; // Blue tint for selection box
      const start = Math.min(dragStartX, dragCurrentX);
      const width = Math.abs(dragCurrentX - dragStartX);
      ctx.fillRect(start, chartArea.top, width, chartArea.bottom - chartArea.top);
      ctx.restore();
    }

    // Draw finalized selected months highlighting
    if (!isSelecting && selectedStartMonth && selectedEndMonth) {
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
          if (currentMonth === selectedStartMonth) {
            startPixel = getBoundaryX(tStartIdx);
          }
          if (currentMonth === selectedEndMonth) {
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
function updateChart(canvasId, label, data, color, chartInstance, setInstanceCallback) {
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

  if (currentChartType === 'line') {
    primaryDataset.fill = true;
    primaryDataset.tension = 0;
    primaryDataset.pointRadius = 0;
    primaryDataset.pointHoverRadius = 5;
    primaryDataset.segment = {
      borderColor: ctx => getMonthColor(ctx, color, showMA ? '4d' : ''), // Increased border alpha (0.15 -> 0.3)
      backgroundColor: ctx => getMonthColor(ctx, color, showMA ? '26' : '66') // Increased fill alpha (0.08 -> 0.15)
    };
  } else { // bar
    primaryDataset.backgroundColor = ctx => getMonthColor(ctx, color, showMA ? '26' : '66');
    primaryDataset.borderColor = ctx => getMonthColor(ctx, color, showMA ? '4d' : '');
  }
  datasets.push(primaryDataset);

  // Handle System CPU dual line (Avg + Max) - Force combo chart for visibility
  if (currentMetric === 'sys_cpu' && yearlyData['max_sys_cpu'].length > 0) {
    // 1. Re-adjust Primary (Avg) style for CPU
    primaryDataset.label = '平均CPU';
    primaryDataset.order = 2; // Behind max line

    // 2. Add Max CPU as a forced Line
    const maxCpuData = yearlyData['max_sys_cpu'].map(item => item.value);
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
  if (showMA) {
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

  if (chartInstance && chartInstance.config.type !== currentChartType) {
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
      type: currentChartType,
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
                  const unit = getMetricUnit(currentMetric);
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
                const unit = getMetricUnit(currentMetric);
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
  monthlyAveragesCache = computeMonthlyAverages(data, { metric: currentMetric, todayStr: toYMD(new Date()) });
}

// 統計グリッドの再描画をスキップするための署名と、月別平均の更新世代
let statsGridSig = '';
let monthlyAveragesVersion = 0;

function updateChartStatsGrid(labels, chart) {
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


// キーボード操作で選択範囲が連続して変わるとき、API 再取得を最後の 1 回にまとめる
let selectionTimer = null;
function scheduleSelectionChanged(delay = 150) {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(handleChartSelectionChanged, delay);
}

// Selection Change Handler
async function handleChartSelectionChanged() {
  const rangeDisplay = document.getElementById('selectedRangeDisplay');
  const domainId = getCurrentDomainId();

  const targetType = document.querySelector('input[name="targetType"]:checked')?.value || 'instance';
  const targetId = targetType === 'instance' ? instanceSelect.value : businessSelect.value;

  const currentMetricData = yearlyData[currentMetric] || [];
  let startIdx = -1;
  let endIdx = -1;

  if (!selectedStartMonth || !selectedEndMonth) {
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

  // Because selectedStartMonth/EndMonth could be out of order in the UI drag (already sorted in plugin)
  const tStartMonth = selectedStartMonth;
  const tEndMonth = selectedEndMonth;

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

// 連続して選択範囲が変わったとき、古いリクエストの結果で画面を上書きしないための世代番号
let heatmapSeq = 0;

async function reloadHeatmaps(domainId, targetId, targetType, startDate, endDate) {
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

      const isHitSelected = (currentMetric === 'service_count');
      const isErrRateSelected = (currentMetric === 'err_rate');

      timePromises.push(
        fetchMetricData(domainId, targetId, targetType, chunkStartStr, chunkEndStr, 60, (isHitSelected || isErrRateSelected) ? 'service_time' : currentMetric)
          .catch(err => { console.warn(`Heatmap primary chunk failed`, err); return []; })
      );
      countPromises.push(
        fetchMetricData(domainId, targetId, targetType, chunkStartStr, chunkEndStr, 60, 'service_count')
          .catch(err => { console.warn("Heatmap service_count chunk failed", err); return []; })
      );

      if (currentMetric === 'err_rate') {
        errCountPromises.push(
          fetchMetricData(domainId, targetId, targetType, chunkStartStr, chunkEndStr, 60, 'service_err_count')
            .catch(err => { console.warn("Heatmap service_err_count chunk failed", err); return []; })
        );
      }

      currentStart = currentEnd;
    }

    const timeResults = await Promise.all(timePromises);
    const countResults = await Promise.all(countPromises);
    const errCountResults = (currentMetric === 'err_rate') ? await Promise.all(errCountPromises) : [];
    if (seq !== heatmapSeq) return;

    const combinedHeatmapData = combineHeatmapData(
      flattenSorted(timeResults),
      flattenSorted(countResults),
      currentMetric === 'err_rate' ? flattenSorted(errCountResults) : [],
      currentMetric
    );

    const isHitSelected = (currentMetric === 'service_count');
    renderDayHourHeatmap(combinedHeatmapData, isHitSelected, currentMetric);
    renderOverallHeatmap(combinedHeatmapData, isHitSelected, currentMetric);
  } catch (error) {
    console.error("Heatmaps reloading failed:", error);
  }
}

function renderDayHourHeatmap(data, isHitSelected, metric) {
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

  if (metricThresholds[metric]) {
    goodThreshold = metricThresholds[metric].good;
    warningThreshold = metricThresholds[metric].warning;
  } else {
    // Default fallback
    goodThreshold = 100;
    warningThreshold = 300;

    const computed = computeIqrThresholds(allAverages);
    if (computed) {
      goodThreshold = computed.good;
      warningThreshold = computed.warning;
      // Cache these thresholds so they persist during chart selections (filtering period)
      metricThresholds[metric] = { good: goodThreshold, warning: warningThreshold };
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
                onmouseover="showHeatmapTooltip(event, '${tooltipText}')" 
                onmouseout="hideHeatmapTooltip()">
              </td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';

  container.innerHTML = html;

  // Bind click events to meaningful cells
  const cells = container.querySelectorAll('.dayhour-cell');
  cells.forEach(cellElement => {
    const count = parseInt(cellElement.getAttribute('data-count'), 10);
    if (count > 0) {
      cellElement.addEventListener('click', () => {
        const dIdx = parseInt(cellElement.getAttribute('data-day'), 10);
        const hInt = parseInt(cellElement.getAttribute('data-hour'), 10);
        const cellData = dayHourMap[dIdx][hInt].data;
        if (cellData && cellData.length > 0) {
          window.showDayHourListLayer(cellData, metric, isHitSelected);
        }
      });
    }
  });
}

window.showDayHourListLayer = function (binData, metric, isHitSelected) {
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
};

function renderOverallHeatmap(data, isHitSelected, metric) {
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
  if (overallYThresholds[metric]) {
    medianY = overallYThresholds[metric].median;
    maxY = overallYThresholds[metric].max;
  } else {
    medianY = stats.medianY;
    maxY = stats.maxY;
    overallYThresholds[metric] = { median: medianY, max: maxY };
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
      window.showHeatmapTooltip(event, tooltipText);
    })
    .on("mouseout", function () {
      if (!d3.select(this).classed("selected-hex")) {
        d3.select(this).attr("stroke", "white").attr("stroke-width", "0.5");
      }
      window.hideHeatmapTooltip();
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

      if (window.showOverallListLayer) {
        window.showOverallListLayer(d, metric, isHitSelected);
      }
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

window.showHeatmapTooltip = function (event, text) {
  if (!globalHeatmapTooltip) return;

  globalHeatmapTooltip.innerHTML = text;
  globalHeatmapTooltip.style.display = 'block';

  const x = event.pageX + 15;
  const y = event.pageY + 15;

  globalHeatmapTooltip.style.left = x + 'px';
  globalHeatmapTooltip.style.top = y + 'px';
};

window.hideHeatmapTooltip = function () {
  if (globalHeatmapTooltip) globalHeatmapTooltip.style.display = 'none';
};


function updateSummaryCardsPartial(startIdx, endIdx) {
  const summary = summarizeRange(yearlyData, startIdx, endIdx, { metric: currentMetric, todayStr: toYMD(new Date()) });
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

// Keyboard Navigation for Chart Selection
window.addEventListener('keydown', (e) => {
  // Handle ESC key to deselect or close help
  // Handle ESC key to deselect
  if (e.key === 'Escape') {
    if (selectedStartMonth || selectedEndMonth) {
      selectedStartMonth = null;
      selectedEndMonth = null;
      handleChartSelectionChanged();
      if (mainChartInstance) mainChartInstance.update();
    }
    return;
  }

  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  // 入力欄・セレクトボックスの操作や修飾キー付きの操作は奪わない
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!mainChartInstance || !selectedStartMonth || !selectedEndMonth) return;

  const labels = mainChartInstance.data.labels;
  if (!labels || labels.length === 0) return;

  // Get unique months in order
  const uniqueMonths = [];
  labels.forEach(lbl => {
    const m = lbl.split('/')[0];
    if (!uniqueMonths.includes(m)) uniqueMonths.push(m);
  });

  let startIdx = uniqueMonths.indexOf(selectedStartMonth);
  let endIdx = uniqueMonths.indexOf(selectedEndMonth);

  if (startIdx === -1 || endIdx === -1) return;

  // Swap if needed to ensure normalized range
  if (startIdx > endIdx) {
    [startIdx, endIdx] = [endIdx, startIdx];
  }

  const shift = e.key === 'ArrowLeft' ? -1 : 1;

  if (e.shiftKey) {
    if (e.key === 'ArrowLeft') {
      if (activeSelectionBoundary === 'start') {
        const newStartIdx = startIdx - 1;
        if (newStartIdx >= 0) {
          selectedStartMonth = uniqueMonths[newStartIdx];
        } else return;
      } else {
        // activeSelectionBoundary === 'end'
        if (startIdx === endIdx) {
          // Switch to start and move left
          const newStartIdx = startIdx - 1;
          if (newStartIdx >= 0) {
            selectedStartMonth = uniqueMonths[newStartIdx];
            activeSelectionBoundary = 'start';
          } else return;
        } else {
          const newEndIdx = endIdx - 1;
          selectedEndMonth = uniqueMonths[newEndIdx];
        }
      }
    } else {
      // ArrowRight
      if (activeSelectionBoundary === 'end') {
        const newEndIdx = endIdx + 1;
        if (newEndIdx < uniqueMonths.length) {
          selectedEndMonth = uniqueMonths[newEndIdx];
        } else return;
      } else {
        // activeSelectionBoundary === 'start'
        if (startIdx === endIdx) {
          // Switch to end and move right
          const newEndIdx = endIdx + 1;
          if (newEndIdx < uniqueMonths.length) {
            selectedEndMonth = uniqueMonths[newEndIdx];
            activeSelectionBoundary = 'end';
          } else return;
        } else {
          const newStartIdx = startIdx + 1;
          selectedStartMonth = uniqueMonths[newStartIdx];
        }
      }
    }
    scheduleSelectionChanged();
    mainChartInstance.update();
  } else {
    // Shift the entire range
    const newStartIdx = startIdx + shift;
    const newEndIdx = endIdx + shift;
    if (newStartIdx >= 0 && newEndIdx < uniqueMonths.length) {
      selectedStartMonth = uniqueMonths[newStartIdx];
      selectedEndMonth = uniqueMonths[newEndIdx];
      scheduleSelectionChanged();
      mainChartInstance.update();
    }
  }
});

// Fallback logic for when API is unreachable due to CORS or local network issues
function mockDataOnFailPartial() {
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

  yearlyData['service_time'] = mockDates.map(d => ({ time: d, value: 3000 + Math.random() * 2000 }));
  yearlyData['service_rate'] = mockDates.map(d => ({ time: d, value: 2 + Math.random() * 5 }));
  yearlyData['concurrent_user'] = mockDates.map(d => ({ time: d, value: 100 + Math.random() * 200 }));
  yearlyData['service_count'] = mockDates.map(d => ({ time: d, value: 5000 + Math.random() * 15000 }));
  yearlyData['service_err_count'] = mockDates.map(d => ({ time: d, value: Math.random() * 500 }));
  yearlyData['sys_cpu'] = mockDates.map(d => ({ time: d, value: 10 + Math.random() * 25 }));
  yearlyData['max_sys_cpu'] = mockDates.map(d => ({ time: d, value: 40 + Math.random() * 50 }));
  yearlyData['heap_usage'] = mockDates.map(d => ({ time: d, value: 30 + Math.random() * 40 }));

  // Update main chart
  const activeBtn = document.querySelector(`.metric-btn[data-metric="${currentMetric}"]`);
  const metricDisplayName = activeBtn ? activeBtn.textContent : '応答時間';

  updateChart('mainChart', metricDisplayName, yearlyData[currentMetric], '#22c55e', mainChartInstance, (instance) => {
    mainChartInstance = instance;
  });
  updateSummaryCardsPartial(0, yearlyData['service_time'].length - 1);

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
  renderDayHourHeatmap(heatmapMockData, false, currentMetric);
  renderOverallHeatmap(heatmapMockData, false, currentMetric);
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
document.addEventListener('DOMContentLoaded', () => {
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
});

window.showOverallListLayer = function (dataPoints, metric, isHitSelected) {
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
};
