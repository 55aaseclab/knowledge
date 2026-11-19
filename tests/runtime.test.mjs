import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { KnowledgeStore } from '../src/runtime/store.mjs';
import { BusinessService } from '../src/runtime/business.mjs';
import { createServer } from '../src/runtime/server.mjs';
const secret = Buffer.alloc(48, 117);
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-runtime-'));
  const store = new KnowledgeStore(join(root, 'knowledge.db'), options);
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const business = new BusinessService({ store, key: secret, spaces: ['space-a', 'space-b'] });
  let seq = 0;
  function invoke(operation, input = {}, values = {}, overrides = {}) {
    const request = { operation, spaceId: 'space-a', ...(!['list_libraries', 'events'].includes(operation) ? { resourceId: 'lib-a' } : {}), input, ...values };
    const action = ['create_library'].includes(operation) ? 'create' : ['set_collection', 'add_source', 'capture_project', 'set_entry', 'import_paper_statistics'].includes(operation) ? 'update' : 'read';
    if (action !== 'read') request.idempotencyKey ??= `receipt-${++seq}`;
    const raw = Buffer.from(JSON.stringify(request));
    const claims = { v: 1, appId: 'knowledge', userId: 'user-a', clientId: 'client-a', grantId: 'grant-a', spaceId: request.spaceId, action, resources: ['lib-a'], expiresAt: Date.now() + 20000, requestId: randomUUID(), method: 'POST', path: '/api/business', bodyHash: createHash('sha256').update(raw).digest('hex'), ...overrides };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const assertion = `${encoded}.${createHmac('sha256', secret).update(encoded).digest('base64url')}`;
    return { result: () => business.handle(raw, assertion), raw, assertion, request, claims };
  }
  const create = (id = 'lib-a', spaceId = 'space-a') => invoke('create_library', { name: '研究资料', description: '保留来源的知识' }, { resourceId: id, spaceId }, { resources: [id] }).result();
  const source = revision => invoke('add_source', { id: 'source-a', title: '原始资料', kind: 'text', text: '汉字 北京午饭，literal % _ SQL Text\n', url: null }, { expectedRevision: revision }).result();
  const entryInput = { id: 'entry-a', title: '研究方法', kind: 'method', body: '# 检查来源\n\n保留原文并记录版本。 Source RECORD\n', tags: ['科研'], sourceRefs: [{ sourceId: 'source-a', locator: '第一段' }], status: 'published' };
  return { root, store, business, invoke, create, source, entryInput };
}
const fails = (fn, code) => assert.throws(fn, error => error.code === code);

