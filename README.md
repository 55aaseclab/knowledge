# Knowledge

[简体中文](README.zh-CN.md)

Browse workspace libraries, read documents and notes, search indexed passages and inspect paper statistics. The runtime supports revisioned entries, an attachment inbox, document parsing and scoped business operations. New installations start empty.

```sh
npm ci
npm start -- --host 127.0.0.1 --port 4324
```

Open http://127.0.0.1:4324/. Set absolute `KNOWLEDGE_DATA_DIR` and `KNOWLEDGE_INBOX_ROOT` for private storage and ingestion. Parsers use Python 3, pdftotext for PDF, catdoc for DOC, and Python xlrd/openpyxl as needed. Signed operations require private service configuration. Run `npm test` for native fixtures.
