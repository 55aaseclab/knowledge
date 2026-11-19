import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const layout = [['build/documents.json', 'catalog/documents.json'], ['dist', 'published-standalone'], ['dist-public', 'published']];
function within(root, target) { const path = relative(root, target); return path === '' || path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path); }
async function manifest(root, name = '') {
  const path = join(root, name), info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error('Content exports accept regular files and directories only.');
  if (info.isFile()) return [[name, createHash('sha256').update(await readFile(path)).digest('hex')]];
  const result = [];
  for (const entry of (await readdir(path)).sort()) result.push(...await manifest(root, join(name, entry)));
  return result;
}
export async function exportContent(destination, { root = sourceRoot } = {}) {
  if (typeof destination !== 'string' || !isAbsolute(destination) || /[\x00-\x1f\x7f]/.test(destination)) throw new Error('The destination must be an absolute path.');
  const target = resolve(destination), source = resolve(root);
  if (within(source, target) || within(target, source)) throw new Error('The destination must be separate from the source repository.');
  try { await lstat(target); throw new Error('The destination already exists; no content was overwritten.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const expected = [];
  for (const [input, output] of layout) for (const [name, hash] of await manifest(source, input)) expected.push([join(output, relative(input, name)), hash]);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const stage = join(dirname(target), '.' + randomUUID() + '.content-export');
  await mkdir(stage, { mode: 0o700 });
  try {
    for (const [input, output] of layout) await cp(join(source, input), join(stage, output), { recursive: true, errorOnExist: true, force: false });
    const actual = await manifest(stage), sort = values => values.sort(([a], [b]) => a.localeCompare(b));
    if (JSON.stringify(sort(actual)) !== JSON.stringify(sort(expected))) throw new Error('Exported content did not match the source bytes.');
    // Refuse replacing a target that appeared while the export was prepared.
    try { await lstat(target); throw new Error('The destination appeared during export.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(stage, target);
    return { version: 1, files: actual.length, sha256: createHash('sha256').update(JSON.stringify(actual)).digest('hex') };
  } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--destination') { process.stderr.write('Usage: npm run export:content -- --destination ABSOLUTE_PATH\n'); process.exitCode = 1; }
  else exportContent(process.argv[3]).then(result => process.stdout.write(JSON.stringify(result) + '\n')).catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
}
