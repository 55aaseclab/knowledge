import { projectInventory } from './inventory.mjs';
export function createStorageIntegration() { return {
  inventory: { project: projectInventory },
  "rootId": "knowledge",
  "paths": {
    "knowledge": "",
    "knowledgeContent": "content"
  },
  "sources": [
    {
      "kind": "sqlite",
      "path": "knowledge",
      "relative": "knowledge.db",
      "target": "knowledge.db"
    },
    {
      "kind": "directory",
      "path": "knowledgeContent",
      "target": "content"
    }
  ],
  "omissions": [],
  relocation: {
  "businessBindings": {
    "dataDir": "knowledge"
  },
  "registeredRoots": [
    {
      "target": "content",
      "path": "knowledgeContent"
    }
  ]
},
  recovery: { configFields: ['dataDir'], async collect(ctx) { await ctx.register({ kind: 'sqlite', source: ctx.path('dataDir', 'knowledge.db'), target: 'knowledge.db' }); } }
}; }
