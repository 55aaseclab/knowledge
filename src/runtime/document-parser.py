"""Extract locatable text from one immutable file. Output UTF-8 JSON Lines."""
import argparse
from collections import Counter
import csv
from hashlib import sha256
from html.parser import HTMLParser
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit
import zipfile
import xml.etree.ElementTree as ET

EVENT_STREAM = sys.stdout
MIB = 1024 * 1024
MAX_ATTACHMENT = 1024 * MIB
MAX_MEMBER = 160 * MIB
MAX_XML = 32 * MIB
MAX_TEXT = 4 * MIB
MAX_PASSAGES = 16000
MAX_CORPUS_PASSAGES = 500000
MAX_CORPUS_CHARACTERS = 256 * MIB
MAX_ARCHIVE_MEMBERS = 15000
OLE = bytes.fromhex('d0cf11e0a1b11ae1')
FORMATS = {'pdf', 'epub', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'wps',
           'rtf', 'txt', 'md', 'csv', 'html', 'htm'}


class DocumentError(Exception):
    pass


def emit(event, **properties):
    print(json.dumps({'type': event, **properties}, ensure_ascii=False), file=EVENT_STREAM, flush=True)


def clean(value):
    return ' '.join(value.replace('\x00', '').split())


def safe_path(value):
    return (value and len(value) <= 2048 and not value.startswith(('/', '\\'))
            and not re.match(r'^[a-zA-Z]:', value)
            and '\\' not in value and '..' not in value.split('/')
            and not any(ord(c) < 32 for c in value))


