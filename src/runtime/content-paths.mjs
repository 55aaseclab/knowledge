import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function configuredPath(value, name, kind) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute path.`);
  const path = resolve(value), info = lstatSync(path);
  if (info.isSymbolicLink() || realpathSync(path) !== path || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw new Error(`${name} must be a canonical ${kind}.`);
  return path;
}
export function resolveContentPaths(env = process.env, { root = sourceRoot, basePath = env.KNOWLEDGE_BASE_PATH || '/' } = {}) {
  const contentRoot = env.KNOWLEDGE_CONTENT_ROOT ? configuredPath(env.KNOWLEDGE_CONTENT_ROOT, 'KNOWLEDGE_CONTENT_ROOT', 'directory') : null;
  const staticValue = env.KNOWLEDGE_STATIC_DIR || (contentRoot && join(contentRoot, basePath === '/' ? 'published-standalone' : 'published'));
  const catalogValue = env.KNOWLEDGE_DOCUMENT_CATALOG || (contentRoot && join(contentRoot, 'catalog/documents.json'));
  const staticDir = staticValue ? configuredPath(staticValue, 'KNOWLEDGE_STATIC_DIR', 'directory') : resolve(root, basePath === '/' ? 'dist' : 'dist-public');
  const catalogFile = catalogValue ? configuredPath(catalogValue, 'KNOWLEDGE_DOCUMENT_CATALOG', 'file') : resolve(root, 'build/documents.json');
  if (staticValue) configuredPath(join(staticDir, 'index.html'), 'Knowledge published index', 'file');
  let catalog = { version: 1, documents: [], targets: [] };
  if (catalogValue || existsSync(catalogFile)) {
    catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
    if (catalog.version !== 1 || !Array.isArray(catalog.documents) || !Array.isArray(catalog.targets)) throw new Error('The document catalog is invalid.');
  }
  return { contentRoot, staticDir, catalogFile, catalog };
}