test('creates isolated libraries and filters both lists and events by resource', async t => {
  const f = await fixture(t, { legacyAvailable: true, basePath: '/apps/knowledge/' });
  f.create(); f.create('lib-b'); f.create('lib-a', 'space-b');
  const list = f.invoke('list_libraries').result();
  assert.deepEqual(list.items.map(item => item.id), ['lib-a']);
  assert.equal(f.invoke('list_libraries', {}, {}, { resources: ['*'] }).result().items.length, 3);
  assert.deepEqual(f.invoke('events').result().events.map(item => item.resourceId), ['lib-a']);
  fails(() => f.invoke('read_library', {}, { resourceId: 'lib-b' }).result(), 'FORBIDDEN');
  fails(() => f.invoke('read_library', {}, {}, { spaceId: 'space-b' }).result(), 'FORBIDDEN');
});
test('requires immutable original sources and computes server-owned hashes', async t => {
  const f = await fixture(t); f.create();
  const created = f.source('1'); assert.equal(created.revision, '2');
  const source = f.invoke('read_source', { sourceId: 'source-a' }).result().source;
  assert.equal(source.hash, createHash('sha256').update(source.text).digest('hex'));
  assert.equal(source.text.endsWith('\n'), true); assert.equal(source.origin, null); assert.ok(Date.parse(source.createdAt));
  fails(() => f.source('2'), 'IMMUTABLE_SOURCE');
  fails(() => f.invoke('add_source', { id: 'x', title: 'X', kind: 'text', text: 'X', hash: 'forged' }, { expectedRevision: '2' }).result(), 'INVALID_INPUT');
});
test('preserves entry history and validates references inside the same library', async t => {
  const f = await fixture(t); f.create(); f.source('1');
  const initial = f.invoke('set_entry', f.entryInput, { expectedRevision: '2' }).result();
  assert.equal(initial.entry.version, 1);
  f.invoke('set_entry', { ...f.entryInput, body: '修订后的方法' }, { expectedRevision: '3' }).result();
  const current = f.invoke('read_entry', { entryId: 'entry-a' }).result();
  const earlier = f.invoke('read_entry', { entryId: 'entry-a', version: 1 }).result();
  assert.equal(current.entry.version, 2); assert.equal(earlier.entry.body, f.entryInput.body);
  assert.deepEqual(current.history.map(item => item.version), [2, 1]);
  assert.equal(current.sources[0].hash, current.entry.sourceRefs[0].hash);
  assert.equal(current.sources[0].text, undefined);
  fails(() => f.invoke('set_entry', { ...f.entryInput, sourceRefs: [{ sourceId: 'absent', locator: '' }] }, { expectedRevision: '4' }).result(), 'SOURCE_NOT_FOUND');
  assert.equal(f.invoke('read_library').result().revision, '4');
});
test('uses compare-and-swap and scoped idempotency without duplicating commits', async t => {
  const f = await fixture(t); f.create();
  const request = f.invoke('add_source', { id: 'a', title: 'A', kind: 'text', text: '原文' }, { expectedRevision: '1', idempotencyKey: 'same-key' });
  const first = request.result();
  assert.deepEqual(f.invoke('add_source', request.request.input, { expectedRevision: '1', idempotencyKey: 'same-key' }).result(), first);
  fails(() => f.invoke('add_source', { ...request.request.input, text: '另一个原文' }, { expectedRevision: '1', idempotencyKey: 'same-key' }).result(), 'IDEMPOTENCY_CONFLICT');
  fails(() => f.invoke('add_source', { id: 'b', title: 'B', kind: 'text', text: '原文' }, { expectedRevision: '1' }).result(), 'CONFLICT');
  assert.equal(f.invoke('events').result().events.length, 2);
});
test('supports reusable collections and literal Chinese and ASCII search', async t => {
  const f = await fixture(t); f.create(); f.source('1');
  f.invoke('set_entry', f.entryInput, { expectedRevision: '2' }).result();
  f.invoke('set_collection', { id: 'methods', title: '方法', description: '', entryIds: ['entry-a'] }, { expectedRevision: '3' }).result();
  f.invoke('set_collection', { id: 'research', title: '科研', description: '', entryIds: ['entry-a'] }, { expectedRevision: '4' }).result();
  assert.equal(f.invoke('search', { query: '保留原文', collectionId: 'methods' }).result().items[0].id, 'entry-a');
  assert.equal(f.invoke('search', { query: 'record' }).result().items[0].id, 'entry-a');
  assert.equal(f.invoke('search', { query: '%' }).result().items.length, 0);
  assert.equal(f.invoke('read_library').result().collections.length, 2);
  fails(() => f.invoke('set_collection', { id: 'bad', title: 'Bad', description: '', entryIds: ['absent'] }, { expectedRevision: '5' }).result(), 'ENTRY_NOT_FOUND');
});
test('captures only attested same-space actual project snapshots', async t => {
  const f = await fixture(t); f.create();
  const input = { sourceId: 'project-a-v3', sourceSpaceId: 'space-a', projectId: 'project-a', projectRevision: '3', snapshot: { id: 'project-a', name: '合成项目', revision: '3', workItems: [] } };
  fails(() => f.invoke('capture_project', input, { expectedRevision: '1' }).result(), 'SOURCE_FORBIDDEN');
  f.invoke('capture_project', input, { expectedRevision: '1' }, { sourceReadGranted: true }).result();
  const source = f.invoke('read_source', { sourceId: 'project-a-v3' }).result().source;
  assert.equal(source.kind, 'project'); assert.deepEqual(JSON.parse(source.text), input.snapshot);
  assert.deepEqual(source.origin, { appId: 'projects', spaceId: 'space-a', resourceId: 'project-a', revision: '3' });
  fails(() => f.invoke('capture_project', { ...input, sourceId: 'wrong', snapshot: { ...input.snapshot, revision: '4' } }, { expectedRevision: '2' }, { sourceReadGranted: true }).result(), 'INVALID_INPUT');
  fails(() => f.invoke('capture_project', { ...input, sourceId: 'cross', sourceSpaceId: 'space-b' }, { expectedRevision: '2' }, { sourceReadGranted: true }).result(), 'SOURCE_FORBIDDEN');
});
test('rejects malformed, expired, mismatched and unauthorized assertions', async t => {
  const f = await fixture(t); f.create();
  const valid = f.invoke('read_library');
  fails(() => f.business.handle(valid.raw, `${valid.assertion}x`), 'INVALID_ASSERTION');
  fails(() => f.business.handle(Buffer.from('{}'), valid.assertion), 'INVALID_ASSERTION');
  for (const overrides of [{ expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 60000 }, { method: 'GET' }, { appId: 'projects' }, { resources: ['*', 'lib-a'] }, { injected: true }]) fails(() => f.invoke('read_library', {}, {}, overrides).result(), 'INVALID_ASSERTION');
  fails(() => f.invoke('read_library', {}, {}, { action: 'update' }).result(), 'FORBIDDEN');
  fails(() => f.invoke('create_library', { name: 'X' }, { resourceId: 'legacy-library' }, { resources: ['*'] }).result(), 'READ_ONLY_RESOURCE');
});
test('returns no new content version or event for an unchanged entry', async t => {
  const f = await fixture(t); f.create(); f.source('1');
  f.invoke('set_entry', f.entryInput, { expectedRevision: '2' }).result();
  const same = f.invoke('set_entry', f.entryInput, { expectedRevision: '3' }).result();
  assert.equal(same.revision, '3'); assert.equal(same.entry.version, 1);
  assert.equal(f.invoke('events').result().events.length, 3);
});
test('rejects unknown fields, invalid source URLs, prose in quantities and empty citations', async t => {
  const f = await fixture(t); f.create();
  for (const url of ['http://example.com', 'https://user:password@example.com', 'https://example.com/#private']) fails(() => f.invoke('add_source', { id: 'x', title: 'X', kind: 'url', text: '资料', url }, { expectedRevision: '1' }).result(), 'INVALID_INPUT');
  fails(() => f.invoke('read_entry', { entryId: 'x', version: '第二版' }).result(), 'INVALID_INPUT');
  fails(() => f.invoke('set_entry', { ...f.entryInput, sourceRefs: [] }, { expectedRevision: '1' }).result(), 'INVALID_INPUT');
  fails(() => f.invoke('search', { query: 'X', limit: '50' }).result(), 'INVALID_INPUT');
  fails(() => f.invoke('set_collection', { id: 'a', title: 'A', description: '', entryIds: [], html: '<h1>X</h1>' }, { expectedRevision: '1' }).result(), 'INVALID_INPUT');
});
test('serves the same UI on space-qualified paths while managed data requires signatures', async t => {
  const f = await fixture(t); f.create();
  const server = createServer({ store: f.store, business: f.business, basePath: '/apps/knowledge/' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(base + '/'); assert.equal(root.status, 200);
  assert.match(await root.text(), /\/apps\/knowledge\/workspace-assets\/app\.js/);
  assert.equal((await fetch(base + '/k/space-a/lib-a/entry-a/')).status, 200);
  assert.equal((await fetch(base + '/workspace-assets/app.js')).status, 200);
  assert.equal((await fetch(base + '/api/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/api/business', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  const signed = f.invoke('read_library');
  const response = await fetch(base + '/api/business', { method: 'POST', headers: { 'content-type': 'application/json', 'x-praxis-assertion': signed.assertion }, body: signed.raw });
  assert.equal(response.status, 200); assert.equal((await response.json()).library.id, 'lib-a');
});
test('keeps standalone browser access read-only and scoped to the configured space', async t => {
  const f = await fixture(t); f.create();
  const server = createServer({ store: f.store, localSpace: 'space-a' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const invoke = body => fetch(base + '/api/invoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await invoke({ operation: 'list_libraries' })).status, 200);
  assert.equal((await invoke({ operation: 'list_libraries', spaceId: 'space-b' })).status, 403);
  assert.equal((await invoke({ operation: 'create_library', resourceId: 'new', input: { name: 'X' } })).status, 403);
});
test('preserves legacy static routes, ranged PDF bytes, image validators and containment', async t => {
  const f = await fixture(t);
  const legacy = join(f.root, 'static'); await mkdir(join(legacy, 'book'), { recursive: true });
  await writeFile(join(legacy, 'index.html'), '<h1>旧书库</h1>'); await writeFile(join(legacy, 'book/index.html'), '<h1>原始章节</h1>');
  await writeFile(join(legacy, 'photo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>'); await writeFile(join(legacy, 'document.pdf'), 'PDF0123456789');
  await writeFile(join(f.root, 'private.txt'), 'private'); await symlink(join(f.root, 'private.txt'), join(legacy, 'escape.txt'));
  const server = createServer({ store: f.store, staticDir: legacy });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.match(await (await fetch(base + '/library/')).text(), /旧书库/);
  assert.match(await (await fetch(base + '/book/')).text(), /原始章节/);
  const image = await fetch(base + '/photo.svg'); assert.equal(image.status, 200); assert.match(image.headers.get('cache-control'), /private, max-age=3600/);
  const etag = image.headers.get('etag'); assert.ok(etag);
  const cached = await fetch(base + '/photo.svg', { headers: { 'if-none-match': etag } }); assert.equal(cached.status, 304); assert.equal(await cached.text(), ''); assert.equal(cached.headers.get('content-length'), null);
  assert.equal((await fetch(base + '/photo.svg', { headers: { 'if-none-match': '"other"', 'if-modified-since': 'Wed, 31 Dec 2099 00:00:00 GMT' } })).status, 200);
  const range = await fetch(base + '/document.pdf', { headers: { range: 'bytes=3-5' } }); assert.equal(range.status, 206); assert.equal(await range.text(), '012');
  assert.equal((await fetch(base + '/escape.txt')).status, 404);
  assert.equal((await fetch(base + '/.local/private')).status, 404);
  const missing = await fetch(base + '/absent.png'); assert.equal(missing.status, 404); assert.equal(missing.headers.get('cache-control'), 'no-store');
});

test('conference statistics imports are scoped snapshots and partial observations preserve prior counts', async t => {
  const f = await fixture(t); f.create(); f.create('lib-a', 'space-b');
  const original = { schemaVersion: 1, profile: 'ccf-a-papers@1', observedAt: '2026-01-01T00:00:00Z', venues: [
    { venueKey: 'conf/sample', group: 'systems', name: 'Sample', archiveStatus: 'complete', editions: [
      { year: 2025, status: 'complete', papers: 11, cachedPdfs: 7 }, { year: 2024, status: 'complete', papers: 0, cachedPdfs: 0 },
    ] },
    { venueKey: 'conf/second', group: 'software-engineering', name: 'Second', archiveStatus: 'pending', editions: [] },
  ] };
  const put = (snapshot, revision, key, claims = {}) => f.invoke('import_paper_statistics', { snapshot }, { expectedRevision: revision, idempotencyKey: key }, claims).result();
  assert.equal(put(original, '1', 'first').revision, '2');
  assert.equal(put(original, '1', 'first').revision, '2');
  assert.equal(put(original, '2', 'restated').revision, '2');
  const partial = { ...original, observedAt: '2026-01-02T00:00:00Z', venues: [{ ...original.venues[0], archiveStatus: 'partial', editions: [
    { year: 2025, status: 'partial', papers: 3, cachedPdfs: 1 }, { year: 2026, status: 'pending', papers: 0, cachedPdfs: 0 },
  ] }] };
  assert.equal(put(partial, '2', 'partial').revision, '3');
  const snapshot = f.invoke('read_library').result().paperStatistics;
  const editions = snapshot.venues.find(venue => venue.venueKey === 'conf/sample').editions;
  assert.deepEqual(editions.map(({ year, status, papers, cachedPdfs }) => [year, status, papers, cachedPdfs]), [
    [2026, 'pending', 0, 0], [2025, 'partial', 11, 7], [2024, 'pending', 0, 0],
  ]);
  assert.equal(editions[1].countsObservedAt, original.observedAt);
  assert.equal(snapshot.venues.length, 2);
  assert.equal(f.invoke('read_library', {}, { spaceId: 'space-b' }).result().paperStatistics, undefined);
  fails(() => put(original, '3', 'stale'), 'STALE_SNAPSHOT');
  fails(() => put(original, '3', 'forbidden', { resources: ['lib-b'] }), 'FORBIDDEN');
  const bad = [
    { ...partial, venues: [{ ...partial.venues[0], group: 'databases' }] },
    { ...partial, cachedPath: '/example.invalid' },
    { ...partial, year: 2025 },
    { ...partial, year: null },
    { ...partial, venues: [partial.venues[0], partial.venues[0]] },
    { ...partial, venues: [{ ...partial.venues[0], editions: [{ year: 2026, status: 'complete', papers: 2, cachedPdfs: 3 }] }] },
  ];
  for (const snapshot of bad) fails(() => put(snapshot, '3', 'invalid'), 'INVALID_INPUT');
  const complete = { ...original, observedAt: '2026-01-03T00:00:00Z' };
  assert.equal(put(complete, '3', 'latest').revision, '4');
  assert.deepEqual(f.invoke('read_library').result().paperStatistics, complete);
  const annual = { ...original, year: 2026, observedAt: '2026-02-01T00:00:00Z', venues: [
    { ...original.venues[0], archiveStatus: 'partial', editions: [{ year: 2026, status: 'partial', papers: 9, cachedPdfs: 1 }] },
  ] };
  assert.equal(put(annual, '4', 'annual').revision, '5');
  const combined = f.invoke('read_library').result().paperStatistics;
  assert.equal(combined.year, undefined);
  assert.deepEqual(combined.venues[0], { ...original.venues[0], editions: [
    ...annual.venues[0].editions, ...original.venues[0].editions.map(row => ({ ...row, countsObservedAt: complete.observedAt })),
  ] });
  assert.deepEqual(combined.venues[1], original.venues[1]);
});
