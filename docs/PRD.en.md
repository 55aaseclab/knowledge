# Knowledge requirements

Browse workspace libraries, read documents and notes, search indexed passages and inspect paper statistics. The runtime supports revisioned entries, an attachment inbox, document parsing and scoped business operations. New installations start empty.

The standalone app opens its own view and keeps working data separate from its source. Integration with an external workbench uses the same renderer.

## Praxis provider

The app owns a version-1 `praxis-provider.mjs` contract for source-backed workbench cards and data-source metadata. Reads use host-supplied authorized callbacks; the provider has no direct filesystem, credential or network access. Preserve native object links, real revisions or stable content hashes, and distinct empty, partial and unavailable results. Personal card handling never modifies shared records. See [provider contract](PRAXIS-PROVIDER.md).
