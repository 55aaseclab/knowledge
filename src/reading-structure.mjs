export const removedSectionUrls = new Set();
const kinds = new Set(['section', 'chapter', 'part']);
function safeHref(value) {
  if (typeof value !== 'string' || !/^\/(?:[^/]+\/)*$/.test(value)) return false;
  let decoded; try { decoded = decodeURIComponent(value); } catch { return false; }
  return !/[\\\s?#%\u0000-\u001f]/.test(decoded) && !decoded.includes('//') && !decoded.split('/').some(part => part === '.' || part === '..');
}
export function validateReadingStructure(value, { targets } = {}) {
  if (!value || value.version !== 1 || !Array.isArray(value.nodes) || !Array.isArray(value.home) || value.nodes.length > 5000) throw new Error('The reading structure is invalid.');
  const nodes = new Map(), parents = new Map(), hrefs = new Set();
  for (const node of value.nodes) {
    if (!node || typeof node.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,199}$/.test(node.id) || nodes.has(node.id) || !kinds.has(node.kind) || typeof node.title !== 'string' || !node.title.trim() || node.title.length > 200 || !Array.isArray(node.children) || new Set(node.children).size !== node.children.length || Object.keys(node).some(key => !['id','kind','title','href','children'].includes(key))) throw new Error('A reading node is invalid.');
    if (!safeHref(node.href) || targets && !targets.has(node.href) || removedSectionUrls.has(node.href)) throw new Error('A reading destination is invalid.');
    if (node.kind === 'section' && (node.children.length || hrefs.has(node.href))) throw new Error('A section must identify one unique page.');
    if (node.kind === 'section') hrefs.add(node.href);
    nodes.set(node.id, node);
  }
  for (const node of nodes.values()) for (const id of node.children) {
    const child = nodes.get(id);
    if (!child || parents.has(id) || node.kind === 'chapter' && child.kind !== 'section' || node.kind === 'part' && child.kind === 'section') throw new Error('The reading parent-child relation is invalid.');
    parents.set(id, node.id);
  }
  const complete = new Set(), active = new Set();
  const visit = id => {
    if (active.has(id)) throw new Error('The reading structure contains a cycle.');
    if (complete.has(id)) return;
    active.add(id); for (const child of nodes.get(id).children) visit(child); active.delete(id); complete.add(id);
  };
  for (const id of nodes.keys()) visit(id);
  if (new Set(value.home).size !== value.home.length || value.home.some(id => !nodes.has(id))) throw new Error('A reading home entry is invalid.');
  return value;
}
export function buildReadingStructure({ documents, homeItems, order = new Map(), groupTitles = new Map() }) {
  const records = documents.filter(item => !removedSectionUrls.has(item.url));
  const bySourceRoot = new Map(), nodes = [], assigned = new Set(), targets = new Set(records.map(item => item.url));
  const compare = (a, b) => (order.get(a.url) ?? Infinity) - (order.get(b.url) ?? Infinity) || a.sourcePath.localeCompare(b.sourcePath, 'en', { numeric: true });
  const section = record => {
    if (!assigned.has(record.id)) { nodes.push({ id: record.id, kind: 'section', title: record.navigationTitle || record.title, href: record.url, children: [] }); assigned.add(record.id); }
    return record.id;
  };
  for (const record of records) {
    const root = record.sourcePath.split('/')[0];
    if (!bySourceRoot.has(root)) bySourceRoot.set(root, []);
    bySourceRoot.get(root).push(record);
  }
  const home = [];
  function container(path, group, id, title, landing) {
    const direct = [], branches = new Map();
    for (const record of group) {
      const rest = record.sourcePath.slice(path.length + 1).split('/');
      if (rest.length === 1) direct.push(record);
      else { const child = rest[0]; if (!branches.has(child)) branches.set(child, []); branches.get(child).push(record); }
    }
    direct.sort(compare);
    if (!branches.size) {
      const ordered = [...direct];
      if (landing) { const index = ordered.findIndex(item => item.url === landing); if (index > 0) ordered.unshift(...ordered.splice(index, 1)); }
      const children = ordered.map(section);
      nodes.push({ id, kind: 'chapter', title, href: landing || ordered[0].url, children });
      return id;
    }
    const children = [];
    if (direct.length) {
      const ordered = [...direct];
      if (landing) { const index = ordered.findIndex(item => item.url === landing); if (index > 0) ordered.unshift(...ordered.splice(index, 1)); }
      const introId = `${id}-sections`;
      nodes.push({ id: introId, kind: 'chapter', title: groupTitles.get(path) || title, href: landing || ordered[0].url, children: ordered.map(section) });
      children.push(introId);
    }
    const sorted = [...branches].sort((a,b) => compare(a[1].slice().sort(compare)[0], b[1].slice().sort(compare)[0]));
    for (const [name, items] of sorted) {
      const childPath = `${path}/${name}`, childId = `${id}-${name.replace(/[^a-z0-9-]/g, '-')}`;
      children.push(container(childPath, items, childId, groupTitles.get(childPath) || name, items.find(item => /\/(?:index|readme)\.[^.]+$/i.test(item.sourcePath))?.url));
    }
    nodes.push({ id, kind: 'part', title, href: landing || nodes.find(node => node.id === children[0]).href, children });
    return id;
  }
  for (const item of homeItems) {
    const group = bySourceRoot.get(item.id) || records.filter(record => record.url === '/' + item.href);
    if (!group.length) throw new Error(`A reading home destination is unpublished: ${item.id}`);
    if (group.length === 1) home.push(section(group[0]));
    else home.push(container(item.id, group, item.id, item.title, '/' + item.href));
  }
  for (const record of records) if (!assigned.has(record.id)) section(record);
  return validateReadingStructure({ version: 1, nodes, home }, { targets });
}
export function readingContext(structure, currentPath, { basePath = '/' } = {}) {
  const index = new Map(structure.nodes.map(node => [node.id, node]));
  const base = basePath.replace(/\/$/, '');
  let path = String(currentPath).split(/[?#]/, 1)[0];
  try { path = decodeURIComponent(path); } catch { path = ''; }
  if (base && (path === base || path.startsWith(base + '/'))) path = path.slice(base.length) || '/';
  path = path.replace(/index\.html$/, '').replace(/\/?$/, '/');
  const current = structure.nodes.find(node => node.kind === 'section' && node.href === path);
  if (!current) return { container: null, tree: null, section: null, sections: [], prev: null, previous: null, next: null };
  const resolve = id => { const node = index.get(id); return { ...node, children: node.children.map(resolve) }; };
  const leaves = node => node.kind === 'section' ? [node] : node.children.flatMap(leaves);
  const home = structure.home.map(resolve).find(node => leaves(node).some(section => section.id === current.id));
  const parent = structure.nodes.find(node => node.kind !== 'section' && node.children.includes(current.id));
  const container = home || resolve(parent?.id || current.id), sections = leaves(container), at = sections.findIndex(node => node.id === current.id);
  const prev = sections[at - 1] || null;
  return { container, tree: container, section: resolve(current.id), sections, prev, previous: prev, next: sections[at + 1] || null };
}
