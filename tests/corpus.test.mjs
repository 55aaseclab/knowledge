import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { KnowledgeStore } from '../src/runtime/store.mjs';
import { ACTIONS } from '../src/runtime/schema.mjs';

test('scoped original import preserves bytes, indexes Chinese text and reads a cited passage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'knowledge-corpus-'));
  const inboxRoot = join(root, 'inbox'), db = join(root, 'knowledge.db');
  const spaceId = 'example', resourceId = 'main';
  await mkdir(join(inboxRoot, spaceId, resourceId), { recursive: true });
  let store = new KnowledgeStore(db, { inboxRoot, basePath: '/apps/knowledge/' });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const invoke = (operation, input, props = {}, resources = [resourceId]) => {
    const action = ACTIONS[operation];
    return store.execute({ operation, spaceId, resourceId, input,
      ...(action !== 'read' ? { idempotencyKey: randomUUID() } : {}), ...props },
      { spaceId, action, resources, expiresAt: Date.now()+20_000, clientId: 'tester', grantId: 'test', userId: 'test', requestId: randomUUID() });
  };
  const fixture = '岗位定薪：先评估岗位等级，再按相同等级的薪酬区间给出建议。';
  const attachmentId = createHash('sha256').update(fixture).digest('hex');
  const input = { attachmentId, filename: '手册.txt', title: '合成手册' };
  invoke('create_library', { name: '测试' });
  assert.throws(() => invoke('import_document', input, {expectedRevision: '1'}), /ATTACHMENT_NOT_FOUND/);
  await writeFile(join(inboxRoot,spaceId,resourceId,attachmentId), fixture);
  const revision = { expectedRevision: '1', idempotencyKey: 'submit' };
  const saved = invoke('import_document', input, revision);
  assert.equal(saved.document.status, 'queued');
  assert.deepEqual(invoke('import_document', input, revision), saved);
  const deadline = Date.now() + 15_000;
  let read;
  do {
    await delay(25);
    read = invoke('read_document', { documentId: attachmentId });
  } while (['queued','processing'].includes(read.document.status) && Date.now()<deadline);
  assert.equal(read.document.status, 'ready', JSON.stringify(read));
  assert.equal(read.items[0].text, fixture);
  assert.ok(read.items[0].locator);
  assert.equal(invoke('read_library', {}).documents[0].id, attachmentId);
  assert.throws(() => invoke('search_evidence', {query: '薪酬'}, {}, ['other']), /FORBIDDEN/);
  await rm(inboxRoot, {recursive:true});
  store.close();
  store = new KnowledgeStore(db, { inboxRoot, basePath: '/apps/knowledge/' });
  const hit = invoke('search_evidence', {query: '招聘定薪', limit: 1}).items[0];
  assert.equal(hit.text, fixture);
  assert.equal(hit.documentId, attachmentId);
  assert.equal(hit.href, '/apps/knowledge/k/example/main/?document=' + attachmentId + '&offset=0#passage-0');
  assert.equal(invoke('read_document', {documentId: hit.documentId, offset: hit.ordinal, limit:1}).items[0].locator, hit.locator);
  assert.equal(Buffer.from(store.db.prepare('SELECT data FROM corpus_originals WHERE document=?').get(attachmentId).data).toString('utf8'), fixture);
});