def display_path(info):
    if info.flag_bits & 0x800:
        return info.filename
    raw = info.filename.encode('cp437')
    for encoding in ('utf-8', 'gb18030', 'cp437'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass


def local(tag):
    return tag.rsplit('}', 1)[-1]


def nodes(root, name):
    return (item for item in root.iter() if local(item.tag) == name)


def node_text(root, name):
    return ''.join((e.text or '') for e in nodes(root, name))


def validate_archive(archive, max_bytes):
    members = archive.infolist()
    if (len(members) > MAX_ARCHIVE_MEMBERS
            or sum(i.file_size for i in members) > max_bytes):
        raise DocumentError('archive_limit')


def xml_part(archive, member):
    info = archive.getinfo(member)
    if info.file_size > MAX_XML:
        raise DocumentError('xml_size_limit')
    raw = archive.read(info)
    # ElementTree does not load remote DTDs. Reject entity declarations too,
    # including declarations in UTF-16/32 XML.
    if b'<!ENTITY' in raw.replace(b'\x00', b'').upper():
        raise DocumentError('xml_entities')
    return ET.fromstring(raw)


def relative_part(source, target):
    url = urlsplit(target)
    if url.scheme or url.netloc:
        raise DocumentError('external_reference')
    path = unquote(url.path)
    joined = posixpath.normpath(path[1:] if path.startswith('/')
                                else posixpath.join(posixpath.dirname(source), path))
    if not safe_path(joined):
        raise DocumentError('invalid_reference')
    return joined


def section_rows(blocks, section):
    """Keep adjacent short paragraphs together without crossing a section."""
    first, last, parts, length = 0, 0, [], 0
    for index, value in enumerate(blocks, 1):
        value = clean(value)
        if not value:
            continue
        if parts and length + len(value) > 750:
            yield f'{section} · 段 {first}–{last}', '\n'.join(parts)
            parts, length = [], 0
        if not parts:
            first = index
        last = index
        parts.append(value)
        length += len(value) + 1
    if parts:
        yield f'{section} · 段 {first}–{last}', '\n'.join(parts)


def epub(archive, meta):
    container = xml_part(archive, 'META-INF/container.xml')
    package_name = next(nodes(container, 'rootfile')).attrib['full-path']
    if not safe_path(package_name):
        raise DocumentError('invalid_package_path')
    package = xml_part(archive, package_name)
    meta['title'] = clean(node_text(package, 'title'))[:300] or meta['title']
    manifest = {i.get('id'): i for i in nodes(package, 'item')}
    for number, ref in enumerate(nodes(package, 'itemref'), 1):
        item = manifest.get(ref.get('idref'))
        if item is None:
            meta['issues'].add('unresolved_spine_reference')
            continue
        if item.get('media-type') not in ('application/xhtml+xml', 'text/html'):
            meta['issues'].add('nontext_spine_item')
            continue
        path = relative_part(package_name, item.attrib['href'])
        root = xml_part(archive, path)
        title = clean(node_text(root, 'title')) or posixpath.basename(path)
        body = next(nodes(root, 'body'), None)
        if body is None:
            continue
        elements = ('p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li', 'tr',
                    'figcaption', 'blockquote', 'pre', 'dt', 'dd')
        def paragraphs(element):
            tag = local(element.tag)
            if tag in ('script', 'style', 'head', 'svg'):
                return
            if tag in elements:
                yield ' '.join(element.itertext())
            elif len(element):
                for child in element:
                    yield from paragraphs(child)
            elif element.text:
                yield element.text
        yield from section_rows(paragraphs(body), f'章节 {number} {title} ({path})')


def docx(archive):
    root = xml_part(archive, 'word/document.xml')
    body = next(nodes(root, 'body'))
    table_number = 0
    start = 1
    pending = []
    for index, item in enumerate(body, 1):
        if local(item.tag) == 'p':
            if not pending:
                start = index
            pending.append(node_text(item, 't'))
        elif local(item.tag) == 'tbl':
            yield from section_rows(pending, f'正文块 {start}')
            pending.clear()
            table_number += 1
            for row_number, row in enumerate(nodes(item, 'tr'), 1):
                text = ' | '.join(node_text(cell, 't') for cell in row
                                  if local(cell.tag) == 'tc')
                yield f'表 {table_number} · 行 {row_number}', text
    yield from section_rows(pending, f'正文块 {start}')


def pptx(archive):
    root_path = 'ppt/presentation.xml'
    presentation = xml_part(archive, root_path)
    rels = xml_part(archive, 'ppt/_rels/presentation.xml.rels')
    targets = {r.get('Id'): r.get('Target') for r in rels
               if r.get('TargetMode') != 'External'}
    for slide_number, slide in enumerate(nodes(presentation, 'sldId'), 1):
        rel = next(v for k, v in slide.attrib.items() if k.endswith('}id'))
        tree = xml_part(archive, relative_part(root_path, targets[rel]))
        yield f'幻灯片 {slide_number}', '\n'.join(node_text(p, 't') for p in nodes(tree, 'p'))


def xlsx(archive):
    path = 'xl/workbook.xml'
    book = xml_part(archive, path)
    rels = xml_part(archive, 'xl/_rels/workbook.xml.rels')
    targets = {r.get('Id'): r.get('Target') for r in rels
               if r.get('TargetMode') != 'External'}
    strings = []
    if 'xl/sharedStrings.xml' in archive.NameToInfo:
        strings = [node_text(s, 't') for s in nodes(xml_part(archive, 'xl/sharedStrings.xml'), 'si')]
    for sheet in nodes(book, 'sheet'):
        rel = next(v for k, v in sheet.attrib.items() if k.endswith('}id'))
        sheet_name = sheet.attrib['name']
        tree = xml_part(archive, relative_part(path, targets[rel]))
        for row in nodes(tree, 'row'):
            values, addresses = [], []
            for cell in row:
                if local(cell.tag) != 'c':
                    continue
                address = cell.get('r', '')
                value = node_text(cell, 'v')
                if cell.get('t') == 's' and value:
                    value = strings[int(value)]
                elif cell.get('t') == 'inlineStr':
                    value = node_text(cell, 't')
                formula = next(nodes(cell, 'f'), None)
                if formula is not None:
                    expression = formula.text or ('共享公式 ' + formula.get('si', ''))
                    value = '=' + expression + (f' [缓存值 {value}]' if value else '')
                if value:
                    addresses.append(address)
                    values.append(f'{address} {value}')
            if values:
                yield f'{sheet_name}!{addresses[0]}:{addresses[-1]}', ' | '.join(values)
        for merge in nodes(tree, 'mergeCell'):
            ref = merge.get('ref', '')
            if ref:
                yield f'{sheet_name}!{ref}', f'合并单元格 {ref}'


def legacy_xls(path):
    import xlrd
    book = xlrd.open_workbook(filename=str(path), on_demand=True)
    try:
        for sheet in book.sheets():
            for index in range(sheet.nrows):
                values, addresses = [], []
                for col, cell in enumerate(sheet.row(index)):
                    if cell.ctype in (xlrd.XL_CELL_EMPTY, xlrd.XL_CELL_BLANK):
                        continue
                    value = cell.value
                    if cell.ctype == xlrd.XL_CELL_DATE:
                        value = xlrd.xldate_as_datetime(value, book.datemode).isoformat()
                    elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                        value = bool(value)
                    address = xlrd.cellname(index, col)
                    values.append(f'{address} {value}')
                    addresses.append(address)
                if values:
                    yield f'{sheet.name}!{addresses[0]}:{addresses[-1]}', ' | '.join(values)
            book.unload_sheet(sheet.name)
    finally:
        book.release_resources()


def command_text(command):
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_TEXT * 2, MAX_TEXT * 2))
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))
    if not shutil.which(command[0]):
        raise DocumentError('converter_unavailable')
    with tempfile.TemporaryFile() as out:
        completed = subprocess.run(command, stdout=out, stderr=subprocess.DEVNULL,
                                   stdin=subprocess.DEVNULL, timeout=45,
                                   env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                                        'HOME': '/nonexistent'},
                                   preexec_fn=limits, check=False)
        if completed.returncode:
            raise DocumentError('conversion_failed')
        out.seek(0)
        return out.read().decode('utf-8', 'replace')


