/**
 * ドメイン階層ツリー (PTA / PD 共通)
 *
 * API の /api/domain は groupHierarchy (グループ名の配列) を持つフラットな一覧を返す。
 * これをグループ→ドメインのツリーにする。ノード:
 *   グループ: { type: 'group',  name, children: [...] }
 *   ドメイン: { type: 'domain', id (文字列), name, children: [] }
 */

export function buildDomainTree(flatDomains) {
  const tree = [];
  flatDomains.forEach((domain) => {
    let level = tree;
    const hierarchy = domain.groupHierarchy?.length ? domain.groupHierarchy : ['未分類ドメイン'];

    hierarchy.forEach((groupName) => {
      let node = level.find((n) => n.type === 'group' && n.name === groupName);
      if (!node) {
        node = { type: 'group', name: groupName, children: [] };
        level.push(node);
      }
      level = node.children;
    });

    level.push({ type: 'domain', id: String(domain.domainId), name: domain.name, children: [] });
  });
  return tree;
}

/** 深さ優先で最初のドメインを探す。path はルートからそのドメインまでのノード列 */
export function findFirstDomain(nodes, path = []) {
  for (const node of nodes) {
    const nextPath = [...path, node];
    if (node.type === 'domain') return { node, path: nextPath };
    const found = findFirstDomain(node.children ?? [], nextPath);
    if (found) return found;
  }
  return null;
}
