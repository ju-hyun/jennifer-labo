/**
 * ドメイン階層セレクタと、インスタンス/ビジネス一覧の取得
 */
import { fetchDomains, fetchInstances, fetchBusinesses, ApiError } from './api.js';
import { buildDomainTree, findFirstDomain } from '../shared/domain-tree.js';
import { MOCK_ALLOWED } from './config.js';
import { state } from './state.js';
import { el } from './dom.js';
import { showNotice } from './notice.js';

export function closePopovers() {
  document.querySelectorAll('.breadcrumb-popover').forEach((p) => p.remove());
}

function renderBreadcrumb() {
  el.breadcrumb.innerHTML = '';
  closePopovers();

  if (state.selectedPath.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'breadcrumb-item loading';
    empty.textContent = '選択できるドメインがありません';
    el.breadcrumb.appendChild(empty);
    return;
  }

  state.selectedPath.forEach((node, level) => {
    if (level > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-sep';
      sep.textContent = '›';
      el.breadcrumb.appendChild(sep);
    }

    const item = document.createElement('button');
    item.type = 'button';
    item.className = `breadcrumb-item ${node.type === 'domain' ? 'is-domain' : ''}`;
    item.textContent = node.name;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      const siblings = level === 0 ? state.domainTree : state.selectedPath[level - 1].children;
      openPopover(item, siblings, level);
    });
    el.breadcrumb.appendChild(item);
  });
}

function openPopover(anchor, items, level) {
  const alreadyOpen = document.querySelector('.breadcrumb-popover');
  closePopovers();
  if (alreadyOpen && alreadyOpen.dataset.level === String(level)) return;

  const pop = document.createElement('div');
  pop.className = 'breadcrumb-popover';
  pop.dataset.level = String(level);

  items.forEach((node) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `popover-item ${node.type === 'domain' ? 'is-domain' : ''}`;
    btn.textContent = node.name;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      selectNode([...state.selectedPath.slice(0, level), node]);
      closePopovers();
    });
    pop.appendChild(btn);
  });

  const rect = anchor.getBoundingClientRect();
  pop.style.left = `${rect.left + window.scrollX}px`;
  pop.style.top = `${rect.bottom + window.scrollY + 4}px`;
  document.body.appendChild(pop);
}

function selectNode(path) {
  // グループが選ばれた場合は配下の最初のドメインまで降りる
  let finalPath = path;
  const last = path[path.length - 1];
  if (last.type === 'group') {
    const found = findFirstDomain(last.children, path);
    if (found) finalPath = found.path;
  }
  state.selectedPath = finalPath;
  renderBreadcrumb();

  const domainId = getDomainId();
  if (domainId) loadTargets(domainId);
}

export function getDomainId() {
  const last = state.selectedPath[state.selectedPath.length - 1];
  return last && last.type === 'domain' ? last.id : null;
}

/* ------------------------------------------------------------------ */
/* 対象リスト                                                          */
/* ------------------------------------------------------------------ */

export async function loadDomains() {
  try {
    const flat = await fetchDomains();
    state.domainTree = buildDomainTree(flat);
  } catch (err) {
    console.error('Failed to load domains:', err);
    if (MOCK_ALLOWED) {
      showNotice('ドメイン一覧の取得に失敗しました。モックのドメインで表示しています。', 'warn');
      state.domainTree = buildDomainTree([
        { domainId: 1000, name: 'REALTIME, ANALYSIS', groupHierarchy: ['JENNIFER DEMO', 'MSA'] },
        { domainId: 1004, name: 'Total', groupHierarchy: ['Total'] }
      ]);
    } else {
      const reason =
        err instanceof ApiError && err.status === 401
          ? '認証に失敗しました (401)。サーバ側のAPIトークン設定をご確認ください。'
          : 'ドメイン一覧の取得に失敗しました。ネットワークとAPIプロキシの設定をご確認ください。';
      showNotice(reason, 'error');
      state.domainTree = [];
    }
  }

  const first = findFirstDomain(state.domainTree);
  if (first) {
    state.selectedPath = first.path;
    renderBreadcrumb();
    await loadTargets(getDomainId());
  } else {
    // 取得失敗または0件: 「データロード中...」のまま残さず、選択できない旨を表示する
    renderBreadcrumb();
  }
}

async function loadTargets(domainId) {
  const seq = ++state.targetsSeq;
  const [instances, businesses] = await Promise.all([
    fetchInstances(domainId).catch(() => []),
    fetchBusinesses(domainId).catch(() => [])
  ]);
  // 待機中に別のドメインへ切り替えられていたら、古い結果は反映しない
  if (seq !== state.targetsSeq) return;

  el.instanceSelect.innerHTML = '<option value="">全体インスタンス</option>';
  instances.forEach((inst) => {
    const opt = document.createElement('option');
    opt.value = inst.instanceId;
    opt.textContent = inst.name;
    el.instanceSelect.appendChild(opt);
  });

  el.businessSelect.innerHTML = '<option value="">全体ビジネス</option>';
  businesses.forEach((biz) => {
    const opt = document.createElement('option');
    opt.value = biz.businessId;
    const depth = (String(biz.businessIndex ?? '').match(/\./g) || []).length;
    opt.textContent = '  '.repeat(depth) + biz.name;
    el.businessSelect.appendChild(opt);
  });

  state.instanceId = '';
  state.businessId = '';
}

/* ------------------------------------------------------------------ */
/* 収集                                                                */
/* ------------------------------------------------------------------ */
