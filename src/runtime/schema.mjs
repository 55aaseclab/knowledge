import { validatePaperSnapshot } from './paper-statistics.mjs';
export const ACTIONS = Object.freeze({ list_libraries: 'read', read_library: 'read', create_library: 'create', import_document: 'update', read_document: 'read', search_evidence: 'read', set_collection: 'update', add_source: 'update', import_paper_statistics: 'update', capture_project: 'update', read_source: 'read', set_entry: 'update', insert_document_text: 'update', delete_document_text: 'update', replace_document_text: 'update', read_entry: 'read', search: 'read', events: 'read' });
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
export const slug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const collectionId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,199}$/.test(value);
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export function fail(code = 'INVALID_INPUT', status = 400, message = code) { throw Object.assign(new Error(message), { code, status }); }
export function fields(value, required, optional = []) {
  if (!object(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail();
}
export function text(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || !empty && (!value.trim() || value !== value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail();
  return value;
}
function ids(value, maximum = 200) {
  if (!Array.isArray(value) || value.length > maximum || value.some(id => !slug(id)) || new Set(value).size !== value.length) fail();
  return [...value];
}
function verbatim(value, max) { text(value, max, true); if (!value.trim()) fail(); return value; }
function optionalText(value, max) { return value === undefined ? '' : text(value, max, true); }
function validId(value) { if (!slug(value)) fail(); return value; }
function version(value) { if (typeof value !== 'string' || !/^[1-9]\d{0,14}$/.test(value) || !Number.isSafeInteger(Number(value))) fail(); return value; }
const isDocumentId = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
function boundedInteger(value, min, max, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}
export function validateInput(operation, input = {}) {
  if (operation === 'import_document') {
    fields(input, ['attachmentId', 'filename', 'title']);
    if (!isDocumentId(input.attachmentId) || /[\\/]/.test(input.filename) || ['.', '..'].includes(input.filename)) fail();
    return { attachmentId: input.attachmentId, filename: text(input.filename, 200), title: text(input.title, 160) };
  }
  if (operation === 'read_document') {
    fields(input, ['documentId'], ['offset', 'limit', 'includeOutline', 'outlineOffset', 'outlineLimit']);
    if (!isDocumentId(input.documentId) || (input.includeOutline !== undefined && typeof input.includeOutline !== 'boolean')) fail();
    if (!input.includeOutline && (input.outlineOffset !== undefined || input.outlineLimit !== undefined)) fail();
    return {
      documentId: input.documentId,
      offset: boundedInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0),
      limit: boundedInteger(input.limit, 1, 50, 25),
      ...(input.includeOutline ? {
        includeOutline: true,
        outlineOffset: boundedInteger(input.outlineOffset, 0, Number.MAX_SAFE_INTEGER, 0),
        outlineLimit: boundedInteger(input.outlineLimit, 1, 200, 100),
      } : {}),
    };
  }
  if (operation === 'search_evidence') {
    fields(input, ['query'], ['documentId', 'limit']);
    if (input.documentId !== undefined && !isDocumentId(input.documentId)) fail();
    return { query: text(input.query, 200), ...(input.documentId ? { documentId: input.documentId } : {}), limit: boundedInteger(input.limit, 1, 30, 10) };
  }
  if (operation === 'import_paper_statistics') {
    fields(input, ['snapshot']);
    return { snapshot: validatePaperSnapshot(input.snapshot) };
  }
  if (operation === 'create_library') {
    fields(input, ['name'], ['description']);
    return { name: text(input.name, 160), description: optionalText(input.description, 2000) };
  }
  if (operation === 'set_collection') {
    fields(input, ['id', 'title', 'description', 'entryIds']);
    if (!collectionId(input.id)) fail();
    return { id: input.id, title: text(input.title, 160), description: optionalText(input.description, 2000), entryIds: ids(input.entryIds) };
  }
  if (operation === 'add_source') {
    fields(input, ['id', 'title', 'kind', 'text'], ['url']);
    if (!['text', 'url'].includes(input.kind)) fail();
    const url = input.url ?? null;
    if (input.kind === 'url') {
      if (typeof url !== 'string' || url.length > 2048 || /[\s\\]/.test(url)) fail();
      let parsed; try { parsed = new URL(url); } catch { fail(); }
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) fail();
    } else if (url !== null) fail();
    return { id: validId(input.id), title: text(input.title, 160), kind: input.kind, text: verbatim(input.text, 200000), url };
  }
  if (operation === 'capture_project') {
    fields(input, ['sourceId', 'sourceSpaceId', 'projectId', 'projectRevision', 'snapshot']);
    if (!identifier(input.sourceSpaceId) || !object(input.snapshot) || input.snapshot.id !== input.projectId || input.snapshot.revision !== input.projectRevision || Buffer.byteLength(JSON.stringify(input.snapshot)) > 2097152) fail();
    text(input.snapshot.name, 160);
    return { sourceId: validId(input.sourceId), sourceSpaceId: input.sourceSpaceId, projectId: validId(input.projectId), projectRevision: version(input.projectRevision), snapshot: input.snapshot };
  }
  if (operation === 'read_source') { fields(input, ['sourceId']); return { sourceId: validId(input.sourceId) }; }
  if (operation === 'set_entry') {
    fields(input, ['id', 'title', 'kind', 'body', 'tags', 'sourceRefs', 'status']);
    if (!['note', 'method', 'conclusion'].includes(input.kind) || !['draft', 'published', 'archived'].includes(input.status)) fail();
    if (!Array.isArray(input.tags) || input.tags.length > 200 || new Set(input.tags).size !== input.tags.length) fail();
    const tags = input.tags.map(tag => text(tag, 80));
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length < 1 || input.sourceRefs.length > 100) fail();
    const sourceRefs = input.sourceRefs.map(ref => { fields(ref, ['sourceId', 'locator']); return { sourceId: validId(ref.sourceId), locator: text(ref.locator, 300, true) }; });
    if (new Set(sourceRefs.map(ref => `${ref.sourceId}\0${ref.locator}`)).size !== sourceRefs.length) fail();
    if (input.status === 'published' && !sourceRefs.length) fail('SOURCE_REQUIRED', 422);
    return { id: validId(input.id), title: text(input.title, 160), kind: input.kind, body: verbatim(input.body, 200000), tags, sourceRefs, status: input.status };
  }
  if (operation === 'replace_document_text') {
    fields(input, ['entryId', 'oldText', 'newText']);
    return { entryId: validId(input.entryId), oldText: verbatim(input.oldText, 200000), newText: text(input.newText, 200000, true) };
  }
  if (operation === 'insert_document_text') {
    fields(input, ['entryId', 'anchorText', 'text', 'position']);
    if (!['before', 'after'].includes(input.position)) fail();
    return { entryId: validId(input.entryId), anchorText: verbatim(input.anchorText, 200000), text: verbatim(input.text, 200000), position: input.position };
  }
  if (operation === 'delete_document_text') {
    fields(input, ['entryId', 'text']);
    return { entryId: validId(input.entryId), text: verbatim(input.text, 200000) };
  }
  if (operation === 'read_entry') {
    fields(input, ['entryId'], ['version']);
    if (input.version !== undefined && (!Number.isSafeInteger(input.version) || input.version < 1)) fail();
    return { entryId: validId(input.entryId), ...(input.version === undefined ? {} : { version: input.version }) };
  }
  if (operation === 'search') {
    fields(input, ['query'], ['collectionId', 'limit']);
    if (input.collectionId !== undefined && !collectionId(input.collectionId) || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50)) fail();
    return { query: text(input.query, 100), limit: input.limit ?? 30, ...(input.collectionId ? { collectionId: input.collectionId } : {}) };
  }
  if (operation === 'events') {
    fields(input, [], ['after']);
    if (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) fail();
    return { after: input.after ?? 0 };
  }
  fields(input, []); return {};
}
export function validateRequest(request) {
  fields(request, ['operation', 'spaceId'], ['resourceId', 'input', 'expectedRevision', 'idempotencyKey']);
  if (!Object.hasOwn(ACTIONS, request.operation) || !identifier(request.spaceId)) fail('INVALID_REQUEST');
  const action = ACTIONS[request.operation];
  if (['list_libraries', 'events'].includes(request.operation)) { if (request.resourceId !== undefined) fail('INVALID_REQUEST'); }
  else if (!slug(request.resourceId)) fail('RESOURCE_REQUIRED');
  if (action === 'read') { if (request.expectedRevision !== undefined || request.idempotencyKey !== undefined) fail('INVALID_REQUEST'); }
  else {
    if (request.resourceId === 'legacy-library' && !['set_entry', 'set_collection', 'add_source', 'insert_document_text', 'delete_document_text', 'replace_document_text'].includes(request.operation)) fail('READ_ONLY_RESOURCE', 403);
    if (!identifier(request.idempotencyKey)) fail('IDEMPOTENCY_REQUIRED', 428);
    if (action === 'create') { if (request.expectedRevision !== undefined) fail('INVALID_REQUEST'); }
    else { try { version(request.expectedRevision); } catch { fail('REVISION_REQUIRED', 428); } }
  }
  return { ...request, input: validateInput(request.operation, request.input) };
}
