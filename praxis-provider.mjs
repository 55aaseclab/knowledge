import { createHash } from 'node:crypto';

// This module has no store, filesystem, credential or network access. The host
// supplies narrowly bound reads after resolving the current user's authority.
const metadata = {
  "version": 1,
  "appId": "knowledge",
  "name": "Knowledge",
  "cards": {
    "supported": true
  },
  "readOperations": [
    "list_libraries",
    "read_library",
    "read_entry",
    "read_document"
  ],
  "nativeReads": [],
  "dataSources": [
    {
      "id": "database",
      "label": "Knowledge records",
      "labels": {
        "zh": "知识记录"
      },
      "kind": "sqlite",
      "location": {
        "env": "KNOWLEDGE_DATA_DIR",
        "relative": "knowledge.db"
      }
    },
    {
      "id": "inbox",
      "label": "Original attachments",
      "labels": {
        "zh": "原始附件"
      },
      "kind": "directory",
      "location": {
        "env": "KNOWLEDGE_INBOX_ROOT"
      },
      "optional": true
    },
    {
      "id": "published",
      "label": "Published content",
      "labels": {
        "zh": "发布内容"
      },
      "kind": "directory",
      "location": {
        "env": "KNOWLEDGE_CONTENT_ROOT"
      },
      "optional": true
    }
  ]
};
export function describe() { return structuredClone(metadata); }
const text = (value, limit = 800) => typeof value === 'string' ? value.slice(0, limit) : '';
const encode = value => encodeURIComponent(String(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const array = (value, key) => { if (!Array.isArray(value?.[key])) throw new Error('INVALID_SOURCE_RESPONSE'); return value[key]; };
const issue = state => state.errors.push({ code: 'SOURCE_UNAVAILABLE' });
function result(state) {
  const items = [...new Map(state.items.map(item => [item.id, item])).values()];
  return { status: state.errors.length ? state.reads ? 'partial' : 'unavailable' : items.length ? 'ready' : 'empty', items, ...(state.errors.length ? { errors: state.errors } : {}) };
}
function card({ spaceId = 'native-view', resourceId, objectId = resourceId, revision, title, preview, href, reason, reasonZh, kind = 'result', evidence = [], dueDate, updatedAt }) {
  if (!resourceId || !title || revision === undefined || revision === null || !String(revision) || typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) throw new Error('INVALID_SOURCE_PROJECTION');
  const version = String(revision);
  return { id: `${metadata.appId}:${encode(spaceId)}:${encode(objectId)}`, appId: metadata.appId, spaceId, resourceId, revision: version, kind,
    title: text(title, 240), ...(text(preview) ? { preview: text(preview) } : {}), reason,
    labels: { zh: { reason: reasonZh } },
    source: { name: metadata.name, appId: metadata.appId, spaceId, resourceId, revision: version, href },
    primaryAction: { label: `Open in ${metadata.name}`, labels: { zh: `在 ${metadata.name} 中打开` }, href },
    evidence: [{ label: 'Source record', labels: { zh: '原始记录' }, href, revision: version }, ...evidence],
    ...(dueDate ? { dueDate } : {}), ...(updatedAt ? { updatedAt } : {}) };
}
async function scoped(context, project) {
  const state = { items: [], errors: [], reads: 0 };
  if (!Array.isArray(context?.spaces) || typeof context?.invoke !== 'function') return { status: 'unavailable', items: [], errors: [{ code: 'READ_CONTEXT_UNAVAILABLE' }] };
  const read = async request => {
    try { const value = await context.invoke(request); if (!value || typeof value !== 'object') throw new Error('INVALID_SOURCE_RESPONSE'); state.reads++; return value; }
    catch { issue(state); return null; }
  };
  for (const spaceId of new Set(context.spaces)) {
    if (typeof spaceId !== 'string' || !spaceId) { issue(state); continue; }
    try { await project(spaceId, read, state); } catch { issue(state); }
  }
  return result(state);
}
async function native(context, project) {
  if (typeof context?.readNative !== 'function') return { status: 'unavailable', items: [], errors: [{ code: 'READ_CONTEXT_UNAVAILABLE' }] };
  const state = { items: [], errors: [], reads: 0 };
  try { const value = await context.readNative({ path: metadata.nativeReads[0], resourceId: metadata.nativeResourceId }); if (!value || typeof value !== 'object') throw new Error('INVALID_SOURCE_RESPONSE'); state.reads++; await project(value, state); }
  catch { issue(state); }
  return result(state);
}
export async function getDataInventory(context) {
  if (typeof context?.resolveDataSource !== 'function') return { status: 'unavailable', items: [], errors: [{ code: 'DATA_CONTEXT_UNAVAILABLE' }] };
  const items = [], errors = [];
  for (const source of metadata.dataSources) {
    try {
      const resolved = await context.resolveDataSource(structuredClone(source));
      if (!resolved) throw new Error('UNRESOLVED_SOURCE');
      for (const [index, value] of (Array.isArray(resolved) ? resolved : [resolved]).entries()) {
        const { hostPath, containerPath, volumeName, storageKey, status, description } = value;
        items.push({ id: Array.isArray(resolved) ? `${source.id}:${value.id || index}` : source.id, appId: metadata.appId, label: source.label, labels: source.labels, kind: source.kind, status: status || 'ready',
          ...(hostPath ? { hostPath } : {}), ...(containerPath ? { containerPath } : {}), ...(volumeName ? { volumeName } : {}), ...(storageKey ? { storageKey } : {}), ...(description || source.description ? { description: description || source.description } : {}) });
      }
    } catch { errors.push({ id: source.id, code: 'DATA_SOURCE_UNAVAILABLE' }); items.push({ id: source.id, appId: metadata.appId, label: source.label, labels: source.labels, kind: source.kind, status: 'unavailable' }); }
  }
  return { status: errors.length ? items.some(item => item.status !== 'unavailable') ? 'partial' : 'unavailable' : items.length ? 'ready' : 'empty', items, ...(errors.length ? { errors } : {}) };
}

export async function getCards(context) {
  return scoped(context, async (spaceId, read, state) => {
    const listing = await read({ spaceId, operation: 'list_libraries', input: {} }); if (!listing) return;
    for (const library of array(listing, 'items')) {
      const resourceId = library.resourceId || library.id;
      const snapshot = await read({ spaceId, operation: 'read_library', resourceId, input: {} }); if (!snapshot) continue;
      const base = `/apps/knowledge/k/${encode(spaceId)}/${encode(resourceId)}/`;
      for (const entry of array(snapshot, 'entries')) {
        if (entry.status === 'archived') continue;
        const detail = await read({ spaceId, operation: 'read_entry', resourceId, input: { entryId: entry.id } }); if (!detail) continue;
        const current = detail.entry; if (!current) { issue(state); continue; }
        const href = typeof current.url === 'string' && current.url.startsWith('/apps/knowledge/') ? current.url : `${base}${encode(current.id)}/`;
        const revision = `${detail.revision}:${current.version}`;
        state.items.push(card({ spaceId, resourceId, objectId: `${resourceId}/entry/${current.id}`, revision, title: current.title, preview: current.body, href, reason: 'Saved knowledge entry', reasonZh: '已保存的知识条目', updatedAt: current.updatedAt,
          evidence: [{ label: 'Entry text', labels: { zh: '条目原文' }, excerpt: text(current.body), href, revision }, ...(detail.sources || []).map(source => ({ label: source.title || 'Source', href, ...(source.hash ? { contentHash: source.hash } : {}) }))] }));
      }
      for (const document of array(snapshot, 'documents')) {
        const detail = await read({ spaceId, operation: 'read_document', resourceId, input: { documentId: document.id, offset: 0, limit: 3 } }); if (!detail) continue;
        const href = `${base}?${new URLSearchParams({ document: document.id, offset: '0' })}`;
        const excerpt = (detail.items || []).map(passage => passage.text).filter(Boolean).join('\n');
        const revision = digest(detail.document || document);
        state.items.push(card({ spaceId, resourceId, objectId: `${resourceId}/document/${document.id}`, revision, title: document.title, preview: excerpt, href, reason: document.status === 'partial' || document.status === 'failed' ? 'Document needs source review' : 'Indexed source document', reasonZh: document.status === 'partial' || document.status === 'failed' ? '资料解析需要核对' : '已索引的来源资料',
          evidence: (detail.items || []).map(passage => ({ label: passage.locator || passage.source || 'Source passage', excerpt: text(passage.text), href: `${href}#passage-${passage.ordinal}`, revision })) }));
      }
    }
  });
}
