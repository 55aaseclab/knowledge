import { createHash } from 'node:crypto';
import { slug, text } from './schema.mjs';

export const LEGACY_LIBRARY = 'legacy-library';
const digest = value => createHash('sha256').update(value).digest('hex');
export function documentSeeds(values) {
  if (!Array.isArray(values) || values.length > 2000) throw new Error('The document catalog is invalid.');
  const result = new Map(), urls = new Set();
  for (const value of values) {
    if (!value || !slug(value.id) || result.has(value.id)) throw new Error('The document identifier is invalid.');
    text(value.title, 160); text(value.body, 2000000, true);
    if (typeof value.url !== 'string' || !/^\/(?:[^/]+\/)*$/.test(value.url) || /[\\\s?#\u0000-\u001f]/.test(value.url) || value.url.includes('//') || value.url.split('/').some(part => part === '.' || part === '..') || urls.has(value.url)) throw new Error('The document URL is invalid.');
    if (typeof value.sourcePath !== 'string' || !value.sourcePath || value.sourcePath.startsWith('/') || /[\\\u0000-\u001f]/.test(value.sourcePath) || value.sourcePath.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('The document source metadata is invalid.');
    if (value.hash !== digest(value.body)) throw new Error('The document content hash is invalid.');
    const document = Object.freeze({ id: value.id, title: value.title, body: value.body, url: value.url, sourcePath: value.sourcePath, hash: value.hash });
    urls.add(value.url); result.set(value.id, document);
  }
  return result;
}
export function seedSource(document) {
  return { id: `source-${document.id}`, title: document.title, kind: 'text', text: document.body, url: null, hash: document.hash, createdAt: null, origin: { appId: 'knowledge', documentId: document.id, sourcePath: document.sourcePath } };
}
export function seedEntry(document) {
  const source = seedSource(document);
  return { id: document.id, title: document.title, kind: 'note', body: document.body, tags: [], sourceRefs: [{ sourceId: source.id, locator: document.sourcePath, hash: source.hash }], status: 'published', version: 1, createdAt: null, updatedAt: null, url: document.url, sourcePath: document.sourcePath };
}
