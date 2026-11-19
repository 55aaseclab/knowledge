import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { parse, parseFragment, serialize } from 'parse5';
import GithubSlugger from 'github-slugger';
import { isNavigationHeading } from './document-outline.mjs';

const blocked = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'foreignobject', 'animate', 'animatetransform', 'set', 'use']);
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const hasClass = (node, value) => (attr(node, 'class') || '').split(/\s+/).includes(value);
const textContent = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textContent).join('');
function find(node, match) { if (match(node)) return node; for (const child of node.childNodes || []) { const result = find(child, match); if (result) return result; } }
function walk(node, callback) { callback(node); for (const child of node.childNodes || []) walk(child, callback); }
function safeUrl(value) {
  if (typeof value !== 'string' || /[\\\u0000-\u0020\u007f]/.test(value) || value.startsWith('//')) return false;
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) return true;
  try { const url = new URL(value); return ['http:', 'https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function sanitizeAuthoredHtml(value) {
  const fragment = parseFragment(value, { sourceCodeLocationInfo: true }), patches = [];
  const visit = node => {
    const location = node.sourceCodeLocation;
    if (blocked.has(node.tagName?.toLowerCase())) {
      if (location) patches.push({ start: location.startOffset, end: location.endOffset, value: '' });
      return;
    }
    for (const item of node.attrs || []) {
      const unsafe = /^on/i.test(item.name) || ['style', 'srcdoc', 'formaction', 'action', 'xmlns:xlink', 'srcset', 'ping'].includes(item.name) || /^(?:href|src|poster|xlink:href)$/.test(item.name) && !safeUrl(item.value);
      const position = location?.attrs?.[item.prefix ? `${item.prefix}:${item.name}` : item.name];
      if (unsafe && position) patches.push({ start: position.startOffset, end: position.endOffset, value: '' });
    }
    for (const child of node.childNodes || []) visit(child);
  };
  visit(fragment);
  for (const patch of patches.sort((a, b) => b.start - a.start)) value = value.slice(0, patch.start) + patch.value + value.slice(patch.end);
  return value;
}
function remarkDocument({ targets, document, base }) {
  const known = new Map(targets || []), origin = 'https://knowledge.invalid';
  function owned(value) {
    if (!safeUrl(value)) return '';
    if (!value || /^(?:#|\?|[a-z][a-z\d+.-]*:)/i.test(value)) return value;
    let url; try { url = new URL(value, origin + '/' + document.sourcePath.replace(/^\//, '')); } catch { return ''; }
    let path; try { path = decodeURIComponent(url.pathname); } catch { return ''; }
    if (base && (path === base || path.startsWith(base + '/'))) path = path.slice(base.length) || '/';
    let destination = known.get(path) || known.get(path + '/');
    if (!destination && !value.startsWith('/')) {
      const fallback = new URL(value, origin + document.url);
      let candidate; try { candidate = decodeURIComponent(fallback.pathname); } catch { return ''; }
      destination = known.get(candidate) || known.get(candidate + '/');
      if (destination) url = fallback;
    }
    return destination ? base + destination + url.search + url.hash : value.startsWith('/') ? base + path + url.search + url.hash : value;
  }
  return tree => {
    const visit = node => {
      if (['link', 'image', 'definition'].includes(node.type)) node.url = owned(node.url);
      if (node.type === 'html') {
        node.value = sanitizeAuthoredHtml(node.value);
        const fragment = parseFragment(node.value, { sourceCodeLocationInfo: true }), patches = [];
        walk(fragment, element => { for (const item of element.attrs || []) {
          if (!['href', 'src', 'poster'].includes(item.name)) continue;
          const position = element.sourceCodeLocation?.attrs?.[item.name], destination = owned(item.value);
          if (position && destination !== item.value) patches.push({ start: position.startOffset, end: position.endOffset, value: `${item.name}="${escape(destination)}"` });
        } });
        for (const patch of patches.sort((a, b) => b.start - a.start)) node.value = node.value.slice(0, patch.start) + patch.value + node.value.slice(patch.end);
      }
      if (node.type === 'code' && node.lang?.toLowerCase() === 'mermaid') { node.type = 'html'; node.value = `<pre class="mermaid">${escape(node.value || '')}</pre>`; delete node.lang; }
      for (const child of node.children || []) visit(child);
    };
    visit(tree);
  };
}
function rehypeSafeUrls() {
  return tree => { const visit = node => {
    if (node.properties) for (const key of ['href', 'src', 'poster', 'xLinkHref']) if (node.properties[key] && !safeUrl(node.properties[key])) delete node.properties[key];
    for (const child of node.children || []) visit(child);
  }; visit(tree); };
}
export async function renderDocumentMarkdown(document, { targets = [], basePath = '/' } = {}) {
  const base = basePath.replace(/\/$/, '');
  if (/\.html?$/i.test(document.sourcePath)) {
    const tree = { type: 'root', children: [{ type: 'html', value: document.body }] };
    remarkDocument({ targets, document, base })(tree);
    const fragment = parseFragment(tree.children[0].value), slugger = new GithubSlugger(), identifiers = new Set(), headings = [];
    walk(fragment, node => { const id = attr(node, 'id'); if (id) { identifiers.add(id); slugger.slug(id); } });
    walk(fragment, node => {
      if (!/^h[1-6]$/.test(node.tagName || '')) return;
      const text = textContent(node).replace(/\s+/g, ' ').trim();
      let slug = attr(node, 'id');
      if (!slug) {
        do { slug = slugger.slug(text || 'section'); } while (identifiers.has(slug));
        identifiers.add(slug); node.attrs.push({ name: 'id', value: slug });
      }
      headings.push({ depth: Number(node.tagName.slice(1)), slug, text });
    });
    return { html: serialize(fragment), headings };
  }
  const processor = await createMarkdownProcessor({ remarkPlugins: [remarkMath, [remarkDocument, { targets, document, base }]], rehypePlugins: [rehypeKatex, rehypeSafeUrls] });
  const rendered = await processor.render(document.body, { fileURL: new URL('file:///knowledge/' + document.sourcePath.replace(/^\//, '')) });
  return { html: rendered.code, headings: rendered.metadata.headings };
}
function outlineItems(headings, existing) {
  const min = Number(attr(existing, 'data-min-h')) || 2, max = Number(attr(existing, 'data-max-h')) || 3;
  return headings.filter(item => item.slug !== '_top' && !isNavigationHeading(item.text) && item.depth >= min && item.depth <= max);
}
function outlineHtml(list, existing) {
  const min = Number(attr(existing, 'data-min-h')) || 2;
  const root = find(existing, node => node.tagName === 'ul'), anchor = find(existing, node => node.tagName === 'a'), span = find(existing, node => node.tagName === 'span');
  const cls = node => attr(node || {}, 'class') ? ` class="${escape(attr(node, 'class'))}"` : '';
  return `<nav aria-label="On this page" data-book-zh-label="本页目录"><ul${cls(root)} style="--depth:0">${list.map(item => `<li><a${cls(anchor)} href="#${escape(item.slug)}" style="display:block;padding-inline-start:${.5 + Math.max(0, item.depth - min)}rem"><span${cls(span)}>${escape(item.text)}</span></a></li>`).join('')}</ul></nav>`;
}
function replaceChildren(node, html) {
  node.childNodes = parseFragment(html).childNodes;
  for (const child of node.childNodes) child.parentNode = node;
}
function replaceNode(node, html) {
  const parent = node.parentNode, at = parent?.childNodes.indexOf(node);
  if (!parent || at < 0) return;
  const nodes = parseFragment(html).childNodes;
  for (const child of nodes) child.parentNode = parent;
  parent.childNodes.splice(at, 1, ...nodes);
}
function setAttr(node, name, value) {
  const existing = node.attrs.find(item => item.name === name);
  if (existing) existing.value = String(value);
  else node.attrs.push({ name, value: String(value) });
}
function projectReadingNavigation(tree, context, headings, existingOutline, basePath) {
  if (!context?.section || !context.container) return;
  const base = basePath.replace(/\/$/, ''), href = value => escape(base + value);
  const items = outlineItems(headings, existingOutline || {});
  const pageOutline = items.length ? `<starlight-toc data-min-h="${escape(attr(existingOutline || {}, 'data-min-h') || '2')}" data-max-h="${escape(attr(existingOutline || {}, 'data-max-h') || '3')}">${outlineHtml(items, existingOutline || {})}</starlight-toc>` : '<p class="book-outline-empty" data-book-zh="本节暂无标题">No headings in this section</p>';
  const arrow = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>';
  const current = node => node.kind === 'section' ? node.id === context.section.id : (node.children || []).some(current);
  const list = nodes => `<ul class="book-structure-list">${nodes.map(node => `<li>${node.kind === 'section' ? current(node) ? `<details class="book-section-headings"${items.length ? ' open' : ''}><summary><a class="book-section-link" href="${href(node.href)}" aria-current="page">${escape(node.title)}</a>${arrow}</summary><div class="book-page-outline" data-page-outline>${pageOutline}</div></details>` : `<a class="book-section-link" href="${href(node.href)}">${escape(node.title)}</a>` : `<details class="book-structure-group"${current(node) ? ' open' : ''}><summary><a class="book-container-link" href="${href(node.href)}">${escape(node.title)}</a>${arrow}</summary>${list(node.children || [])}</details>`}</li>`).join('')}</ul>`;
  const container = context.container;
  const navigation = find(tree, node => node.attrs?.some(item => item.name === 'data-reading-structure'));
  if (container.kind !== 'section') {
    const html = `<nav class="book-structure-navigation" data-reading-structure data-reading-container="${escape(container.id)}" aria-label="Contents of ${escape(container.title)}" data-book-zh-label="${escape(container.title)}目录"><div class="book-structure-title">${escape(container.title)}</div>${list(container.children || [])}</nav>`;
    if (navigation) replaceNode(navigation, html);
    else {
      const outline = find(tree, node => node.attrs?.some(item => item.name === 'data-page-outline'));
      if (outline) replaceNode(outline, html);
    }
  }
  const previous = context.prev || context.previous, next = context.next;
  const paginationHtml = previous || next ? `<nav class="book-pagination" aria-label="Section navigation" data-book-zh-label="节次导航">${previous ? `<a href="${href(previous.href)}" rel="prev"><span data-book-zh="上一节">Previous section</span>${escape(previous.title)}</a>` : ''}${next ? `<a href="${href(next.href)}" rel="next"><span data-book-zh="下一节">Next section</span>${escape(next.title)}</a>` : ''}</nav>` : '';
  const pagination = find(tree, node => hasClass(node, 'book-pagination'));
  if (pagination) replaceNode(pagination, paginationHtml);
  else if (paginationHtml) {
    const content = find(tree, node => hasClass(node, 'sl-markdown-content'));
    const parent = content?.parentNode;
    if (parent) {
      const nodes = parseFragment(paginationHtml).childNodes;
      for (const node of nodes) node.parentNode = parent;
      parent.childNodes.splice(parent.childNodes.indexOf(content) + 1, 0, ...nodes);
    }
  }
}
function projectAuthoredMetadata(tree, document, version, basePath) {
  const title = find(tree, node => node.tagName === 'title');
  if (title) replaceChildren(title, `${escape(document.title)} | Knowledge`);
  const readerTitle = find(tree, node => hasClass(node, 'book-reader-title'));
  const heading = find(readerTitle || tree, node => node.tagName === 'h1');
  if (heading) replaceChildren(heading, escape(document.title));
  const meta = readerTitle && find(readerTitle, node => hasClass(node, 'article-meta'));
  if (meta) replaceChildren(meta, `<span class="document-version" data-document-version="${version}">Version ${version}</span>${(document.tags || []).map(tag => `<span class="article-tag">${escape(tag)}</span>`).join('')}`);
  const destination = basePath.replace(/\/$/, '') + document.url;
  walk(tree, node => {
    if (node.tagName === 'meta') {
      const key = attr(node, 'property') || attr(node, 'name');
      if (['og:title', 'twitter:title'].includes(key)) setAttr(node, 'content', document.title);
      if (['description', 'og:description', 'twitter:description', 'article:tag', 'article:published_time', 'article:modified_time'].includes(key)) setAttr(node, 'content', '');
    }
    const urlAttr = node.tagName === 'link' && attr(node, 'rel') === 'canonical' ? 'href' : node.tagName === 'meta' && ['og:url', 'twitter:url'].includes(attr(node, 'property') || attr(node, 'name')) ? 'content' : null;
    if (urlAttr) {
      let value = destination;
      try { value = new URL(destination, attr(node, urlAttr)).href; } catch {}
      setAttr(node, urlAttr, value);
    }
  });
  const updated = find(tree, node => hasClass(node, 'book-updated'));
  if (updated) replaceNode(updated, '');
}
export async function projectDocumentHtml(template, document, options = {}) {
  const rendered = await renderDocumentMarkdown(document, options), tree = parse(template);
  const version = Number.isSafeInteger(document.version) && document.version > 0 ? document.version : 1;
  const versionNode = find(tree, node => hasClass(node, 'document-version'));
  if (versionNode) {
    const marker = versionNode.attrs.find(item => item.name === 'data-document-version');
    if (marker) marker.value = String(version);
    else versionNode.attrs.push({ name: 'data-document-version', value: String(version) });
    versionNode.childNodes = [{ nodeName: '#text', value: `Version ${version}`, parentNode: versionNode }];
  }
  const content = find(tree, node => hasClass(node, 'sl-markdown-content'));
  if (!content) throw new Error('The native document shell has no readable body.');
  const bodyHtml = /\.html?$/i.test(document.sourcePath) ? `<div class="legacy-document">${rendered.html}</div>` : rendered.html;
  const fragment = parseFragment(bodyHtml); content.childNodes = fragment.childNodes;
  for (const child of content.childNodes) child.parentNode = content;
  const outline = find(tree, node => node.attrs?.some(item => item.name === 'data-page-outline'));
  const nativeOutline = outline && find(outline, node => node.tagName === 'starlight-toc');
  if (outline) {
    const native = find(outline, node => node.tagName === 'starlight-toc');
    const items = outlineItems(rendered.headings, native || {});
    const html = items.length ? `<starlight-toc data-min-h="${escape(attr(native || {}, 'data-min-h') || '2')}" data-max-h="${escape(attr(native || {}, 'data-max-h') || '3')}">${outlineHtml(items, native || {})}</starlight-toc>` : '<p class="book-outline-empty" data-book-zh="本节暂无标题">No headings in this section</p>';
    outline.childNodes = parseFragment(html).childNodes;
    for (const child of outline.childNodes) child.parentNode = outline;
    for (let parent = outline.parentNode; parent; parent = parent.parentNode) {
      if (parent.tagName !== 'details' || !hasClass(parent, 'book-section-headings')) continue;
      parent.attrs = parent.attrs.filter(item => item.name !== 'open');
      if (items.length) parent.attrs.push({ name: 'open', value: '' });
      break;
    }
  }
  projectReadingNavigation(tree, options.readingContext || options.context, rendered.headings, nativeOutline, options.basePath || '/');
  if (document.authoredSection) projectAuthoredMetadata(tree, document, version, options.basePath || '/');
  return serialize(tree);
}
