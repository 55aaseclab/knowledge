const language = localStorage.getItem('praxis.locale') === 'zh' ? 'zh-CN' : 'en';
function t(english, chinese, ...values) {
  return (language === 'en' ? english : chinese).replace(/\{(\d+)\}/g, (_, index) => String(values[index]));
}
document.documentElement.lang = language;
if (language === 'zh-CN') {
  for (const node of document.querySelectorAll('[data-zh]')) node.textContent = node.dataset.zh;
  for (const node of document.querySelectorAll('[data-zh-placeholder]')) node.placeholder = node.dataset.zhPlaceholder;
  for (const node of document.querySelectorAll('[data-zh-label]')) node.setAttribute('aria-label', node.dataset.zhLabel);
}
const languageButton = document.querySelector('#language');
if (languageButton) {
  languageButton.textContent = t('简体中文', 'English');
  languageButton.addEventListener('click', () => {
    const next = language === 'en' ? 'zh' : 'en';
    localStorage.setItem('praxis.locale', next);
    document.cookie = 'praxis_locale=' + next + '; Path=/; SameSite=Lax; Max-Age=31536000' + (location.protocol === 'https:' ? '; Secure' : '');
    location.reload();
  });
}

const KIND_NAMES = { note: t("Notes", "笔记"), method: t("Methods", "方法"), conclusion: t("Findings", "结论") };
const STATUS_NAMES = { draft: t("Draft", "草稿"), published: t("Published", "已发布"), archived: t("Archived", "已归档") };
const ERRORS = { UNAUTHENTICATED: t("Your session expired. Sign in again from the workbench.", "登录已失效，请回到工作台重新登录。"), FORBIDDEN: t("You do not have access to this content.", "你目前没有这份内容的访问权限。"), NOT_FOUND: t("This content is missing or no longer accessible.", "这份内容不存在或已无法访问。"), APP_UNAVAILABLE: t("Knowledge is temporarily unavailable. Try again later.", "知识库暂时无法连接，请稍后重试。") };
const base = new URL('../', import.meta.url);
const elements = Object.fromEntries(['main', 'notice', 'libraries', 'collections', 'library-content', 'library-name', 'library-description', 'search-form', 'search-input', 'entry-list', 'reader', 'knowledge-home', 'reader-outline', 'outline-items', 'overview-counts', 'paper-statistics'].map(id => [id, document.getElementById(id)]));
let config, csrfToken, libraries = [], catalog = [], navigationItems = [], selected, library, currentEntry, generation = 0, requestController, stopped = false, refreshing = false;
let navigationState = 'ready', navigationKey = '', renderedViewKey = '';
const openVenues = new Set();
const mobileLayout = matchMedia('(max-width: 760px)');
let directoryOpen = !mobileLayout.matches;
mobileLayout.addEventListener('change', () => {
  directoryOpen = !mobileLayout.matches;
  const directory = elements.libraries.querySelector('details');
  if (directory) directory.open = directoryOpen;
});
const pageSize = 25;
const documentStates = { queued: t("Queued", "等待解析"), processing: t("Parsing", "正在解析"), partial: t("Partially parsed", "部分解析"), failed: t("Parsing failed", "解析失败"), ready: t("Indexed", "已建立索引") };

