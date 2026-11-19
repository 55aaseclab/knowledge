import { createServer as httpServer } from 'node:http';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname, isAbsolute, relative, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeStore } from './store.mjs';
import { loadBusinessService } from './business.mjs';
import { ACTIONS, fail, fields, identifier } from './schema.mjs';
import { imageCacheHeaders, imageNotModified } from './image-cache.mjs';
import { projectDocumentHtml } from './document-renderer.mjs';
import { resolveContentPaths } from './content-paths.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
const defaultPublic = resolve(directory, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.pdf': 'application/pdf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4' };
const security = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const uiSecurity = { ...security, 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'" };
function json(request, response, status, result) {
  const body = JSON.stringify(result);
  response.writeHead(status, { ...security, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); response.end(request.method === 'HEAD' ? undefined : body);
}
async function resolveStaticFile(root, pathname) {
  if (!root) fail('NOT_FOUND', 404);
  const base = await realpath(root);
  let file = await realpath(resolve(base, `.${pathname}`));
  const within = relative(base, file);
  if (within === '..' || within.startsWith(`..${sep}`) || within.startsWith(sep)) fail('NOT_FOUND', 404);
  if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, 'index.html'));
  const final = relative(base, file);
  if (final === '..' || final.startsWith(`..${sep}`) || final.startsWith(sep)) fail('NOT_FOUND', 404);
  const info = await stat(file);
  if (!info.isFile()) fail('NOT_FOUND', 404);
  return { file, info };
}
async function staticFile(request, response, root, pathname, headers = security) {
  const { file, info } = await resolveStaticFile(root, pathname);
  const type = types[extname(file).toLowerCase()] || 'application/octet-stream';
  const imageHeaders = imageCacheHeaders(type, info);
  if (imageNotModified(request, imageHeaders)) { response.writeHead(304, { ...headers, ...imageHeaders }); response.end(); return; }
  let start = 0, finish = info.size - 1, status = 200;
  if (request.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
    if (!match || (!match[1] && !match[2]) || !info.size) { response.setHeader('Content-Range', `bytes */${info.size}`); fail('INVALID_RANGE', 416); }
    if (match[1]) { start = Number(match[1]); finish = match[2] ? Math.min(Number(match[2]), finish) : finish; }
    else start = Math.max(0, info.size - Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish) || start > finish || start >= info.size) { response.setHeader('Content-Range', `bytes */${info.size}`); fail('INVALID_RANGE', 416); }
    status = 206; response.setHeader('Content-Range', `bytes ${start}-${finish}/${info.size}`);
  }
  response.writeHead(status, { ...headers, 'Content-Type': type, 'Content-Length': info.size ? finish - start + 1 : 0, 'Accept-Ranges': 'bytes', ...imageHeaders });
  if (request.method === 'HEAD' || !info.size) { response.end(); return; }
  createReadStream(file, { start, end: finish }).on('error', () => response.destroy()).pipe(response);
}
export function createServer({ store, business = null, managed = Boolean(business), publicDir = defaultPublic, staticDir = null, basePath = '/', localSpace = 'local', documentTargets = [] } = {}) {
  if (!store || managed && !business || !identifier(localSpace)) throw new Error('Knowledge requires a configured store and managed business service.');
  if (typeof basePath !== 'string' || !/^\/(?:[a-z0-9][a-z0-9-]*\/)*$/.test(basePath)) throw new Error('The base path must be an absolute normalized path with a trailing slash.');
  // External publications may predate the catalog's content categories.
  const bundledCatalog = resolve(directory, '../../dist/reading-catalog.json');
  const categories = new Map(existsSync(bundledCatalog)
    ? JSON.parse(readFileSync(bundledCatalog, 'utf8')).items.map(item => [item.href, item.category])
    : []);
  const baselineNodes = new Map((store.baselineStructure?.nodes || []).map(node => [node.id, node]));
  return httpServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, async (request, response) => {
    try {
      const rawPath = request.url || '/';
      let decoded;
      try { decoded = decodeURIComponent(rawPath.split('?')[0]); } catch { fail('NOT_FOUND', 404); }
      if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u0020]/.test(decoded) || decoded.includes('%') || decoded.includes('#') || decoded.split('/').some(part => part.startsWith('.')) || /^\/@(?:fs|id|vite)(?:\/|$)/.test(decoded)) fail('NOT_FOUND', 404);
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (decoded === '/health') return json(request, response, 200, { status: 'ok', managed });
        if (decoded === '/api/config') return json(request, response, 200, { managed, basePath, spaces: managed ? [] : [{ id: localSpace, name: '本地' }] });
        if (decoded === '/reading-catalog.json' && !store.legacyAvailable && (!staticDir || !existsSync(join(staticDir, 'reading-catalog.json')))) return json(request, response, 200, { version: 2, items: [] });
        if (decoded === '/reading-catalog.json' && store.baselineStructure) {
          const { file } = await resolveStaticFile(staticDir, decoded);
          const published = JSON.parse(await readFile(file, 'utf8'));
          const labels = new Map(published.items.map(item => [item.id, item]));
          const items = store.baselineStructure.home.map(id => {
            const node = baselineNodes.get(id);
            const href = node.href.slice(1);
            // A standalone section can have a distinct publication title and catalog ID.
            const label = labels.get(id) ?? (node.kind === 'section'
              ? published.items.find(item => item.href === href && !baselineNodes.has(item.id))
              : undefined);
            const category = label?.category ?? categories.get(href);
            const sectionCount = item => item.kind === 'section' ? 1 : item.children.reduce((count, child) => count + sectionCount(baselineNodes.get(child)), 0);
            return { id: label?.id ?? id, title: label?.title ?? node.title, href, kind: node.kind,
              ...(category ? { category } : {}), ...(category === 'note' ? { noteCount: sectionCount(node) } : {}) };
          });
          return json(request, response, 200, { version: 2, items });
        }
        if (decoded.startsWith('/api/')) fail('NOT_FOUND', 404);
        if (decoded === '/' || decoded === '/index.html' || /^\/k\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\/[a-z0-9][a-z0-9-]{0,79}\/(?:[a-z0-9][a-z0-9-]{0,79}\/)?$/.test(decoded)) { const body = (await readFile(join(publicDir, 'index.html'), 'utf8')).replaceAll('__KNOWLEDGE_BASE_PATH__', basePath); response.writeHead(200, { ...uiSecurity, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body) }); response.end(request.method === 'HEAD' ? undefined : body); return; }
        if (decoded === '/workspace-assets/app.js' || decoded === '/workspace-assets/styles.css') return await staticFile(request, response, publicDir, decoded.slice('/workspace-assets'.length), uiSecurity);
        if (decoded === '/library/' || decoded === '/library') return await staticFile(request, response, staticDir, '/index.html');
        const documentPath = decoded.replace(/index\.html$/, '').replace(/\/?$/, '/');
        const currentDocument = store.documentAtUrl?.(localSpace, documentPath);
        const readingContext = currentDocument && store.readingContext?.(localSpace, documentPath);
        const addedSections = readingContext?.sections.some(section => !baselineNodes.has(section.id));
        if (currentDocument && (currentDocument.version > 1 || currentDocument.authoredSection || addedSections)) {
          let templateUrl = currentDocument.url;
          if (currentDocument.authoredSection) {
            const parent = store.readingStructure?.(localSpace)?.nodes.find(node => node.kind === 'chapter' && node.children.includes(currentDocument.id));
            const baseline = parent && baselineNodes.get(parent.id);
            const member = baseline?.kind === 'chapter' && baseline.children.some(id => {
              const section = baselineNodes.get(id);
              return section?.kind === 'section' && section.href === baseline.href;
            });
            if (!readingContext?.section || !member) fail('NOT_FOUND', 404);
            templateUrl = baseline.href;
            const published = store.documentAtUrl?.(localSpace, templateUrl);
            if (!published || published.authoredSection) fail('NOT_FOUND', 404);
          }
          const root = await realpath(staticDir);
          const file = await realpath(resolve(root, '.' + templateUrl, 'index.html'));
          const contained = relative(root, file);
          if (contained.startsWith('..') || isAbsolute(contained)) fail('NOT_FOUND', 404);
          const body = await projectDocumentHtml(await readFile(file, 'utf8'), currentDocument, { targets: documentTargets, basePath, readingContext });
          response.writeHead(200, { ...security, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'X-Knowledge-Document-Version': String(currentDocument.version) });
          response.end(request.method === 'HEAD' ? undefined : body); return;
        }
        return await staticFile(request, response, staticDir, decoded);
      }
      if (request.method !== 'POST' || !['/api/business', '/api/invoke'].includes(decoded) || rawPath.includes('?')) fail('METHOD_NOT_ALLOWED', 405);
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) fail('JSON_REQUIRED', 415);
      if (decoded === '/api/business' && !business) fail('BUSINESS_UNAVAILABLE', 503);
      if (decoded === '/api/invoke' && managed) fail('BUSINESS_AUTH_REQUIRED', 403);
      if (Number(request.headers['content-length']) > 4194304) { request.resume(); fail('REQUEST_TOO_LARGE', 413); }
      const parts = []; let length = 0;
      for await (const part of request) { length += part.length; if (length > 4194304) { request.resume(); fail('REQUEST_TOO_LARGE', 413); } parts.push(part); }
      const raw = Buffer.concat(parts);
      let result;
      if (decoded === '/api/business') result = business.handle(raw, request.headers['x-praxis-assertion']);
      else {
        let input; try { input = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_REQUEST'); }
        fields(input, ['operation'], ['spaceId', 'resourceId', 'input']);
        if (input.spaceId !== undefined && input.spaceId !== localSpace || ACTIONS[input.operation] !== 'read') fail('FORBIDDEN', 403);
        result = store.execute({ ...input, spaceId: localSpace }, { spaceId: localSpace, action: 'read', resources: ['*'], expiresAt: Date.now() + 20000 });
      }
      json(request, response, 200, result);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(request, response, error.status || (['ENOENT', 'ENOTDIR'].includes(error.code) ? 404 : 500), { code: error.status ? error.code : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'NOT_FOUND' : 'INTERNAL_ERROR' });
      else if (!response.destroyed) response.destroy();
    }
  });
}
async function main() {
  const args = process.argv.slice(2); let host = process.env.HOST || '127.0.0.1', port = Number(process.env.PORT || 4324);
  if (args.includes('--help')) { process.stdout.write('Usage: node src/runtime/server.mjs [--host ADDRESS] [--port PORT]\nKnowledge stores private runtime data in KNOWLEDGE_DATA_DIR. Set KNOWLEDGE_CONTENT_ROOT for external published content and catalog.\n'); return; }
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--host' && args[i + 1]) host = args[i + 1];
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) port = Number(args[i + 1]);
    else throw new Error('Unknown or incomplete server argument.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer from 1 through 65535.');
  const dataDir = process.env.KNOWLEDGE_DATA_DIR || join(homedir(), '.local/share/praxis-builtins/knowledge');
  if (!isAbsolute(dataDir)) throw new Error('KNOWLEDGE_DATA_DIR must be absolute.');
  const basePath = process.env.KNOWLEDGE_BASE_PATH || '/';
  const { staticDir, catalog } = resolveContentPaths(process.env, { basePath });
  const store = new KnowledgeStore(join(dataDir, 'knowledge.db'), { legacyAvailable: existsSync(join(staticDir, 'index.html')), basePath, documents: catalog.documents, readingStructure: catalog.structure });
  const business = loadBusinessService(store);
  const server = createServer({ store, business, staticDir, basePath, localSpace: process.env.KNOWLEDGE_LOCAL_SPACE || (business?.spaces?.size === 1 ? [...business.spaces][0] : 'local'), documentTargets: catalog.targets });
  server.listen(port, host, () => process.stdout.write(`Knowledge listening on http://${host}:${port}\n`));
  const stop = () => { server.close(() => { store.close(); process.exit(0); }); server.closeIdleConnections(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
