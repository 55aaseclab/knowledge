# Knowledge

[简体中文](README.zh-CN.md)

Browse workspace libraries, read documents and notes, search indexed passages and inspect paper statistics. The runtime supports revisioned entries, an attachment inbox, document parsing and scoped business operations. New installations start empty.

```sh
npm ci
npm start -- --host 127.0.0.1 --port 4324
```

Open http://127.0.0.1:4324/. Set absolute `KNOWLEDGE_DATA_DIR` and `KNOWLEDGE_INBOX_ROOT` for private storage and ingestion. Parsers use Python 3, pdftotext for PDF, catdoc for DOC, and Python xlrd/openpyxl as needed. Signed operations require private service configuration. Run `npm test` for native fixtures.

## Praxis integration

The app-owned [provider contract](docs/PRAXIS-PROVIDER.md) supplies authorized source-backed cards and data-source metadata without exposing a new HTTP endpoint. Run `npm run test:provider` for the isolated provider checks.

## Praxis registration

App release: `0.1.25`. The app owns [`praxis-app.json`](praxis-app.json), its English and Simplified Chinese presentation, the icon at `public/praxis-icon.svg`, the declared PRD locations and any legacy icon aliases. `schemaVersion: 1` identifies the registration format; it is separate from this app release and from data, protocol and document revisions. Package and lockfile release metadata, where present, agree with the declaration.

[`apps.example.json`](apps.example.json) registers a local alias by referencing `./praxis-app.json` and `http://127.0.0.1:4324/`. Start the standalone service described above before using the example; registration does not start a backend or grant account, administrator or business-data access. Installation origins, data locations and access policy remain separately configured.