const icons = {
  library: '<path d="M3 4h7a3 3 0 0 1 2 1 3 3 0 0 1 2-1h7v15h-7a3 3 0 0 0-2 1 3 3 0 0 0-2-1H3V4Zm9 1v15"/>',
  collection: '<path d="M3 6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6Z"/>',
  all: '<path d="M8 5h13M8 12h13M8 19h13M3 5h.01M3 12h.01M3 19h.01"/>',
};
function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}
function appState(state) {
  navigationState = state;
  document.dispatchEvent(new CustomEvent('praxis-navigation-state', { detail: { state } }));
}
function entryId(value) { return value.id || value.resourceId; }
function route() {
  const relative = location.pathname.startsWith(base.pathname) ? location.pathname.slice(base.pathname.length) : '';
  const pieces = relative.split('/').filter(Boolean);
  const query = new URLSearchParams(location.search);
  if (!pieces.length) return { collection: query.get('collection') || '', query: query.get('q') || '' };
  if (pieces[0] !== 'k' || ![3, 4].includes(pieces.length)) throw new Error('Invalid knowledge route.');
  const documentId = query.get('document'), offset = Number(query.get('offset') || 0);
  if (documentId !== null && (!/^[a-f0-9]{64}$/.test(documentId) || pieces.length !== 3 || !Number.isSafeInteger(offset) || offset < 0)) throw new Error('Invalid document route.');
  return { documentId, offset, spaceId: decodeURIComponent(pieces[1]), libraryId: decodeURIComponent(pieces[2]), entryId: pieces[3] ? decodeURIComponent(pieces[3]) : null, collection: query.get('collection') || '', query: query.get('q') || '', version: /^\d+$/.test(query.get('version') || '') ? Number(query.get('version')) : undefined };
}
function href(target, id, options = {}) {
  const path = `k/${encodeURIComponent(target.spaceId)}/${encodeURIComponent(target.resourceId)}/${id ? `${encodeURIComponent(id)}/` : ''}`;
  const url = new URL(path, base);
  if (options.document) url.searchParams.set('document', options.document);
  if (options.offset) url.searchParams.set('offset', String(options.offset));
  if (options.collection) url.searchParams.set('collection', options.collection);
  if (options.query) url.searchParams.set('q', options.query);
  if (options.version) url.searchParams.set('version', String(options.version));
  return `${url.pathname}${url.search}`;
}
function go(destination) {
  if (destination === `${location.pathname}${location.search}`) return;
  history.pushState(null, '', destination);
  void initialize({ force: true });
}
function link(text, destination, className) {
  const value = node('a', className, text); value.href = destination;
  value.addEventListener('click', event => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !(destination === base.pathname || destination.startsWith(`${base.pathname}k/`))) return;
    event.preventDefault(); go(destination);
  });
  return value;
}
function formatDate(value) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat(language, { year: 'numeric', month: 'numeric', day: 'numeric' }).format(date);
}
function safeLink(value) {
  if (typeof value !== 'string' || /[\\\u0000-\u0020]/.test(value) || value.startsWith('//')) return null;
  try {
    const parsed = new URL(value, location.origin);
    if (parsed.username || parsed.password || parsed.protocol !== 'https:' && !(value.startsWith('/') && parsed.origin === location.origin)) return null;
    return parsed.href;
  } catch { return null; }
}
async function api(path, body, signal = requestController?.signal) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', redirect: 'error', signal, ...(body ? { headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' }, body: JSON.stringify(body) } : {}) });
  let value;
  try { value = await response.json(); } catch { throw Object.assign(new Error('Knowledge response is unavailable.'), { status: response.status }); }
  if (!response.ok) throw Object.assign(new Error('Knowledge request failed.'), { status: response.status, code: value?.code });
  return value;
}
function invoke(operation, target, input, signal = requestController?.signal, appId = 'knowledge') {
  const body = { operation, spaceId: target.spaceId, ...(target.resourceId ? { resourceId: target.resourceId } : {}), ...(input ? { input } : {}) };
  return api(config.managed ? '/api/business/invoke' : new URL('api/invoke', base), config.managed ? { appId, ...body } : body, signal);
}
function clearContent() {
  renderedViewKey = '';
  library = undefined; currentEntry = undefined;
  elements['library-content'].hidden = true; elements.reader.hidden = true;
  elements['entry-list'].replaceChildren(); elements.reader.replaceChildren();
  elements['overview-counts'].hidden = true; elements['overview-counts'].replaceChildren();
  elements['paper-statistics'].hidden = true; elements['paper-statistics'].replaceChildren();
  elements['library-name'].textContent = ''; elements['library-description'].textContent = '';
  elements.collections.replaceChildren(); elements.collections.hidden = true;
  elements['outline-items'].replaceChildren(); elements['reader-outline'].hidden = true;
  document.title = 'Knowledge';
}
function showNotice(title, description, retry = false) {
  clearContent(); elements.notice.replaceChildren();
  if (title) elements.notice.append(node('strong', '', title));
  if (description) elements.notice.append(node('p', '', description));
  if (retry) {
    const button = node('button', '', t("Retry", "重新读取")); button.type = 'button'; button.addEventListener('click', () => void initialize({ force: true })); elements.notice.append(button);
  }
  elements.notice.hidden = false; elements.main.setAttribute('aria-busy', 'false');
}
function showError(error) {
  if (error.name === 'AbortError') return;
  if ([401, 403].includes(error.status)) { libraries = []; selected = undefined; elements.libraries.replaceChildren(); }
  if (error.status === 401) appState('login-required');
  showNotice(t("Could not load Knowledge", "无法读取知识库"), ERRORS[error.code] || t("Connection unavailable. Try again later.", "连接暂时不可用，请稍后重试。"), true);
}
function navEntry(title, destination, icon, count, current) {
  const value = link('', destination, 'nav-entry');
  const glyph = node('span', 'nav-icon'); glyph.setAttribute('aria-hidden', 'true');
  glyph.innerHTML = `<svg viewBox="0 0 24 24">${icons[icon]}</svg>`;
  value.append(glyph, node('span', 'nav-label', title));
  if (Number.isFinite(count)) value.append(node('span', 'nav-count', String(count)));
  if (current) value.setAttribute('aria-current', 'page');
  return value;
}
function renderLibraries(state) {
  const key = JSON.stringify([state.entryId, state.libraryId, state.documentId, navigationItems.map(({ title, destination, kind }) => [title, destination, kind])]);
  if (key === navigationKey && elements.libraries.childElementCount) return;
  const oldDirectory = elements.libraries.querySelector('details');
  const scroll = oldDirectory?.scrollTop || 0;
  const focused = oldDirectory?.contains(document.activeElement) ? document.activeElement : null;
  navigationKey = key;
  elements.libraries.replaceChildren();
  elements.libraries.hidden = Boolean(state.entryId);
  if (elements.libraries.hidden) return;
  elements.libraries.append(navEntry(t("Library overview", "知识概览"), base.pathname, 'all', undefined, !state.libraryId));
  if (!navigationItems.length) return;
  const directory = node('details', 'catalog-directory');
  directory.open = directoryOpen;
  directory.addEventListener('toggle', () => { if (directory.isConnected) directoryOpen = directory.open; });
  directory.append(node('summary', '', t("Contents", "内容目录")));
  for (const value of navigationItems) {
    const row = navEntry(value.title, value.destination, value.kind === 'package' ? 'collection' : 'library', undefined, state.documentId === value.id && value.target?.spaceId === state.spaceId && value.target?.resourceId === state.libraryId);
    row.classList.add('content-nav-entry');
    directory.append(row);
  }
  elements.libraries.append(directory);
  if (focused) {
    const replacement = focused.matches('summary') ? directory.querySelector('summary') : [...directory.querySelectorAll('a')].find(anchor => anchor.href === focused.href);
    replacement?.focus({ preventScroll: true });
  }
  directory.scrollTop = scroll;
}
function renderCollections(state) {
  elements.collections.replaceChildren();
  elements.collections.hidden = Boolean(state.entryId || state.documentId);
  if (elements.collections.hidden) return;
  const activeIds = new Set(library.entries.filter(value => value.status !== 'archived').map(entryId));
  elements.collections.append(navEntry(t("All entries", "全部条目"), href(selected), 'all', activeIds.size + (library.documents?.length || 0), !state.collection && !state.entryId));
  for (const value of library.collections) elements.collections.append(navEntry(value.title, href(selected, undefined, { collection: value.id }), 'collection', value.entryIds.filter(id => activeIds.has(id)).length, state.collection === value.id && !state.entryId));
  elements.collections.hidden = false;
}
function entryMeta(entry) {
  const value = node('div', 'entry-meta');
  if (KIND_NAMES[entry.kind]) value.append(node('span', '', KIND_NAMES[entry.kind]));
  if (STATUS_NAMES[entry.status]) value.append(node('span', '', STATUS_NAMES[entry.status]));
  const count = entry.sourceRefs?.length ?? entry.sourceCount;
  if (Number.isFinite(count) && count > 0) value.append(node('span', '', t("Sources: {0}", "{0} 个来源", count)));
  const date = formatDate(entry.updatedAt);
  if (date) value.append(node('span', '', t("Updated {0}", "更新于 {0}", date)));
  return value;
}
function tags(values) {
  const list = node('div', 'tags');
  for (const value of values || []) list.append(node('span', 'tag', value));
  return list;
}
function renderRows(items, emptyText) {
  elements['entry-list'].replaceChildren();
  if (!items.length && emptyText) elements['entry-list'].append(node('p', 'empty-inline', emptyText));
  for (const value of items) {
    const row = link('', value.destination, 'entry-row'); row.dataset.entryId = entryId(value);
    row.append(node('div', 'entry-title', value.title));
    if (value.target) row.append(entryMeta(value));
    if (value.excerpt || value.preview) row.append(node('p', 'entry-preview', value.excerpt || value.preview));
    if (value.tags?.length) row.append(tags(value.tags));
    elements['entry-list'].append(row);
  }
}
const paperStates = { complete: t("Complete", "完整"), partial: t("Partial", "部分"), pending: t("Unchecked", "未检查") };
function paperTotals(editions) {
  let papers = 0, cached = 0, observed = 0;
  for (const edition of editions) {
    if (edition.status === 'pending' && !edition.countsObservedAt) continue;
    observed++;
    papers += edition.papers;
    cached += edition.cachedPdfs;
  }
  return { papers, cached, observed };
}
function paperTable(venue) {
  if (!venue.editions.length) {
    return node('p', 'paper-observed', venue.archiveStatus === 'complete' ? t("The conference website lists no past editions.", "官网未列出已举办的场次。") : t("The edition directory has not been collected yet.", "尚未取得历届目录。"));
  }
  const table = node('table', 'paper-editions');
  table.setAttribute('aria-label', venue.name + t(" edition statistics", " 历届统计"));
  const header = table.createTHead().insertRow();
  for (const title of [t("Year", "年份"), t("Papers", "论文"), t("Cached PDFs", "已缓存 PDF"), t("Status", "状态")]) {
    const cell = node('th', '', title); cell.scope = 'col'; header.append(cell);
  }
  const body = table.createTBody();
  for (const edition of venue.editions) {
    const row = body.insertRow();
    const observed = edition.status !== 'pending' || edition.countsObservedAt;
    const year = node('th', '', edition.year); year.scope = 'row'; row.append(year);
    row.insertCell().textContent = observed ? edition.papers.toLocaleString(language) : '—';
    row.insertCell().textContent = observed ? edition.cachedPdfs.toLocaleString(language) : '—';
    const status = row.insertCell();
    status.textContent = paperStates[edition.status];
    if (edition.countsObservedAt) status.append(node('small', 'paper-asof', t("Counts as of ", "计数截至 ") + formatDate(edition.countsObservedAt)));
  }
  return table;
}
const paperGroups = { systems: t("Systems", "系统"), security: t("Security", "安全"), 'software-engineering': t("Software engineering", "软件工程") };
function paperDisclosure(className, key, heading, show) {
  const details = node('details', className);
  const summary = node('summary'); summary.append(heading); details.append(summary);
  function fill() {
    if (details.children.length === 1 && details.open) details.append(show());
  }
  details.open = openVenues.has(key); fill();
  details.addEventListener('toggle', () => {
    if (!details.isConnected) return;
    if (details.open) { openVenues.add(key); fill(); } else openVenues.delete(key);
  });
  return details;
}
function venueDisclosure(venue, target) {
  const totals = paperTotals(venue.editions);
  const heading = document.createDocumentFragment();
  const info = [paperStates[venue.archiveStatus]];
  if (totals.observed) info.push(totals.papers.toLocaleString(language) + t(" papers", " 篇"), totals.cached.toLocaleString(language) + t(" PDFs", " 份 PDF"));
  heading.append(node('span', 'paper-name', venue.name), node('span', 'paper-summary-counts', info.join(' · ')));
  return paperDisclosure('paper-venue', JSON.stringify([target.spaceId, target.resourceId, venue.group, venue.venueKey]), heading, () => paperTable(venue));
}
function renderPaperStatistics(views, showEmpty = false) {
  const section = elements['paper-statistics'];
  const available = views.filter(({ view }) => view.paperStatistics);
  section.replaceChildren(); section.hidden = !available.length && !(showEmpty && views.length);
  if (section.hidden) return;
  section.append(node('h2', '', t("Conference papers", "会议论文统计")));
  if (!available.length) section.append(node('p', 'paper-observed', t("This library has no conference statistics yet.", "当前知识库尚无会议采集统计。")));
  for (const { target, view } of available) {
    const stats = view.paperStatistics;
    const libraryGroup = node('div', 'paper-group');
    if (available.length > 1) libraryGroup.append(node('h3', '', [target.spaceName, target.name].filter(Boolean).join(' · ')));
    libraryGroup.append(node('p', 'paper-observed', t("CCF A · Observed ", "CCF A 类 · 观测于 ") + formatDate(stats.observedAt)));
    for (const [group, title] of Object.entries(paperGroups)) {
      const venues = stats.venues.filter(venue => venue.group === group);
      const totals = paperTotals(venues.flatMap(venue => venue.editions));
      const complete = venues.filter(venue => venue.archiveStatus === 'complete').length;
      const heading = document.createDocumentFragment();
      heading.append(node('strong', 'paper-name', title), node('span', 'paper-summary-counts', [
        venues.length + t(" conferences", " 个会议"), totals.observed ? totals.papers.toLocaleString(language) + t(" papers", " 篇论文") : t("No paper count yet", "尚无论文计数"),
        ...(totals.observed ? [totals.cached.toLocaleString(language) + t(" PDFs cached", " 份 PDF 已缓存")] : []),
      ].join(' · ')));
      const panel = paperDisclosure('paper-breakdown', JSON.stringify([target.spaceId, target.resourceId, group]), heading, () => {
        const list = node('div');
        list.append(node('p', 'paper-observed', venues.length ? complete + '/' + venues.length + t(" edition directories complete", " 个历届目录完整") : t("No conference records yet.", "尚无会议记录。")));
        for (const venue of venues) list.append(venueDisclosure(venue, target));
        return list;
      });
      libraryGroup.append(panel);
    }
    section.append(libraryGroup);
  }
}
function renderOverview(views, books) {
  const catalogUnavailable = books === null;
  elements['library-name'].textContent = t("Library overview", "知识概览");
  elements['library-description'].textContent = '';
  elements['search-form'].hidden = true;
  const editions = new Map();
  let anySnapshot = false;
  for (const { view } of views) {
    if (!view.paperStatistics) continue;
    anySnapshot = true;
    for (const venue of view.paperStatistics.venues) {
      for (const edition of venue.editions) {
        if (edition.status === 'pending' && !edition.countsObservedAt) continue;
        const key = JSON.stringify([venue.venueKey, edition.year]);
        const observed = Date.parse(edition.countsObservedAt ?? view.paperStatistics.observedAt);
        if (!editions.has(key) || editions.get(key).observed < observed) editions.set(key, { observed, papers: edition.papers });
      }
    }
  }
  const documents = views.flatMap(({ view }) => view.documents || []);
  const countPublications = kind => catalogUnavailable ? null : books.filter(item => item.category === kind).length + documents.filter(item => item.kind === kind).length;
  const notes = catalogUnavailable ? null : books.reduce((count, item) => count + (item.category === 'note' ? item.noteCount ?? 1 : 0), 0) +
    views.reduce((count, { view }) => count + view.entries.filter(entry => entry.kind === 'note' && entry.status !== 'archived').length, 0);
  const metrics = [
    [t("Papers discovered", "已发现论文"), editions.size || !anySnapshot ? [...editions.values()].reduce((count, item) => count + item.papers, 0) : null],
    [t("Books", "书籍"), countPublications('book')], [t("Document packs", "资料包"), countPublications('package')], [t("Notes", "笔记"), notes],
  ];
  const counts = elements['overview-counts'];
  for (const [label, count] of metrics) {
    const metric = node('div');
    metric.append(node('dt', '', label), node('dd', '', count === null ? '—' : count.toLocaleString(language)));
    counts.append(metric);
  }
  counts.hidden = false;
  renderPaperStatistics(views, true);
  if (catalogUnavailable) {
    const notice = node('div', 'notice'); notice.setAttribute('role', 'status');
    const retry = node('button', '', t("Retry book directory", "重新读取书籍目录")); retry.type = 'button';
    retry.addEventListener('click', () => void initialize({ force: true }));
    notice.append(node('p', '', t("Could not load the book directory.", "书籍目录暂时无法读取。")), retry);
    elements['entry-list'].append(notice);
  }
  elements.notice.hidden = true; elements.reader.hidden = true; elements['library-content'].hidden = false;
  document.title = 'Knowledge';
}
function renderDocumentOutline(result, state) {
  if (!result.outline?.length) return;
  const isBook = result.document.kind === 'book';
  const label = node('label', 'document-outline-label', isBook ? t("Chapters", "章节目录") : t("Files", "文件目录"));
  label.htmlFor = 'document-outline-select';
  const select = node('select', 'document-outline-select');
  select.id = label.htmlFor;
  const prompt = node('option', '', isBook ? t("Choose chapter", "选择章节") : t("Choose file", "选择文件"));
  prompt.value = ''; select.append(prompt);
  const target = selected;
  const more = node('button', 'document-outline-more', isBook ? t("Load more chapters", "加载更多章节") : t("Load more files", "加载更多文件"));
  more.type = 'button';
  let next;
  const append = page => {
    for (const { label, ordinal } of page.outline) {
      const option = node('option', '', label); option.value = String(ordinal); select.append(option);
    }
    next = page.nextOutlineOffset;
    more.hidden = !Number.isSafeInteger(next);
  };
  append(result);
  select.addEventListener('change', () => {
    if (!select.value) return;
    const ordinal = Number(select.value);
    const page = Math.floor(ordinal / pageSize) * pageSize;
    const destination = href(target, undefined, { document: state.documentId, offset: page });
    if (page === state.offset) {
      history.pushState(null, '', destination + '#passage-' + ordinal);
      scrollToHeading();
      prompt.selected = true;
    } else go(destination + '#passage-' + ordinal);
  });
  more.addEventListener('click', async () => {
    if (more.disabled || !Number.isSafeInteger(next)) return;
    more.disabled = true;
    try {
      const page = await invoke('read_document', target, { documentId: state.documentId, offset: state.offset, limit: 1, includeOutline: true, outlineOffset: next }, null);
      if (more.isConnected) append(page);
    } catch (error) {
      if (more.isConnected) {
        if ([401, 403].includes(error.status)) showError(error);
        else more.textContent = t("Reload directory", "重新加载目录");
      }
    } finally { more.disabled = false; }
  });
  elements['outline-items'].prepend(label, select, more);
}
function renderDocument(result, state) {
  const doc = result.document;
  if (!doc || doc.id !== state.documentId || !Array.isArray(result.items)) throw new Error('Invalid document response.');
  const reader = elements.reader;
  const top = node('div', 'reader-top');
  top.append(link(t("Library overview", "知识概览"), base.pathname, 'back-link'));
  reader.append(top, node('h1', '', doc.title), node('p', 'description', [doc.filename, documentStates[doc.status]].filter(Boolean).join(' · ')));
  if (result.issues?.length) {
    const issues = node('details', 'document-issues');
    const count = doc.problems ?? result.issues.length;
    issues.append(node('summary', '', t("Partially parsed files ({0})", "未完整解析的文件（{0}）", count)));
    const list = node('ul');
    for (const issue of result.issues) list.append(node('li', '', issue.path));
    issues.append(list);
    if (count > result.issues.length) issues.append(node('p', 'empty-inline', t("Showing the first {0} files.", "显示前 {0} 个文件。", result.issues.length)));
    reader.append(issues);
  }
  const body = node('div', 'reader-body');
  for (const item of result.items) {
    const section = node('section', 'document-passage');
    section.id = `passage-${item.ordinal}`;
    section.append(node('h2', 'passage-locator', [item.source, item.locator].filter(Boolean).join(' · ')), node('p', '', item.text));
    body.append(section);
  }
  if (!result.items.length) body.append(node('p', 'empty-inline', t("No readable passages.", "当前没有可阅读的段落。")));
  renderOutline(body);
  renderDocumentOutline(result, state);
  reader.append(body);
  const { total } = result;
  if (state.offset || total > pageSize) {
    const paging = node('nav', 'document-paging'); paging.setAttribute('aria-label', t("Passages", "分段阅读"));
    const destination = offset => href(selected, undefined, { document: doc.id, offset });
    if (state.offset) paging.append(link(t("Previous", "上一页"), destination(Math.max(0, state.offset - pageSize)), 'back-link'));
    if (result.items.length) paging.append(node('span', '', t("Passages {0}–{1} of {2}", "第 {0}–{1} 段，共 {2} 段", state.offset + 1, state.offset + result.items.length, total)));
    if (state.offset + pageSize < total) paging.append(link(t("Next", "下一页"), destination(state.offset + pageSize), 'back-link'));
    reader.append(paging);
  }
  elements.notice.hidden = true; elements['library-content'].hidden = true; reader.hidden = false;
  document.title = `${doc.title} · Knowledge`;
  scrollToHeading();
}
function renderList(items, state, draftQuery) {
  elements['library-name'].textContent = state.collection ? library.collections.find(value => value.id === state.collection)?.title || library.library.name : library.library.name;
  elements['library-description'].textContent = state.collection ? library.collections.find(value => value.id === state.collection)?.description || '' : library.library.description;
  elements['search-form'].hidden = false;
  elements['search-input'].value = draftQuery ?? state.query ?? '';
  renderPaperStatistics(state.collection || state.query ? [] : [{ target: selected, view: library }]);
  const rows = items.filter(value => value.status !== 'archived').map(value => ({ ...value, target: selected, destination: href(selected, entryId(value)) }));
  if (!state.collection) {
    const query = state.query?.trim().toLocaleLowerCase() || '';
    rows.push(...documentLinks(selected, library).filter(doc => !query || [doc.title, doc.filename].some(text => text?.toLocaleLowerCase().includes(query))));
  }
  renderRows(rows, state.query ? t("No matches. Try another keyword.", "没有找到相关内容，试试其他关键词。") : t("No entries yet.", "这里还没有条目。"));
  elements.notice.hidden = true; elements.reader.hidden = true; elements['library-content'].hidden = false;
  document.title = `${elements['library-name'].textContent} · Knowledge`;
}
function documentLinks(target, view) {
  return (view.documents || []).map(value => ({ ...value, target, destination: href(target, undefined, { document: value.id }) }));
}
async function readLibraries(targets, signal) {
  const views = new Array(targets.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, async () => {
    while (next < targets.length) {
      const index = next++, target = targets[index];
      const view = await invoke('read_library', target, undefined, signal);
      if (!view.library || view.library.id !== target.resourceId || !Array.isArray(view.entries) || !Array.isArray(view.collections)) throw new Error('Invalid knowledge library response.');
      views[index] = { target, view };
    }
  }));
  return views;
}
async function readBooks(signal) {
  if (!libraries.some(value => value.resourceId === 'legacy-library')) return [];
  const result = await api(new URL('reading-catalog.json', base), undefined, signal);
  if (result.version !== 2 || !Array.isArray(result.items) || result.items.length > 200) throw new Error('Invalid reading catalog.');
  return result.items.map(value => {
    if (!['section', 'chapter', 'part'].includes(value.kind) || typeof value.id !== 'string' || typeof value.title !== 'string' || !value.title.trim() || typeof value.href !== 'string' || !/^(?:[a-z0-9][a-z0-9-]*\/)+$/.test(value.href)) throw new Error('Invalid reading destination.');
    return { id: value.id, title: value.title, kind: value.kind, category: value.category, noteCount: value.noteCount, destination: new URL(value.href, base).pathname };
  });
}
function inlineMarkdown(container, value) {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    container.append(document.createTextNode(value.slice(cursor, match.index)));
    const text = match[0];
    if (text.startsWith('`')) container.append(node('code', '', text.slice(1, -1)));
    else if (text.startsWith('**')) container.append(node('strong', '', text.slice(2, -2)));
    else if (text.startsWith('*')) container.append(node('em', '', text.slice(1, -1)));
    else {
      const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(text), target = safeLink(parts[2]);
      if (target) { const anchor = node('a', '', parts[1]); anchor.href = target; anchor.rel = 'noreferrer'; container.append(anchor); }
      else container.append(document.createTextNode(parts[1]));
    }
    cursor = match.index + text.length;
  }
  container.append(document.createTextNode(value.slice(cursor)));
}
function markdown(value) {
  const result = node('div', 'reader-body');
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const content = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) content.push(lines[index++]);
      index++; const pre = node('pre'); pre.append(node('code', '', content.join('\n'))); result.append(pre); continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { const title = node(`h${Math.min(heading[1].length + 1, 6)}`); inlineMarkdown(title, heading[2]); result.append(title); index++; continue; }
    if (/^\s*>\s?/.test(line)) { const quote = node('blockquote'); inlineMarkdown(quote, line.replace(/^\s*>\s?/, '')); result.append(quote); index++; continue; }
    if (/^\s*(?:[-*+]\s+|\d+\.\s+)/.test(line)) {
      const ordered = /^\s*\d+\./.test(line), list = node(ordered ? 'ol' : 'ul');
      while (index < lines.length && (ordered ? /^\s*\d+\.\s+/ : /^\s*[-*+]\s+/).test(lines[index])) {
        const item = node('li'); inlineMarkdown(item, lines[index++].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')); list.append(item);
      }
      result.append(list); continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !/^(?:#{1,6}\s|\s*```|\s*>|\s*(?:[-*+]\s+|\d+\.\s+))/.test(lines[index])) paragraph.push(lines[index++]);
    const p = node('p'); inlineMarkdown(p, paragraph.join('\n')); result.append(p);
  }
  return result;
}
function scrollToHeading() {
  if (!location.hash) return;
  let id;
  try { id = decodeURIComponent(location.hash.slice(1)); } catch { return; }
  const heading = elements.reader.querySelectorAll('.reader-body [id]');
  [...heading].find(value => value.id === id)?.scrollIntoView({ block: 'start' });
}
function renderOutline(body) {
  const headings = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(heading => !/^(?:目录|本页目录|contents|table\s+of\s+contents)$/i.test(heading.textContent.trim()));
  const used = new Set();
  const minimum = headings.length ? Math.min(...headings.map(value => Number(value.tagName.slice(1)))) : 1;
  for (const heading of headings) {
    const slug = heading.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '') || 'heading';
    const stem = `section-${slug}`;
    let id = stem, suffix = 1;
    while (used.has(id)) id = `${stem}-${suffix++}`;
    used.add(id); heading.id = id; heading.tabIndex = -1;
    const anchor = node('a', 'outline-link', heading.textContent);
    anchor.href = `#${encodeURIComponent(id)}`;
    anchor.style.setProperty('--outline-level', String(Number(heading.tagName.slice(1)) - minimum));
    anchor.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      history.replaceState(history.state, '', anchor.href);
      heading.scrollIntoView({ block: 'start' }); heading.focus({ preventScroll: true });
    });
    elements['outline-items'].append(anchor);
  }
  if (!headings.length) elements['outline-items'].append(node('p', 'outline-empty', t("No headings on this page", "本页暂无章节")));
  elements['reader-outline'].open = !matchMedia('(max-width: 760px)').matches;
  elements['reader-outline'].hidden = false;
}
async function showSource(details, target, sourceId, current) {
  if (!details.open || details.dataset.loaded || details.dataset.loading) return;
  details.dataset.loading = 'true';
  const content = details.querySelector('.source-content') || node('div', 'source-content');
  content.textContent = t("Loading source…", "正在读取来源…"); details.append(content);
  try {
    const result = await invoke('read_source', target, { sourceId });
    if (current !== generation || stopped) return;
    const source = result.source;
    if (!source || source.id !== sourceId) throw new Error('Invalid knowledge source response.');
    content.replaceChildren();
    const facts = node('div', 'source-facts');
    if (source.createdAt) facts.append(node('span', '', t("Added {0}", "收录于 {0}", formatDate(source.createdAt))));
    if (source.origin?.appId === 'projects') facts.append(node('span', '', t("Project revision {0}", "项目版本 {0}", source.origin.revision)));
    const url = safeLink(source.url);
    if (url) { const reference = node('a', '', t("Open original link", "打开原始链接")); reference.href = url; reference.rel = 'noreferrer'; facts.append(reference); }
    if (facts.children.length) content.append(facts);
    content.append(node('pre', '', source.text));
    details.dataset.loaded = 'true';
  } catch (error) {
    if (current !== generation || stopped || error.name === 'AbortError') return;
    if ([401, 403].includes(error.status)) { showError(error); return; }
    content.replaceChildren(node('p', 'empty-inline', t("Could not load the source. Collapse and try again.", "来源暂时无法读取，请收起后重试。")));
  } finally { delete details.dataset.loading; }
}
function renderSources(result, current) {
  const section = node('section', 'reader-section'); section.append(node('h2', '', t("Source", "来源")));
  const list = node('ul', 'source-list');
  const sources = new Map((result.sources || []).map(value => [value.id, value]));
  for (const reference of result.entry.sourceRefs || []) {
    const source = sources.get(reference.sourceId);
    const item = node('li', 'source-item'), details = node('details');
    details.append(node('summary', '', source?.title || t("Source records", "来源记录")));
    if (reference.locator) details.append(node('div', 'source-locator', reference.locator));
    details.addEventListener('toggle', () => void showSource(details, selected, reference.sourceId, current));
    item.append(details); list.append(item);
  }
  section.append(list.children.length ? list : node('p', 'empty-inline', t("This entry has no linked sources.", "这篇条目尚未关联来源。")));
  return section;
}
async function renderProjectReferences(targetNode, entry, current) {
  if (!config.managed) { targetNode.hidden = true; return; }
  const spaces = catalog.filter(space => space.apps.some(app => app.id === 'projects' && app.actions.includes('read')));
  if (!spaces.length) { targetNode.hidden = true; return; }
  const url = `/apps/knowledge/k/${encodeURIComponent(selected.spaceId)}/${encodeURIComponent(selected.resourceId)}/${encodeURIComponent(entry.id)}/`;
  try {
    const results = await Promise.all(spaces.map(async space => {
      try { return await invoke('find_references', { spaceId: space.id }, { url }, undefined, 'projects'); }
      catch (error) {
        if (error.status === 401 || error.name === 'AbortError') throw error;
        return error.status === 403 ? { items: [] } : null;
      }
    }));
    if (current !== generation || stopped) return;
    targetNode.replaceChildren(node('h2', '', t("Projects referencing this entry", "引用这篇条目的项目")));
    const list = node('ul', 'reference-list');
    results.forEach((result, index) => {
      for (const item of result?.items || []) {
        if (!item.resourceId || !item.name) continue;
        const url = new URL('/apps/projects/', location.origin);
        url.hash = new URLSearchParams({ project: item.resourceId, space: spaces[index].id, view: 'knowledge' }).toString();
        const li = node('li'); const anchor = node('a', '', item.name); anchor.href = `${url.pathname}${url.hash}`; li.append(anchor); list.append(li);
      }
    });
    const partial = results.includes(null);
    if (list.children.length) targetNode.append(list);
    if (partial) targetNode.append(node('p', 'empty-inline', t("Some project references could not be loaded.", "部分项目引用暂时无法读取。")));
    else if (!list.children.length) targetNode.append(node('p', 'empty-inline', t("No references in your accessible projects.", "可访问的项目中暂无引用。")));
  } catch (error) {
    if (current !== generation || stopped || error.name === 'AbortError') return;
    if (error.status === 401) { showError(error); return; }
    targetNode.hidden = true;
  }
}
function renderEntry(result, state, current) {
  const entry = result.entry;
  if (!entry || entry.id !== state.entryId || typeof entry.body !== 'string') throw new Error('Invalid knowledge entry response.');
  currentEntry = entry;
  const reader = elements.reader; reader.replaceChildren();
  const top = node('div', 'reader-top'); top.append(link(t("All content", "全部内容"), base.pathname, 'back-link')); reader.append(top);
  reader.append(node('h1', '', entry.title));
  const meta = entryMeta(entry); meta.className = 'reader-meta';
  const label = node('label', 'visually-hidden', t("Entry revision", "条目版本")); label.htmlFor = 'entry-version';
  const select = node('select'); select.id = 'entry-version'; select.setAttribute('aria-label', t("Entry revision", "条目版本"));
  const history = result.history?.length ? [...result.history].sort((a, b) => b.version - a.version) : [{ version: entry.version, updatedAt: entry.updatedAt }];
  for (const item of history) {
    const option = node('option', '', t("Revision {0}{1}", "版本 {0}{1}", item.version, formatDate(item.updatedAt) ? `（${formatDate(item.updatedAt)}）` : '')); option.value = String(item.version); select.append(option);
  }
  select.value = String(entry.version);
  select.addEventListener('change', () => go(href(selected, entry.id, { version: Number(select.value) })));
  meta.append(label, select); reader.append(meta);
  if (entry.tags?.length) reader.append(tags(entry.tags));
  const body = markdown(entry.body);
  renderOutline(body);
  reader.append(body, renderSources(result, current));
  const projects = node('section', 'reader-section'); projects.append(node('h2', '', t("Projects referencing this entry", "引用这篇条目的项目")), node('p', 'empty-inline', t("Loading references…", "正在读取引用…"))); reader.append(projects);
  void renderProjectReferences(projects, entry, current);
  elements.notice.hidden = true; elements['library-content'].hidden = true; reader.hidden = false;
  document.title = `${entry.title} · Knowledge`;
  scrollToHeading();
}
async function initialize({ force = false, silent = false } = {}) {
  if (stopped || refreshing && !force) return;
  refreshing = true;
  const current = ++generation;
  requestController?.abort(); requestController = new AbortController();
  const signal = requestController.signal;
  if (!silent) {
    clearContent();
    selected = undefined; navigationItems = []; elements.libraries.replaceChildren();
    elements.notice.textContent = t("Loading Knowledge…", "正在读取知识库…"); elements.notice.hidden = false; elements.main.setAttribute('aria-busy', 'true');
  }
  try {
    const state = route();
    renderedLocation = `${location.pathname}${location.search}`;
    config ||= await api(new URL('api/config', base), undefined, signal);
    if (current !== generation || stopped) return;
    let spaces;
    if (config.managed) {
      const session = await api('/auth/session', undefined, signal); csrfToken = session.csrfToken;
      const result = await api('/api/business/catalog', undefined, signal); catalog = result.spaces || [];
      spaces = catalog.filter(space => space.apps.some(app => app.id === 'knowledge' && app.actions.includes('read')));
    } else spaces = config.spaces?.length ? config.spaces : [{ id: 'local', name: t("Local", "本地") }];
    const results = await Promise.all(spaces.map(async space => ({ space, result: await invoke('list_libraries', { spaceId: space.id }, undefined, signal) })));
    if (current !== generation || stopped) return;
    libraries = results.flatMap(({ space, result }) => (result.items || []).map(value => ({ ...value, resourceId: value.resourceId || value.id, spaceId: space.id, spaceName: space.name || '' })));
    selected = state.libraryId ? libraries.find(value => value.resourceId === state.libraryId && value.spaceId === state.spaceId && value.resourceId !== 'legacy-library') : undefined;
    if (state.libraryId && !selected) {
      navigationItems = [];
      renderLibraries(state);
      showNotice(t("Library unavailable", "知识库暂不可用"), t("This library is missing or no longer accessible.", "这个知识库不存在或已无法访问。")); return;
    }
    const [views, books] = await Promise.all([
      readLibraries(selected && !state.documentId ? [selected] : libraries.filter(value => value.resourceId !== 'legacy-library'), signal),
      state.entryId ? [] : readBooks(signal).catch(error => {
        if (error.name === 'AbortError' || [401, 403].includes(error.status)) throw error;
        return null;
      }),
    ]);
    if (current !== generation || stopped) return;
    navigationItems = [...views.flatMap(({ target, view }) => [
      ...view.entries.filter(value => value.status !== 'archived').map(value => ({ ...value, target, destination: href(target, entryId(value)) })),
      ...documentLinks(target, view),
    ]), ...(books || [])];
    renderLibraries(state);
    const view = views.find(item => item.target === selected)?.view;
    // A background refresh should leave an unchanged reader or catalog in the DOM.
    // Parser state can advance independently of the library revision.
    const viewKey = JSON.stringify([state, state.documentId ? view.documents?.find(doc => doc.id === state.documentId) : selected ? view : [views, books]]);
    if (silent && !state.entryId && renderedViewKey === viewKey) return;
    const oldPosition = silent ? window.scrollY : null;
    const searchField = elements['search-input'];
    const searchVisible = silent && !elements['library-content'].hidden && !elements['search-form'].hidden;
    const draftQuery = searchVisible ? searchField.value : undefined;
    const restoreSearchFocus = searchVisible && document.activeElement === searchField;
    const outlineOpen = silent && !elements['reader-outline'].hidden ? elements['reader-outline'].open : undefined;
    clearContent();
    if (!selected) {
      renderOverview(views, books); appState('ready'); elements.main.setAttribute('aria-busy', 'false');
      renderedViewKey = viewKey;
      if (oldPosition !== null) window.scrollTo(0, oldPosition);
      return;
    }
    library = view;
    if (state.collection && !library.collections.some(value => value.id === state.collection)) throw Object.assign(new Error('Unknown collection.'), { status: 404, code: 'NOT_FOUND' });
    renderCollections(state);
    if (state.documentId) {
      const result = await invoke('read_document', selected, { documentId: state.documentId, offset: state.offset, limit: pageSize, includeOutline: true }, signal);
      if (current !== generation || stopped) return;
      renderDocument(result, state);
    } else if (state.entryId) {
      const result = await invoke('read_entry', selected, { entryId: state.entryId, ...(state.version ? { version: state.version } : {}) }, signal);
      if (current !== generation || stopped) return;
      renderEntry(result, state, current);
    } else if (state.query) {
      const result = await invoke('search', selected, { query: state.query, ...(state.collection ? { collectionId: state.collection } : {}), limit: 50 }, signal);
      if (current !== generation || stopped) return;
      renderList(result.items || [], state, draftQuery);
    } else {
      const collection = library.collections.find(value => value.id === state.collection);
      const items = collection ? library.entries.filter(value => collection.entryIds.includes(entryId(value))) : library.entries;
      renderList(items, state, draftQuery);
    }
    appState('ready'); elements.main.setAttribute('aria-busy', 'false');
    renderedViewKey = viewKey;
    if (outlineOpen !== undefined) elements['reader-outline'].open = outlineOpen;
    if (restoreSearchFocus && !elements['search-form'].hidden) searchField.focus({ preventScroll: true });
    if (oldPosition !== null) window.scrollTo(0, oldPosition);
  } catch (error) { if (current === generation && !stopped) showError(error); }
  finally { if (current === generation) refreshing = false; }
}
elements['search-form'].addEventListener('submit', event => {
  event.preventDefault();
  if (!selected) return;
  const state = route(); go(href(selected, undefined, { collection: state.collection, query: elements['search-input'].value.trim() }));
});
let renderedLocation = `${location.pathname}${location.search}`;
window.addEventListener('popstate', () => {
  const next = `${location.pathname}${location.search}`;
  if (currentEntry && next === renderedLocation) { scrollToHeading(); return; }
  renderedLocation = next; void initialize({ force: true });
});
elements['knowledge-home'].addEventListener('click', event => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); go(base.pathname);
});
const narrowReader = matchMedia('(max-width: 760px)');
narrowReader.addEventListener('change', () => { elements['reader-outline'].open = !narrowReader.matches; });
document.addEventListener('praxis-navigation-ready', () => appState(navigationState));
document.addEventListener('praxis-session-ended', () => {
  stopped = true; generation++; requestController?.abort(); libraries = []; navigationItems = []; selected = undefined;
  elements.libraries.replaceChildren(); showNotice(t("Session expired", "登录已失效"), t("Sign in again from the workbench.", "请回到工作台重新登录。")); appState('login-required');
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void initialize({ silent: true }); });
window.addEventListener('focus', () => void initialize({ silent: true }));
setInterval(() => { if (document.visibilityState === 'visible') void initialize({ silent: true }); }, 30000);
await initialize();
