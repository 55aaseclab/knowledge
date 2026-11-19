import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fail, fields, identifier, object, slug } from './schema.mjs';
export function verifyAssertion(raw, assertion, key, now = Date.now()) {
  const invalid = () => fail('INVALID_ASSERTION', 401);
  if (typeof assertion !== 'string' || assertion.length > 32768) invalid();
  const parts = assertion.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) invalid();
  const actual = Buffer.from(parts[1], 'base64url'), expected = createHmac('sha256', key).update(parts[0]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalid();
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { invalid(); }
  const keys = ['v', 'appId', 'userId', 'clientId', 'grantId', 'spaceId', 'action', 'resources', 'expiresAt', 'requestId', 'method', 'path', 'bodyHash'];
  if (!object(claims) || keys.some(name => !Object.hasOwn(claims, name)) || Object.keys(claims).some(name => !keys.includes(name) && name !== 'sourceReadGranted')) invalid();
  if (claims.sourceReadGranted !== undefined && typeof claims.sourceReadGranted !== 'boolean') invalid();
  if (claims.v !== 1 || claims.appId !== 'knowledge' || claims.method !== 'POST' || claims.path !== '/api/business' || claims.bodyHash !== createHash('sha256').update(raw).digest('hex') || !['read', 'create', 'update'].includes(claims.action)) invalid();
  if (!['userId', 'clientId', 'grantId', 'spaceId', 'requestId'].every(name => identifier(claims[name])) || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.expiresAt > now + 30000) invalid();
  if (!Array.isArray(claims.resources) || !claims.resources.length || claims.resources.length > 1000 || new Set(claims.resources).size !== claims.resources.length || claims.resources.some(id => id !== '*' && !slug(id)) || claims.resources.includes('*') && claims.resources.length !== 1) invalid();
  return claims;
}
export class BusinessService {
  constructor({ store, key, spaces, now = Date.now }) {
    if (!store || !Buffer.isBuffer(key) || key.length < 32 || key.length > 4096 || !Array.isArray(spaces) || !spaces.length || spaces.some(value => !identifier(value)) || new Set(spaces).size !== spaces.length) throw new Error('Knowledge business configuration is invalid.');
    this.store = store; this.key = Buffer.from(key); this.spaces = new Set(spaces); this.now = now;
  }
  handle(raw, assertion) {
    const claims = verifyAssertion(raw, assertion, this.key, this.now());
    let request;
    try { request = JSON.parse(raw.toString('utf8')); } catch { fail('INVALID_REQUEST'); }
    if (!this.spaces.has(claims.spaceId)) fail('FORBIDDEN', 403);
    return this.store.execute(request, claims);
  }
}
export function loadBusinessService(store, env = process.env) {
  if (env.KNOWLEDGE_MANAGED !== undefined && !['0', '1'].includes(env.KNOWLEDGE_MANAGED)) throw new Error('KNOWLEDGE_MANAGED must be 0 or 1.');
  if (env.KNOWLEDGE_MANAGED !== '1') return null;
  for (const name of ['KNOWLEDGE_ADAPTER_KEY_FILE', 'KNOWLEDGE_BUSINESS_CONFIG']) {
    if (!isAbsolute(env[name] || '')) throw new Error('Managed Knowledge requires absolute key and configuration paths.');
    const info = lstatSync(env[name]);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 65536) throw new Error('Business secrets must be private regular files.');
  }
  let config;
  try { config = JSON.parse(readFileSync(env.KNOWLEDGE_BUSINESS_CONFIG, 'utf8')); } catch { throw new Error('The business configuration must contain valid JSON.'); }
  fields(config, ['version', 'spaces']);
  if (config.version !== 1) throw new Error('The business configuration version is unsupported.');
  return new BusinessService({ store, key: readFileSync(env.KNOWLEDGE_ADAPTER_KEY_FILE), spaces: config.spaces });
}
