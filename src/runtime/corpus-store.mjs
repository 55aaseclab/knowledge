import { createHash, randomUUID } from 'node:crypto';
import { constants, lstatSync, realpathSync } from 'node:fs';
import { open, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { fail } from './schema.mjs';

const parser = fileURLToPath(new URL('./document-parser.py', import.meta.url));
const leaseMs = 90_000;
const maxFileBytes = 1024 ** 3;
const maxEvidence = 500_000;

function kindOf(filename) {
  const extension = extname(filename).toLowerCase();
  if (extension === '.epub') return 'book';
  if (extension === '.zip') return 'package';
  return 'document';
}

// Match English words and overlapping Chinese bigrams without requiring a hosted tokenizer.
function indexTokens(value) {
  const words = value.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) || [];
  const terms = [];
  for (const word of words) {
    if (!/\p{Script=Han}/u.test(word) || word.length === 1) terms.push(word);
    else {
      const chars = [...word];
      for (let i = 1; i < chars.length; i++) terms.push(chars[i - 1] + chars[i]);
    }
  }
  return terms;
}

const metadata = 'id,title,filename,kind,status,bytes,passages,members,problems,duplicates,error';
export class CorpusStore {
  constructor(db, file, inbox) {
    this.db = db;
    this.directory = dirname(file);
    this.inbox = inbox;
    this.closed = false;
    this.busy = false;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS corpus_documents(
        space TEXT NOT NULL,library TEXT NOT NULL,id TEXT NOT NULL,title TEXT NOT NULL,filename TEXT NOT NULL,
        kind TEXT NOT NULL,status TEXT NOT NULL,bytes INTEGER NOT NULL,original_ready INTEGER NOT NULL DEFAULT 0,
        passages INTEGER NOT NULL DEFAULT 0,members INTEGER NOT NULL DEFAULT 0,problems INTEGER NOT NULL DEFAULT 0,
        duplicates INTEGER NOT NULL DEFAULT 0,error TEXT,worker TEXT,lease INTEGER,
        PRIMARY KEY(space,library,id));
      CREATE TABLE IF NOT EXISTS corpus_originals(
        space TEXT NOT NULL,library TEXT NOT NULL,document TEXT NOT NULL,n INTEGER NOT NULL,data BLOB NOT NULL,
        PRIMARY KEY(space,library,document,n));
      CREATE TABLE IF NOT EXISTS corpus_members(
        space TEXT NOT NULL,library TEXT NOT NULL,document TEXT NOT NULL,path TEXT NOT NULL,
        sha256 TEXT,format TEXT,status TEXT NOT NULL,reason TEXT,duplicate_of TEXT,
        PRIMARY KEY(space,library,document,path));
      CREATE TABLE IF NOT EXISTS corpus_passages(
        id INTEGER PRIMARY KEY,space TEXT NOT NULL,library TEXT NOT NULL,document TEXT NOT NULL,
        ordinal INTEGER NOT NULL,source TEXT NOT NULL,locator TEXT NOT NULL,text TEXT NOT NULL,
        UNIQUE(space,library,document,ordinal));
      CREATE INDEX IF NOT EXISTS corpus_passage_sources ON corpus_passages(space,library,document,source,ordinal);
      CREATE VIRTUAL TABLE IF NOT EXISTS corpus_fts USING fts5(location,body);
      CREATE TRIGGER IF NOT EXISTS corpus_delete_passage AFTER DELETE ON corpus_passages
      BEGIN DELETE FROM corpus_fts WHERE rowid=old.id; END;`);
    this.timer = setInterval(() => this.pump(), 10_000);
    this.timer.unref();
    this.wake();
  }
  wake() {
    setImmediate(() => this.pump()).unref();
  }
  close() {
    this.closed = true;
    clearInterval(this.timer);
    this.child?.kill('SIGKILL');
    if (this.scope) this.db.prepare("UPDATE corpus_documents SET status='queued',worker=NULL,lease=NULL WHERE space=? AND library=? AND id=? AND worker=?").run(...this.scope, this.owner);
  }
  list(space, library) {
    return this.db.prepare(`SELECT ${metadata} FROM corpus_documents WHERE space=? AND library=? ORDER BY title,id`).all(space, library);
  }
  document(scope) {
    const doc = this.db.prepare(`SELECT ${metadata} FROM corpus_documents WHERE space=? AND library=? AND id=?`).get(...scope);
    if (!doc) fail('DOCUMENT_NOT_FOUND', 404);
    return { ...doc };
  }
  attachment(scope) {
    if (!this.inbox || !isAbsolute(this.inbox)) fail('ATTACHMENT_INBOX_UNAVAILABLE', 503);
    const file = resolve(this.inbox, ...scope);
    try {
      if (realpathSync(file) !== file || !lstatSync(file).isFile()) fail('ATTACHMENT_NOT_FOUND', 404);
      const bytes = lstatSync(file).size;
      if (bytes < 1 || bytes > maxFileBytes) fail('ATTACHMENT_SIZE', 422);
      return { file, bytes };
    } catch (error) {
      if (error.status) throw error;
      fail('ATTACHMENT_NOT_FOUND', 404);
    }
  }
  enqueue(space, library, { attachmentId, filename, title }) {
    const scope = [space, library, attachmentId];
    const existing = this.db.prepare('SELECT * FROM corpus_documents WHERE space=? AND library=? AND id=?').get(...scope);
    if (existing && (existing.filename !== filename || existing.title !== title)) fail('DOCUMENT_METADATA_CONFLICT', 409);
    if (existing && existing.status !== 'failed') return { changed: false, document: this.document(scope) };
    if (!existing) {
      const { bytes } = this.attachment(scope);
      this.db.prepare("INSERT INTO corpus_documents(space,library,id,title,filename,kind,status,bytes) VALUES(?,?,?,?,?,?,'queued',?)")
        .run(...scope, title, filename, kindOf(filename), bytes);
    } else {
      if (!existing.original_ready) this.attachment(scope);
      this.db.prepare("UPDATE corpus_documents SET status='queued',error=NULL WHERE space=? AND library=? AND id=?").run(...scope);
    }
    this.wake();
    return { changed: true, document: this.document(scope) };
  }
  outline(space, library, document, offset, limit) {
    const empty = { outline: [], outlineTotal: 0, nextOutlineOffset: null };
    if (!['ready', 'partial'].includes(document.status) || !['book', 'package'].includes(document.kind)) return empty;
    const scope = 'space=:space AND library=:library AND document=:id';
    // Both queries work with evidence created before outlines were available.
    // An alias in a ZIP opens the first indexed passage of its original file.
    const sections = document.kind === 'book' ? `
      SELECT min(ordinal) AS ordinal, locator AS label FROM corpus_passages
      WHERE ${scope} AND locator GLOB '章节 [0-9]*'
      GROUP BY CAST(substr(locator, 4) AS INTEGER)` : `
      WITH firsts AS (
        SELECT source AS label,min(ordinal) AS ordinal FROM corpus_passages WHERE ${scope} GROUP BY source
      )
      SELECT ordinal,label FROM firsts
      UNION ALL SELECT f.ordinal,m.path AS label FROM corpus_members m JOIN firsts f ON m.duplicate_of=f.label
        WHERE m.space=:space AND m.library=:library AND m.document=:id AND m.status='duplicate'`;
    const rows = this.db.prepare(`
      WITH sections AS (${sections}),
      page AS (SELECT label,ordinal FROM sections ORDER BY ordinal,label LIMIT :limit OFFSET :offset)
      SELECT total,label,ordinal FROM (SELECT count(*) AS total FROM sections) LEFT JOIN page ON 1
      ORDER BY ordinal,label`).all({ space, library, id: document.id, limit, offset });
    const outline = rows.filter(row => row.ordinal !== null).map(({ label, ordinal }) => {
      if (document.kind === 'book') {
        const title = /^章节 [0-9]+ (.*?) \(.*\) · 段 [0-9]+–[0-9]+(?: · 字符 [0-9]+–[0-9]+)?$/su.exec(label);
        label = title?.[1] || label;
      }
      return { label, ordinal };
    });
    const outlineTotal = rows[0].total;
    const end = offset + outline.length;
    return { outline, outlineTotal, nextOutlineOffset: end < outlineTotal ? end : null };
  }
  read(space, library, id, offset, limit, options = {}) {
    const scope = [space, library, id], document = this.document(scope);
    const available = ['ready', 'partial'].includes(document.status);
    const items = available ? this.db.prepare('SELECT ordinal,source,locator,text FROM corpus_passages WHERE space=? AND library=? AND document=? AND ordinal>=? ORDER BY ordinal LIMIT ?').all(...scope, offset, limit) : [];
    const issues = this.db.prepare("SELECT path,status,reason FROM corpus_members WHERE space=? AND library=? AND document=? AND status IN ('failed','partial','unsupported') ORDER BY path LIMIT 50").all(...scope);
    const outline = options.includeOutline ? this.outline(space, library, document, options.outlineOffset ?? 0, options.outlineLimit ?? 100) : {};
    return { document, items, issues, total: available ? document.passages : 0, ...outline };
  }
  search(space, library, { query, documentId, limit }) {
    const terms = [...new Set(indexTokens(query))].slice(0, 64);
    if (!terms.length) return [];
    const match = terms.map(term => '"' + term + '"').join(' OR ');
    const filter = documentId ? 'AND p.document=?' : '';
    return this.db.prepare(`SELECT p.document AS documentId,d.title,p.ordinal,p.source,p.locator,p.text
      FROM corpus_fts JOIN corpus_passages p ON p.id=corpus_fts.rowid
      JOIN corpus_documents d ON d.space=p.space AND d.library=p.library AND d.id=p.document
      WHERE corpus_fts MATCH ? AND p.space=? AND p.library=? ${filter} AND d.status IN ('ready','partial')
      ORDER BY bm25(corpus_fts,2.5,1),p.document,p.ordinal LIMIT ?`).all(match, space, library, ...(documentId ? [documentId] : []), limit);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async pump() {
    if (this.busy || this.closed) return;
    this.busy = true;
    let job, scratch;
    try {
      const worker = randomUUID();
      job = this.db.prepare(`UPDATE corpus_documents SET status='processing',worker=?,lease=?,error=NULL,passages=0,members=0,problems=0,duplicates=0
        WHERE rowid=(SELECT rowid FROM corpus_documents WHERE status='queued' OR (status='processing' AND lease<?) ORDER BY rowid LIMIT 1)
        RETURNING *`).get(worker, Date.now() + leaseMs, Date.now());
      if (!job) return;
      this.scope = [job.space, job.library, job.id];
      this.owner = worker;
      this.transaction(() => {
        this.heartbeat();
        this.db.prepare('DELETE FROM corpus_passages WHERE space=? AND library=? AND document=?').run(...this.scope);
        this.db.prepare('DELETE FROM corpus_members WHERE space=? AND library=? AND document=?').run(...this.scope);
        if (!job.original_ready) this.db.prepare('DELETE FROM corpus_originals WHERE space=? AND library=? AND document=?').run(...this.scope);
      });
      // Each lease owns a separate scratch directory. Reclaim copies left by a crashed worker.
      const prefix = '.knowledge-parser-' + createHash('sha256').update(JSON.stringify(this.scope)).digest('hex') + '-';
      for (const name of await readdir(this.directory)) {
        if (name.startsWith(prefix) && /^[0-9a-f-]{36}$/.test(name.slice(prefix.length))) {
          this.heartbeat();
          await rm(join(this.directory, name), { recursive: true, force: true });
        }
      }
      this.heartbeat();
      scratch = join(this.directory, prefix + worker);
      await mkdir(scratch, { mode: 0o700 });
      const raw = join(scratch, 'original');
      await this.materialize(job, raw);
      this.heartbeat();
      await this.parse(job, raw);
    } catch (error) {
      if (job && !this.closed) this.transaction(() => {
        const row = this.db.prepare("UPDATE corpus_documents SET status='failed',error=?,worker=NULL,lease=NULL WHERE space=? AND library=? AND id=? AND worker=? RETURNING original_ready")
          .get(error.status ? error.code : 'PARSER_FAILED', ...this.scope, this.owner);
        if (row && !row.original_ready) this.db.prepare('DELETE FROM corpus_originals WHERE space=? AND library=? AND document=?').run(...this.scope);
      });
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
      this.busy = false;
      if (job && !this.closed) this.wake();
    }
  }
  heartbeat() {
    if (this.closed) throw new Error('Worker closed.');
    const row = this.db.prepare('UPDATE corpus_documents SET lease=? WHERE space=? AND library=? AND id=? AND worker=?').run(Date.now() + leaseMs, ...this.scope, this.owner);
    if (!row.changes) throw new Error('Worker superseded.');
  }
  async materialize(job, path) {
    const fd = await open(path, 'wx', 0o600);
    let source;
    try {
      if (!job.original_ready) {
        source = await open(this.attachment(this.scope).file, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (!(await source.stat()).isFile()) fail('ATTACHMENT_NOT_FOUND', 404);
      }
      const hash = createHash('sha256');
      let size = 0, n = 0;
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const original = this.db.prepare('SELECT data FROM corpus_originals WHERE space=? AND library=? AND document=? AND n=?');
      const insert = this.db.prepare('INSERT INTO corpus_originals VALUES(?,?,?,?,?)');
      while (size < job.bytes) {
        let chunk;
        if (source) {
          const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, job.bytes-size));
          chunk = buffer.subarray(0, bytesRead);
        } else {
          this.heartbeat();
          chunk = original.get(...this.scope, n)?.data;
        }
        if (!chunk?.length || size + chunk.length > job.bytes) fail('ATTACHMENT_CHANGED', 409);
        await fd.writeFile(chunk);
        this.transaction(() => {
          this.heartbeat();
          if (source) insert.run(...this.scope, n, chunk);
        });
        size += chunk.length; n++;
        hash.update(chunk);
      }
      if ((source && (await source.stat()).size !== size) || hash.digest('hex') !== job.id) fail('ATTACHMENT_CHANGED', 409);
      this.transaction(() => {
        this.heartbeat();
        this.db.prepare('UPDATE corpus_documents SET original_ready=1 WHERE space=? AND library=? AND id=?').run(...this.scope);
      });
    } finally {
      await fd.close();
      await source?.close();
    }
  }
  async parse(job, raw) {
    const child = spawn('python3', [parser, raw, '--name', job.filename], { stdio: ['ignore','pipe','ignore'] });
    this.child = child;
    const exited = new Promise(resolve => {
      child.on('error', () => resolve(-1));
      child.on('close', code => resolve(code ?? -1));
    });
    const heart = setInterval(() => {
      try { this.heartbeat(); } catch { child.kill('SIGKILL'); }
    }, leaseMs / 3);
    const insertMember = this.db.prepare('INSERT INTO corpus_members VALUES(?,?,?,?,?,?,?,?,?)');
    const insert = this.db.prepare('INSERT INTO corpus_passages(space,library,document,ordinal,source,locator,text) VALUES(?,?,?,?,?,?,?)');
    const index = this.db.prepare('INSERT INTO corpus_fts(rowid,location,body) VALUES(?,?,?)');
    let pending = [], passages = 0, members = 0, problems = 0, duplicates = 0, done = false;
    const flush = () => this.transaction(() => {
      this.heartbeat();
      for (const event of pending) {
        if (event.type === 'passage') {
          if (++passages > maxEvidence) fail('EVIDENCE_LIMIT', 422);
          // Limit verbose chapter headings while keeping the paragraph or cell suffix.
          // With bounded source names and 1,400-character passages, even 50 reader rows
          // plus 50 issues fit the 4 MiB business response envelope.
          const locator = event.locator.length > 1500
            ? event.locator.slice(0, 999) + '…' + event.locator.slice(-500) : event.locator;
          const id = insert.run(...this.scope, passages - 1, event.path, locator, event.text).lastInsertRowid;
          index.run(id, indexTokens(job.title + ' ' + event.path + ' ' + locator).join(' '), indexTokens(event.text).join(' '));
        } else if (event.type === 'document') {
          insertMember.run(...this.scope, event.path, event.sha256 ?? null, event.format ?? null, event.status, event.reason?.slice(0, 512) ?? null, event.duplicateOf ?? null);
          members++;
          if (event.status === 'duplicate') duplicates++;
          if (['partial','failed','unsupported'].includes(event.status)) problems++;
        } else if (event.type === 'done') done = true;
        else throw new Error('Invalid parser protocol.');
      }
      pending = [];
      this.db.prepare('UPDATE corpus_documents SET passages=?,members=?,problems=?,duplicates=? WHERE space=? AND library=? AND id=?').run(passages,members,problems,duplicates,...this.scope);
    });
    try {
      for await (const line of createInterface({input: child.stdout, crlfDelay: Infinity})) {
        if (this.closed) throw new Error('Worker closed.');
        if (line.length > 200_000) throw new Error('Invalid parser event.');
        pending.push(JSON.parse(line));
        if (pending.length >= 100) { flush(); await yieldIO(); }
      }
      if (pending.length) flush();
      if (await exited !== 0 || !done) fail('PARSER_FAILED', 422);
      this.transaction(() => {
        this.heartbeat();
        this.db.prepare('UPDATE corpus_documents SET status=?,error=?,worker=NULL,lease=NULL WHERE space=? AND library=? AND id=?')
          .run(!passages ? 'failed' : problems ? 'partial' : 'ready', passages ? null : 'NO_READABLE_EVIDENCE', ...this.scope);
      });
    } finally {
      clearInterval(heart);
      if (child.exitCode === null) child.kill('SIGKILL');
      this.child = null;
    }
  }
}