class TextHTML(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('style', 'script', 'head'):
            self.hidden += 1
        elif tag in ('p', 'tr', 'li', 'div', 'br'):
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in ('style', 'script', 'head'):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def decode_text(raw):
    if raw.startswith((b'\xff\xfe', b'\xfe\xff')):
        return raw.decode('utf-16')
    for encoding in ('utf-8-sig', 'gb18030'):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise DocumentError('unknown_text_encoding')


def passages(path, meta):
    with path.open('rb') as f:
        head = f.read(1024)
    fmt = meta['format']
    if head.startswith(b'PK'):
        with zipfile.ZipFile(path) as archive:
            validate_archive(archive, 512 * MIB)
            for key, name, reader in [('META-INF/container.xml', 'epub', epub),
                                      ('word/document.xml', 'docx', docx),
                                      ('xl/workbook.xml', 'xlsx', xlsx),
                                      ('ppt/presentation.xml', 'pptx', pptx)]:
                if key in archive.NameToInfo:
                    meta['format'] = name
                    yield from (reader(archive, meta) if name == 'epub' else reader(archive))
                    return
            raise DocumentError('unsupported_zip_format')
    if head.startswith(b'%PDF-'):
        fmt = 'pdf'
    elif head.startswith(b'{\\rtf'):
        fmt = 'rtf'
    elif re.match(rb'\s*(?:<!doctype\s+html|<html\b)', head.lower()):
        fmt = 'html'
    meta['format'] = fmt
    if fmt == 'pdf':
        text = command_text(['pdftotext', '-enc', 'UTF-8', '-layout', str(path), '-'])
        for page, body in enumerate(text.rstrip('\f').split('\f'), 1):
            if not body.strip():
                meta['issues'].add('page_without_text')
            yield f'第 {page} 页', body
    elif fmt in ('doc', 'wps') and head.startswith(OLE):
        try:
            text = command_text(['antiword', '-m', 'UTF-8.txt', '-w', '0', str(path)])
        except DocumentError:
            text = command_text(['catdoc', '-d', 'utf-8', str(path)])
        yield from section_rows(text.splitlines(), '正文')
    elif fmt == 'xls' and head.startswith(OLE):
        yield from legacy_xls(path)
    elif fmt == 'ppt' and head.startswith(OLE):
        text = command_text(['catppt', '-d', 'utf-8', '-b', '\f', str(path)])
        for number, slide in enumerate(text.split('\f'), 1):
            yield f'幻灯片 {number}', slide
    elif fmt == 'rtf':
        yield from section_rows(command_text(['unrtf', '--text', '--nopict', str(path)]).splitlines(), '正文')
    elif fmt in ('txt', 'md', 'csv', 'html', 'htm'):
        if path.stat().st_size > MAX_XML:
            raise DocumentError('text_size_limit')
        text = decode_text(path.read_bytes())
        if fmt in ('html', 'htm'):
            parser = TextHTML()
            parser.feed(text)
            text = ''.join(parser.parts)
        if fmt == 'csv':
            for number, row in enumerate(csv.reader(io.StringIO(text)), 1):
                yield f'行 {number}', ' | '.join(row)
        else:
            yield from section_rows(text.splitlines(), '正文')
    else:
        raise DocumentError('unsupported_format')


def document(path, name, digest, seen, totals):
    extension = PurePosixPath(name).suffix.lower().lstrip('.')
    meta = {'path': name, 'sha256': digest, 'format': extension, 'title': posixpath.basename(name),
            'issues': set()}
    size, count = 0, 0
    status, reason = 'failed', None
    if digest in seen:
        status, meta['duplicateOf'] = 'duplicate', seen[digest]
    elif totals['passages'] >= MAX_CORPUS_PASSAGES or totals['characters'] >= MAX_CORPUS_CHARACTERS:
        reason = 'corpus_text_limit'
    elif extension not in FORMATS:
        status, reason = 'unsupported', 'unsupported_format'
    else:
        try:
            signal.alarm(75)
            for location, body in passages(path, meta):
                value = body.strip().replace('\x00', '')
                if not value:
                    continue
                for start in range(0, len(value), 1400):
                    chunk = value[start:start + 1400]
                    if totals['passages'] >= MAX_CORPUS_PASSAGES or totals['characters'] + len(chunk) > MAX_CORPUS_CHARACTERS:
                        raise DocumentError('corpus_text_limit')
                    if size + len(chunk) > MAX_TEXT or count >= MAX_PASSAGES:
                        raise DocumentError('document_text_limit')
                    locator = location if len(value) <= 1400 else f'{location} · 字符 {start+1}–{start+len(chunk)}'
                    emit('passage', path=name, locator=locator, text=chunk)
                    count += 1
                    size += len(chunk)
                    totals['passages'] += 1
                    totals['characters'] += len(chunk)
            if count:
                status = 'partial' if meta['issues'] else 'parsed'
            else:
                reason = 'no_extractable_text'
        except Exception as exc:
            # Errors from individual format readers must not abort sibling files.
            reason = str(exc) if isinstance(exc, DocumentError) else ('conversion_timeout'
                      if isinstance(exc, subprocess.TimeoutExpired) else 'invalid_document')
            status = 'partial' if count else ('unsupported' if reason.startswith('unsupported_') else 'failed')
        finally:
            signal.alarm(0)
    if status in ('parsed', 'partial'):
        seen[digest] = name
    issues = sorted(meta.pop('issues'))
    emit('document', **meta, status=status, passages=count,
         **({'reason': reason or ','.join(issues)} if reason or issues else {}))
    totals['documents'] += 1


def digest_file(path):
    with path.open('rb') as source:
        return sha256_stream(source)


def sha256_stream(source, dest=None):
    digest = sha256()
    for block in iter(lambda: source.read(MIB), b''):
        digest.update(block)
        if dest is not None:
            dest.write(block)
    return digest.hexdigest()


def unpack(path, work, seen, totals):
    with zipfile.ZipFile(path) as archive:
        validate_archive(archive, 2 * 1024 * MIB)
        names = set()
        for number, info in enumerate(archive.infolist(), 1):
            if info.is_dir():
                continue
            name = display_path(info)
            parts = PurePosixPath(name).parts
            if any(p in ('__MACOSX', '.DS_Store') or p.startswith('._') for p in parts):
                continue
            if not safe_path(name):
                raise DocumentError('invalid_member_path')
            if name in names:
                raise DocumentError('ambiguous_member_path')
            names.add(name)
            reason = None
            if info.file_size > MAX_MEMBER:
                reason = 'member_size_limit'
            elif info.flag_bits & 1:
                reason = 'encrypted_member'
            elif (info.external_attr >> 16) & 0o170000 == 0o120000:
                reason = 'symbolic_link'
            if not reason:
                temp = work / str(number)
                try:
                    with archive.open(info) as source, temp.open('wb') as dest:
                        digest = sha256_stream(source, dest)
                    document(temp, name, digest, seen, totals)
                except (zipfile.BadZipFile, NotImplementedError):
                    reason = 'invalid_member'
                finally:
                    temp.unlink(missing_ok=True)
            if reason:
                emit('document', path=name, title=posixpath.basename(name), sha256=None,
                     format=PurePosixPath(name).suffix.lower().lstrip('.'),
                     status='failed', passages=0, reason=reason)
                totals['documents'] += 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('file', type=Path)
    parser.add_argument('--name', required=True)
    args = parser.parse_args()
    if not safe_path(args.name) or not args.file.is_file():
        raise DocumentError('invalid_attachment')
    if args.file.stat().st_size > MAX_ATTACHMENT:
        raise DocumentError('attachment_size_limit')
    # Native converters inherit these process bounds. They only read the
    # supplied local copy. Formula values and macros are never executed.
    def timeout_handler(_signum, _frame):
        raise DocumentError('document_timeout')
    signal.signal(signal.SIGALRM, timeout_handler)
    resource.setrlimit(resource.RLIMIT_AS, (768 * MIB, 768 * MIB))
    totals = Counter({'documents': 0, 'passages': 0})
    seen = {}
    with tempfile.TemporaryDirectory(prefix='knowledge-parse-') as folder:
        if args.name.lower().endswith('.zip'):
            unpack(args.file, Path(folder), seen, totals)
        else:
            document(args.file.resolve(), args.name, digest_file(args.file), seen, totals)
    emit('done', documents=totals['documents'], passages=totals['passages'])


if __name__ == '__main__':
    # Readers such as xlrd print warnings to stdout. Reserve the original pipe
    # for JSON events and point fd 1 at stderr before any reader is imported.
    EVENT_STREAM = os.fdopen(os.dup(sys.stdout.fileno()), 'w', encoding='utf-8')
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    try:
        main()
    except (DocumentError, OSError, zipfile.BadZipFile) as exc:
        print(str(exc) if isinstance(exc, DocumentError) else 'attachment_read_failed', file=sys.stderr)
        sys.exit(1)
