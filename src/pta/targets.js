/**
 * ドメイン / インスタンス / ビジネスの選択 (階層ブレッドクラム + 一覧の取得)
 */
import { getJson, isUnauthorized } from '../shared/http.js';
import { buildDomainTree, findFirstDomain } from '../shared/domain-tree.js';
import { BUSINESS_API_BASE, DOMAIN_API_BASE, INSTANCE_API_BASE, MOCK_ALLOWED } from './config.js';
import { state } from './state.js';
import { businessSelect, instanceSelect } from './dom.js';
import { showConfigError, showNotice } from './notice.js';
import { loadData } from './data.js';
import { updateSummaryCardsDisabledState } from './summary.js';

export async function loadDomains() {
  const url = new URL(DOMAIN_API_BASE, window.location.origin);
  const urlString = url.toString();

  try {
    const data = await getJson(url);
    let flatDomains = data.result || [];

    // Sort by domainId ascending
    flatDomains.sort((a, b) => a.domainId - b.domainId);

    // Transform flat list to tree structure based on groupHierarchy
    state.domainTree = buildDomainTree(flatDomains);

    // Initial selection: First domain found in the tree
    const firstDomain = findFirstDomain(state.domainTree);
    if (firstDomain) {
      updateSelectedPath(firstDomain.path);
    }

    renderHierarchicalSelector();
    return true;

  } catch (error) {
    if (isUnauthorized(error)) {
      showConfigError('Authentication failed. Please contact the site administrator to check the server-side API token.', 'Unauthorized (401)');
      return false;
    }
    console.error('Failed to load domains. URL:', urlString, '\nError:', error);
    if (error.name === 'TypeError') {
      console.warn('Network error or CORS issue suspected.');
    }

    if (document.querySelector('.config-error-overlay')) return false;

    if (!MOCK_ALLOWED) {
      showNotice('ドメイン一覧を取得できませんでした。ネットワークとAPIプロキシの設定をご確認ください。', 'error');
      state.domainTree = [];
      state.currentSelectedPath = [];
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

    state.domainTree = buildDomainTree(mockFlatDomains);
    const firstDomain = findFirstDomain(state.domainTree);
    if (firstDomain) {
      updateSelectedPath(firstDomain.path);
    }
    renderHierarchicalSelector();
    return false;
  }
}

function updateSelectedPath(path) {
  state.currentSelectedPath = path;
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

  if (state.currentSelectedPath.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'breadcrumb-item loading';
    empty.textContent = '選択できるドメインがありません';
    container.appendChild(empty);
    return;
  }

  state.currentSelectedPath.forEach((item, index) => {
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
    if (item.type === 'group' || index === state.currentSelectedPath.length - 1) {
      const arrow = document.createElement('span');
      arrow.style.marginLeft = '4px';
      arrow.style.fontSize = '0.7rem';
      arrow.textContent = '▼';
      breadcrumb.appendChild(arrow);
    }

    breadcrumb.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.selector-popover').forEach(p => p.classList.remove('active'));

      let levelItems = state.domainTree;
      const basePath = state.currentSelectedPath.slice(0, index);
      for (let i = 0; i < index; i++) {
        const found = levelItems.find(n => n.name === state.currentSelectedPath[i].name);
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
          let targetNode = state.domainTree;
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
    const data = await getJson(url);
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
    if (isUnauthorized(error)) {
      showConfigError('Authentication failed. Please contact the site administrator to check the server-side API token.', 'Unauthorized (401)');
      return;
    }
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

export async function fetchBusinesses(domainId) {
  if (!domainId) return;

  const url = new URL(BUSINESS_API_BASE, window.location.origin);
  url.searchParams.append('domain_id', domainId);

  try {
    const data = await getJson(url);
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
