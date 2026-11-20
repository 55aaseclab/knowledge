function route({pathname}) {
  const legacy=!['/','/index.html','/health','/api/config','/workspace-assets/app.js','/workspace-assets/styles.css'].includes(pathname)&&!/^\/k\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}\/[a-z0-9][a-z0-9-]{0,79}\/(?:[a-z0-9][a-z0-9-]{0,79}\/)?$/.test(pathname);
  return {binding:'native',checks:legacy?['legacy-library']:[]};
}

export function createWebIntegration() {
  return {
    "slug": "knowledge",
    "policy": "grant",
    "kind": "proxy",
    "allowUpgrade": false,
    "nativePort": 14324,
    "nativePolicies": {
      "legacy-library": {
        "resource": "legacy-library",
        "actions": [
          "read"
        ],
        "legacyEndpoint": "/api/business/web-resource-access/knowledge/legacy-library"
      }
    },
    route
  };
}
