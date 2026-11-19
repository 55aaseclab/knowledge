import { CorpusStore } from './corpus-store.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, lstatSync, existsSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { mergePaperStatistics } from './paper-statistics.mjs';
import { ACTIONS, fail, validateRequest } from './schema.mjs';
import { documentSeeds, seedEntry, seedSource, LEGACY_LIBRARY } from './document-seeds.mjs';
import { validateReadingStructure, readingContext as projectReadingContext } from '../reading-structure.mjs';
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(value).digest('hex');
const allowed = (claims, resourceId) => claims.resources.includes('*') || claims.resources.includes(resourceId);
const sourceMeta = source => { const { text, ...metadata } = source; return metadata; };
const entryMeta = entry => { const { body, ...metadata } = entry; return metadata; };
function safePath(file) {
  if (!isAbsolute(file)) throw new Error('The database path must be absolute.');
  for (let path = file; path !== dirname(path); path = dirname(path)) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error('The database path must not contain symbolic links.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
export class KnowledgeStore {
  constructor(file, { now = Date.now, legacyAvailable = false, basePath = '/', documents = [], readingStructure, inboxRoot = process.env.KNOWLEDGE_INBOX_ROOT } = {}) {
    safePath(file); mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.now = now; this.documents = documentSeeds(documents); this.legacyAvailable = legacyAvailable || this.documents.size > 0; this.basePath = basePath;
    this.baselineStructure = readingStructure === undefined ? null : validateReadingStructure(structuredClone(readingStructure), { targets: new Set([...this.documents.values()].map(document => document.url)) });
    const priorMask = process.umask(0o077);
    try {
      this.db = new DatabaseSync(file); chmodSync(file, 0o600);
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
        CREATE TABLE IF NOT EXISTS knowledge_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS libraries(space TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(space,id));
        CREATE TABLE IF NOT EXISTS sources(space TEXT NOT NULL,library TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(space,library,id));
        CREATE TABLE IF NOT EXISTS entries(space TEXT NOT NULL,library TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(space,library,id,version));
        CREATE TABLE IF NOT EXISTS paper_statistics(space TEXT NOT NULL,library TEXT NOT NULL,source_hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(space,library));
        CREATE TABLE IF NOT EXISTS collections(space TEXT NOT NULL,library TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(space,library,id));
        CREATE TABLE IF NOT EXISTS knowledge_receipts(space TEXT NOT NULL,resource TEXT NOT NULL,user_id TEXT NOT NULL,client_id TEXT NOT NULL,grant_id TEXT NOT NULL,key TEXT NOT NULL,fingerprint TEXT NOT NULL,response TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(space,resource,user_id,client_id,grant_id,key));
        CREATE TABLE IF NOT EXISTS knowledge_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,space TEXT NOT NULL,resource TEXT NOT NULL,revision TEXT NOT NULL,operation TEXT NOT NULL,committed_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_requests(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
      this.db.prepare("INSERT OR IGNORE INTO knowledge_meta VALUES('schema_version','1')").run();
      if (this.db.prepare("SELECT value FROM knowledge_meta WHERE key='schema_version'").get().value !== '1') throw new Error('The database schema version is unsupported.');
      this.corpus = new CorpusStore(this.db, file, inboxRoot);
      for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600);
    } finally { process.umask(priorMask); }
  }
  close() { this.corpus.close(); this.db.close(); }
  readDocument(spaceId, resourceId, documentId, offset = 0, limit = 25, options = {}) {
    return this.corpus.read(spaceId, resourceId, documentId, offset, limit, options);
  }
  library(space, id) {
    const row = this.db.prepare('SELECT payload FROM libraries WHERE space=? AND id=?').get(space, id);
    if (!row && id === LEGACY_LIBRARY && this.documents.size) return { id, name: '书库', description: '', revision: '1', updatedAt: null };
    if (!row) fail('NOT_FOUND', 404);
    return JSON.parse(row.payload);
  }
  source(space, library, id) {
    const row = this.db.prepare('SELECT payload FROM sources WHERE space=? AND library=? AND id=?').get(space, library, id);
    if (!row && library === LEGACY_LIBRARY) {
      const document = [...this.documents.values()].find(value => `source-${value.id}` === id);
      if (document) return seedSource(document);
    }
    if (!row) fail('SOURCE_NOT_FOUND', 404);
    return JSON.parse(row.payload);
  }
  entry(space, library, id, version) {
    const row = version === undefined ? this.db.prepare('SELECT payload FROM entries WHERE space=? AND library=? AND id=? ORDER BY version DESC LIMIT 1').get(space, library, id) : this.db.prepare('SELECT payload FROM entries WHERE space=? AND library=? AND id=? AND version=?').get(space, library, id, version);
    if (!row && library === LEGACY_LIBRARY && (version === undefined || version === 1) && this.documents.has(id)) return seedEntry(this.documents.get(id));
    if (!row) fail('ENTRY_NOT_FOUND', 404);
    return JSON.parse(row.payload);
  }
  readDocumentProjection(spaceId, documentId) {
    if (this.documents.has(documentId)) return this.entry(spaceId, LEGACY_LIBRARY, documentId);
    const row = this.db.prepare('SELECT payload FROM entries WHERE space=? AND library=? AND id=? ORDER BY version DESC LIMIT 1').get(spaceId, LEGACY_LIBRARY, documentId);
    const entry = row ? JSON.parse(row.payload) : null;
    return entry?.authoredSection === true ? entry : null;
  }
  documentAtUrl(spaceId, url) {
    const document = [...this.documents.values()].find(value => value.url === url);
    if (document) return this.entry(spaceId, LEGACY_LIBRARY, document.id);
    return this.latest(spaceId, LEGACY_LIBRARY).find(entry => entry.authoredSection === true && entry.url === url) || null;
  }
  latest(space, library) {
    const entries = this.db.prepare('SELECT payload FROM entries WHERE space=? AND library=? AND (id,version) IN (SELECT id,MAX(version) FROM entries WHERE space=? AND library=? GROUP BY id) ORDER BY id').all(space, library, space, library).map(row => JSON.parse(row.payload));
    if (library !== LEGACY_LIBRARY) return entries;
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    return [...this.documents.keys()].map(id => byId.get(id) || seedEntry(this.documents.get(id))).concat(entries.filter(entry => !this.documents.has(entry.id)));
  }
  readingStructure(spaceId) {
    if (!this.baselineStructure) return null;
    const structure = structuredClone(this.baselineStructure), nodes = new Map(structure.nodes.map(node => [node.id, node]));
    const authored = new Map(this.latest(spaceId, LEGACY_LIBRARY).filter(entry => entry.authoredSection === true && !this.documents.has(entry.id)).map(entry => [entry.id, entry]));
    for (const entry of authored.values()) {
      if (entry.status === 'archived') continue;
      if (nodes.has(entry.id) || structure.nodes.some(node => node.href === entry.url)) fail('SECTION_CONFLICT', 409);
      const node = { id: entry.id, kind: 'section', title: entry.title, href: entry.url, children: [] };
      nodes.set(node.id, node); structure.nodes.push(node);
    }
    const attached = new Set();
    for (const row of this.db.prepare('SELECT payload FROM collections WHERE space=? AND library=? ORDER BY id').all(spaceId, LEGACY_LIBRARY)) {
      const collection = JSON.parse(row.payload), chapter = nodes.get(collection.id);
      if (!chapter || chapter.kind !== 'chapter' || chapter.title !== collection.title) fail('INVALID_CHAPTER', 422);
      for (const id of collection.entryIds) {
        const entry = authored.get(id);
        if (!entry) fail('INVALID_SECTION', 422);
        if (attached.has(id)) fail('SECTION_ALREADY_ATTACHED', 422);
        attached.add(id);
        if (entry.status !== 'archived') chapter.children.push(id);
      }
    }
    return validateReadingStructure(structure);
  }
  readingContext(spaceId, url) {
    const structure = this.readingStructure(spaceId);
    return projectReadingContext(structure || { version: 1, nodes: [], home: [] }, url, { basePath: this.basePath });
  }
  list(space, resources = ['*']) {
    const items = this.db.prepare('SELECT payload FROM libraries WHERE space=? ORDER BY updated_at DESC,id').all(space).map(row => JSON.parse(row.payload)).filter(item => item.id !== LEGACY_LIBRARY && (resources.includes('*') || resources.includes(item.id))).map(item => ({ ...item, resourceId: item.id, entryCount: this.db.prepare('SELECT COUNT(DISTINCT id) AS count FROM entries WHERE space=? AND library=?').get(space, item.id).count }));
    if (this.legacyAvailable && (resources.includes('*') || resources.includes('legacy-library'))) items.push({ id: 'legacy-library', resourceId: 'legacy-library', name: '书库', description: '', readOnly: !this.documents.size, legacy: true, editableDocuments: this.documents.size > 0, entryCount: this.documents.size ? this.latest(space, LEGACY_LIBRARY).length : null, revision: this.documents.size ? this.library(space, LEGACY_LIBRARY).revision : null, updatedAt: this.documents.size ? this.library(space, LEGACY_LIBRARY).updatedAt : null, href: `${this.basePath}library/` });
    return items;
  }
  readLibrary(spaceId, resourceId) {
    const library = this.library(spaceId, resourceId);
    const collections = this.db.prepare('SELECT payload FROM collections WHERE space=? AND library=? ORDER BY id').all(spaceId, resourceId).map(row => JSON.parse(row.payload));
    const sourceIds = new Set(this.db.prepare('SELECT id FROM sources WHERE space=? AND library=? ORDER BY id').all(spaceId, resourceId).map(row => row.id));
    if (resourceId === LEGACY_LIBRARY) for (const id of this.documents.keys()) sourceIds.add(`source-${id}`);
    const sources = [...sourceIds].map(id => sourceMeta(this.source(spaceId, resourceId, id)));
    const statistics = this.db.prepare('SELECT payload FROM paper_statistics WHERE space=? AND library=?').get(spaceId, resourceId);
    return { spaceId, resourceId, revision: library.revision, library, documents: this.corpus.list(spaceId, resourceId), ...(statistics ? { paperStatistics: JSON.parse(statistics.payload) } : {}), collections, sources, entries: this.latest(spaceId, resourceId).map(entryMeta), ...(resourceId === LEGACY_LIBRARY ? { readingStructure: this.readingStructure(spaceId) } : {}) };
  }
  events(spaceId, after, resources) {
    const cursor = this.db.prepare('SELECT COALESCE(MAX(seq),0) AS cursor FROM knowledge_events WHERE space=?').get(spaceId).cursor;
    const resetRequired = after > cursor;
    const rows = resetRequired ? [] : this.db.prepare('SELECT seq AS cursor,resource AS resourceId,revision,operation,committed_at AS committedAt FROM knowledge_events WHERE space=? AND seq>? ORDER BY seq LIMIT 1000').all(spaceId, after);
    return { spaceId, cursor: !resetRequired && rows.length === 1000 ? rows.at(-1).cursor : cursor, minCursor: 1, resetRequired, events: rows.filter(row => resources.includes('*') || resources.includes(row.resourceId)).map(row => ({ ...row, id: row.cursor })) };
  }
  execute(requestValue, claims) {
    const request = validateRequest(requestValue), action = ACTIONS[request.operation], { spaceId, resourceId, input, operation } = request;
    if (claims.spaceId !== spaceId || claims.action !== action || resourceId && !allowed(claims, resourceId)) fail('FORBIDDEN', 403);
    if (claims.expiresAt <= this.now()) fail('INVALID_ASSERTION', 401);
    if (operation === 'capture_project' && (claims.sourceReadGranted !== true || input.sourceSpaceId !== spaceId)) fail('SOURCE_FORBIDDEN', 403);
    if (action === 'read') {
      let result;
      if (operation === 'list_libraries') result = { spaceId, items: this.list(spaceId, claims.resources) };
      else if (operation === 'events') result = this.events(spaceId, input.after, claims.resources);
      else {
        const library = this.library(spaceId, resourceId), base = { spaceId, resourceId, revision: library.revision };
        if (operation === 'read_library') result = this.readLibrary(spaceId, resourceId);
        else if (operation === 'read_document') result = { ...base, ...this.readDocument(spaceId, resourceId, input.documentId, input.offset, input.limit, input) };
        else if (operation === 'search_evidence') {
          const path = this.basePath + 'k/' + encodeURIComponent(spaceId) + '/' + encodeURIComponent(resourceId) + '/';
          const items = this.corpus.search(spaceId, resourceId, input).map(item => {
            const offset = Math.floor(item.ordinal / 25) * 25;
            return { ...item, href: path + '?document=' + item.documentId + '&offset=' + offset + '#passage-' + item.ordinal };
          });
          result = { ...base, items };
        }
        else if (operation === 'read_source') result = { ...base, source: this.source(spaceId, resourceId, input.sourceId) };
        else if (operation === 'read_entry') {
          const entry = this.entry(spaceId, resourceId, input.entryId, input.version);
          const history = this.db.prepare('SELECT payload FROM entries WHERE space=? AND library=? AND id=? ORDER BY version DESC').all(spaceId, resourceId, input.entryId).map(row => { const item = JSON.parse(row.payload); return { version: item.version, updatedAt: item.updatedAt, status: item.status }; });
          if (resourceId === LEGACY_LIBRARY && this.documents.has(input.entryId) && !history.some(item => item.version === 1)) history.push({ version: 1, updatedAt: null, status: 'published' });
          result = { ...base, entry, history, sources: [...new Set(entry.sourceRefs.map(ref => ref.sourceId))].map(id => sourceMeta(this.source(spaceId, resourceId, id))) };
        } else {
          const query = input.query.toLocaleLowerCase('en-US');
          let entries = this.latest(spaceId, resourceId);
          if (input.collectionId) {
            const row = this.db.prepare('SELECT payload FROM collections WHERE space=? AND library=? AND id=?').get(spaceId, resourceId, input.collectionId);
            if (!row) fail('COLLECTION_NOT_FOUND', 404);
            const ids = new Set(JSON.parse(row.payload).entryIds); entries = entries.filter(entry => ids.has(entry.id));
          }
          result = { ...base, items: entries.filter(entry => `${entry.title}\n${entry.body}\n${entry.tags.join('\n')}`.toLocaleLowerCase('en-US').includes(query)).slice(0, input.limit).map(entryMeta) };
        }
      }
      if (claims.expiresAt <= this.now()) fail('INVALID_ASSERTION', 401);
      return result;
    }
    if (resourceId === LEGACY_LIBRARY && !this.documents.size) fail('READ_ONLY_RESOURCE', 403);
    const identity = [spaceId, resourceId, claims.userId, claims.clientId, claims.grantId, request.idempotencyKey];
    const fingerprint = hash(canonical(request));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT fingerprint,response FROM knowledge_receipts WHERE space=? AND resource=? AND user_id=? AND client_id=? AND grant_id=? AND key=?').get(...identity);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 409);
        if (claims.expiresAt <= this.now()) fail('INVALID_ASSERTION', 401);
        this.db.exec('COMMIT'); return JSON.parse(receipt.response);
      }
      const nonce = this.db.prepare('SELECT fingerprint FROM knowledge_requests WHERE id=?').get(claims.requestId);
      if (nonce) fail(nonce.fingerprint === fingerprint ? 'REPLAY' : 'REQUEST_ID_CONFLICT', 409);
      const at = this.now(), timestamp = new Date(at).toISOString();
      let library, changed = true, extra = {};
      if (operation === 'create_library') {
        if (this.db.prepare('SELECT 1 FROM libraries WHERE space=? AND id=?').get(spaceId, resourceId)) fail('ALREADY_EXISTS', 409);
        if (this.db.prepare('SELECT COUNT(*) AS count FROM libraries WHERE space=?').get(spaceId).count >= 200) fail('LIBRARY_LIMIT', 422);
        library = { id: resourceId, ...input, revision: '1', updatedAt: timestamp };
      } else {
        library = this.library(spaceId, resourceId);
        if (library.revision !== request.expectedRevision) fail('CONFLICT', 409);
        if (operation === 'import_document') {
          const queued = this.corpus.enqueue(spaceId, resourceId, input);
          changed = queued.changed;
          extra = { document: queued.document };
        } else if (operation === 'import_paper_statistics') {
          const snapshot = input.snapshot;
          const row = this.db.prepare('SELECT source_hash,payload FROM paper_statistics WHERE space=? AND library=?').get(spaceId, resourceId);
          const previous = row ? JSON.parse(row.payload) : null;
          const digest = hash(canonical(snapshot));
          changed = digest !== row?.source_hash;
          if (changed && previous && Date.parse(snapshot.observedAt) <= Date.parse(previous.observedAt)) fail('STALE_SNAPSHOT', 409);
          if (changed) {
            const current = mergePaperStatistics(previous, snapshot);
            this.db.prepare('INSERT INTO paper_statistics VALUES(?,?,?,?) ON CONFLICT(space,library) DO UPDATE SET source_hash=excluded.source_hash,payload=excluded.payload').run(spaceId, resourceId, digest, JSON.stringify(current));
          }
          extra = { observedAt: snapshot.observedAt };
        } else if (operation === 'set_collection') {
          if (resourceId === LEGACY_LIBRARY) {
            if (!this.baselineStructure) fail('READ_ONLY_RESOURCE', 403);
            const chapter = this.baselineStructure.nodes.find(node => node.id === input.id && node.kind === 'chapter');
            if (!chapter || chapter.title !== input.title) fail('INVALID_CHAPTER', 422);
            for (const id of input.entryIds) {
              const entry = this.entry(spaceId, resourceId, id);
              if (this.documents.has(id) || entry.authoredSection !== true) fail('INVALID_SECTION', 422);
            }
            for (const row of this.db.prepare('SELECT payload FROM collections WHERE space=? AND library=? AND id<>?').all(spaceId, resourceId, input.id)) {
              if (JSON.parse(row.payload).entryIds.some(id => input.entryIds.includes(id))) fail('SECTION_ALREADY_ATTACHED', 422);
            }
          } else for (const id of input.entryIds) this.entry(spaceId, resourceId, id);
          const row = this.db.prepare('SELECT payload FROM collections WHERE space=? AND library=? AND id=?').get(spaceId, resourceId, input.id);
          if (!row && this.db.prepare('SELECT COUNT(*) AS count FROM collections WHERE space=? AND library=?').get(spaceId, resourceId).count >= 200) fail('COLLECTION_LIMIT', 422);
          changed = !row || canonical(JSON.parse(row.payload)) !== canonical(input);
          if (changed) this.db.prepare('INSERT INTO collections VALUES(?,?,?,?) ON CONFLICT(space,library,id) DO UPDATE SET payload=excluded.payload').run(spaceId, resourceId, input.id, JSON.stringify(input));
          extra = { collection: input };
        } else if (operation === 'add_source' || operation === 'capture_project') {
          if (resourceId === LEGACY_LIBRARY && !this.baselineStructure) fail('READ_ONLY_RESOURCE', 403);
          const id = operation === 'add_source' ? input.id : input.sourceId;
          if (resourceId === LEGACY_LIBRARY && [...this.documents.keys()].some(documentId => `source-${documentId}` === id) || this.db.prepare('SELECT 1 FROM sources WHERE space=? AND library=? AND id=?').get(spaceId, resourceId, id)) fail('IMMUTABLE_SOURCE', 409);
          if (this.db.prepare('SELECT COUNT(*) AS count FROM sources WHERE space=? AND library=?').get(spaceId, resourceId).count >= 200) fail('SOURCE_LIMIT', 422);
          const source = operation === 'add_source' ? { ...input, hash: hash(input.text), origin: null, createdAt: timestamp } : { id, title: input.snapshot.name, kind: 'project', text: canonical(input.snapshot), url: null, hash: hash(canonical(input.snapshot)), origin: { appId: 'projects', spaceId: input.sourceSpaceId, resourceId: input.projectId, revision: input.projectRevision }, createdAt: timestamp };
          this.db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run(spaceId, resourceId, id, JSON.stringify(source));
          extra = { source: sourceMeta(source) };
        } else {
          let entryInput = input;
          if (['insert_document_text', 'delete_document_text', 'replace_document_text'].includes(operation)) {
            const previous = this.entry(spaceId, resourceId, input.entryId);
            const matchText = operation === 'insert_document_text' ? input.anchorText : operation === 'delete_document_text' ? input.text : input.oldText;
            const replacement = operation === 'insert_document_text' ? input.position === 'before' ? input.text + matchText : matchText + input.text : operation === 'delete_document_text' ? '' : input.newText;
            const first = previous.body.indexOf(matchText);
            if (first < 0) fail('TEXT_NOT_FOUND', 409);
            if (previous.body.indexOf(matchText, first + 1) >= 0) fail('AMBIGUOUS_TEXT', 409);
            const { id, title, kind, body, tags, sourceRefs, status } = previous;
            entryInput = { id, title, kind, body: body.slice(0, first) + replacement + body.slice(first + matchText.length), tags, sourceRefs: sourceRefs.map(({ sourceId, locator }) => ({ sourceId, locator })), status };
            if (!entryInput.body.trim() || entryInput.body.length > 200000) fail('INVALID_INPUT');
          }
          const legacy = resourceId === LEGACY_LIBRARY;
          const seeded = legacy && this.documents.has(entryInput.id);
          const original = seeded ? this.entry(spaceId, resourceId, entryInput.id, 1) : null;
          if (seeded) {
            const fixed = ['id', 'title', 'kind', 'tags', 'status'];
            if (fixed.some(key => canonical(entryInput[key]) !== canonical(original[key])) || canonical(entryInput.sourceRefs) !== canonical(original.sourceRefs.map(({ sourceId, locator }) => ({ sourceId, locator })))) fail('DOCUMENT_METADATA_IMMUTABLE', 422);
          } else if (legacy) {
            if (!this.baselineStructure) fail('ENTRY_NOT_FOUND', 404);
            const url = `/sections/${entryInput.id}/`, sourcePath = `sections/${entryInput.id}.md`;
            if (this.baselineStructure.nodes.some(node => node.id === entryInput.id || node.href === url) || [...this.documents.values()].some(document => document.url === url || document.sourcePath === sourcePath)) fail('SECTION_CONFLICT', 409);
          }
          const sourceRefs = entryInput.sourceRefs.map(ref => ({ ...ref, hash: this.source(spaceId, resourceId, ref.sourceId).hash }));
          const row = this.db.prepare('SELECT payload FROM entries WHERE space=? AND library=? AND id=? ORDER BY version DESC LIMIT 1').get(spaceId, resourceId, entryInput.id);
          const previous = row ? JSON.parse(row.payload) : original;
          if (!previous && this.db.prepare('SELECT COUNT(DISTINCT id) AS count FROM entries WHERE space=? AND library=?').get(spaceId, resourceId).count >= 200) fail('ENTRY_LIMIT', 422);
          const nextContent = { ...entryInput, sourceRefs };
          changed = !previous || canonical(nextContent) !== canonical(Object.fromEntries(Object.keys(nextContent).map(key => [key, previous[key]])));
          if (changed && previous && previous.version >= 100) fail('VERSION_LIMIT', 422);
          const metadata = seeded ? { url: original.url, sourcePath: original.sourcePath } : legacy ? { url: previous?.url ?? `/sections/${entryInput.id}/`, sourcePath: previous?.sourcePath ?? `sections/${entryInput.id}.md`, authoredSection: true } : {};
          const entry = changed ? { ...nextContent, ...metadata, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp } : previous;
          if (changed && seeded && !row) {
            const source = this.source(spaceId, resourceId, original.sourceRefs[0].sourceId);
            this.db.prepare('INSERT INTO sources VALUES(?,?,?,?)').run(spaceId, resourceId, source.id, JSON.stringify(source));
            this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(spaceId, resourceId, original.id, original.version, JSON.stringify(original));
          }
          if (changed) this.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?)').run(spaceId, resourceId, entry.id, entry.version, JSON.stringify(entry));
          extra = { entry: entryMeta(entry) };
        }
        if (changed) { library.revision = String(Number(library.revision) + 1); library.updatedAt = timestamp; }
      }
      if (operation !== 'create_library' && Buffer.byteLength(JSON.stringify(this.readLibrary(spaceId, resourceId))) > 2097152) fail('LIBRARY_TOO_LARGE', 422);
      if (claims.expiresAt <= this.now()) fail('INVALID_ASSERTION', 401);
      const result = { spaceId, resourceId, revision: library.revision, library, ...extra };
      if (changed) {
        this.db.prepare('INSERT INTO libraries VALUES(?,?,?,?,?) ON CONFLICT(space,id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload,updated_at=excluded.updated_at').run(spaceId, resourceId, Number(library.revision), JSON.stringify(library), at);
        this.db.prepare('INSERT INTO knowledge_events(space,resource,revision,operation,committed_at) VALUES(?,?,?,?,?)').run(spaceId, resourceId, library.revision, operation, at);
      }
      this.db.prepare('INSERT INTO knowledge_receipts VALUES(?,?,?,?,?,?,?,?,?)').run(...identity, fingerprint, JSON.stringify(result), at);
      this.db.prepare('DELETE FROM knowledge_requests WHERE expires_at<?').run(at);
      this.db.prepare('INSERT INTO knowledge_requests VALUES(?,?,?)').run(claims.requestId, fingerprint, claims.expiresAt);
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
