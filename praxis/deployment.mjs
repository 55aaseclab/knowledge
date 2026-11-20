import { createStackIntegration } from './stack.mjs';
import { localCompose } from './local-compose.mjs';
export function createDeploymentIntegration() { return {
  stack: createStackIntegration(),
  localCompose,
  "dataId": "knowledge",
  "volumes": [
    "knowledge"
  ],
  "adapterPort": 14324,
  "runtime": {
    "KNOWLEDGE_MANAGED": "1",
    "KNOWLEDGE_ADAPTER_KEY_FILE": "/config/key",
    "KNOWLEDGE_BUSINESS_CONFIG": "/config/spaces.json",
    "KNOWLEDGE_DATA_DIR": "/data/knowledge",
    "KNOWLEDGE_INBOX_ROOT": "/data/knowledge/inbox",
    "KNOWLEDGE_BASE_PATH": "/apps/knowledge/"
  },
  "spaces": {
    "version": 1,
    "spaces": [
      "${spaceId}"
    ]
  },
  "businessBindings": {
    "dataDir": "/data/knowledge",
    "businessConfigFile": "/app-config/knowledge/spaces.json"
  },
  "initialFiles": [],
  "native": {
    "dockerfile": "Dockerfile.praxis",
    "command": [
      "node",
      "src/runtime/server.mjs"
    ]
  }
}; }
