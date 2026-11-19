import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveContentPaths } from '../src/runtime/content-paths.mjs';
import { exportContent } from '../scripts/export-content.mjs';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'knowledge-content-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, 'source');
  for (const folder of ['build', 'dist', 'dist-public']) await mkdir(join(source, folder), { recursive: true });
  await writeFile(join(source, 'build/documents.json'), JSON.stringify({ version: 1, documents: [], targets: [] }));
  for (const folder of ['dist', 'dist-public']) { await writeFile(join(source, folder, 'index.html'), '<h1>汉字 北京午饭</h1>'); await writeFile(join(source, folder, 'photo.jpg'), Buffer.from([1, 2, 3])); }
  return { dir, source };
}
test('exports exact published bytes and resolves standalone and prefixed external content', async t => {
  const { dir, source } = await fixture(t), destination = join(dir, 'external');
  assert.equal((await exportContent(destination, { root: source })).files, 5);
  const local = resolveContentPaths({ KNOWLEDGE_CONTENT_ROOT: destination });
  const managed = resolveContentPaths({ KNOWLEDGE_CONTENT_ROOT: destination, KNOWLEDGE_BASE_PATH: '/apps/knowledge/' });
  assert.equal(local.staticDir, join(destination, 'published-standalone'));
  assert.equal(managed.staticDir, join(destination, 'published'));
  assert.deepEqual(await readFile(join(local.staticDir, 'photo.jpg')), Buffer.from([1, 2, 3]));
  assert.deepEqual(local.catalog.documents, []);
  await assert.rejects(exportContent(destination, { root: source }), /already exists/);
  await assert.rejects(exportContent(join(source, 'private'), { root: source }), /separate/);
});
test('rejects missing, relative, symbolic and invalid explicit content instead of falling back', async t => {
  const { dir, source } = await fixture(t);
  assert.throws(() => resolveContentPaths({ KNOWLEDGE_CONTENT_ROOT: 'relative' }), /absolute/);
  assert.throws(() => resolveContentPaths({ KNOWLEDGE_CONTENT_ROOT: join(dir, 'missing') }), /ENOENT/);
  assert.throws(() => resolveContentPaths({ KNOWLEDGE_DOCUMENT_CATALOG: join(dir, 'missing.json') }), /ENOENT/);
  await symlink(source, join(dir, 'alias'));
  assert.throws(() => resolveContentPaths({ KNOWLEDGE_CONTENT_ROOT: join(dir, 'alias') }), /canonical/);
  await writeFile(join(source, 'build/documents.json'), '{}');
  assert.throws(() => resolveContentPaths({ KNOWLEDGE_DOCUMENT_CATALOG: join(source, 'build/documents.json') }), /invalid/);
});
test('keeps default standalone paths and refuses symbolic export sources', async t => {
  const { dir, source } = await fixture(t);
  const defaults = resolveContentPaths({}, { root: source });
  assert.equal(defaults.staticDir, join(source, 'dist'));
  await symlink(join(source, 'dist/photo.jpg'), join(source, 'dist/alias.jpg'));
  await assert.rejects(exportContent(join(dir, 'external'), { root: source }), /regular files/);
});
