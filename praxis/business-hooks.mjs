const error = (status, code) => Object.assign(new Error(code), { status, code });
export function createBusinessHooks() {
  return {
    assertionFields: ['sourceReadGranted'], assertionRules: { sourceReadGranted: { kind: 'source-read' } },
    sourceAuthorizations: request => request.operation === 'capture_project' ? [{ appId: 'projects', spaceId: request.input.sourceSpaceId, resourceId: request.input.projectId, action: 'read', operation: 'read_project' }] : [],
    async prepareInvocation(request, ctx) {
      if (request.operation !== 'capture_project') return {};
      const source = await ctx.authorizedRead({ appId: 'projects', spaceId: request.input.sourceSpaceId, resourceId: request.input.projectId, operation: 'read_project' });
      if (!source.project || source.project.id !== request.input.projectId || source.revision !== request.input.projectRevision || source.project.revision !== source.revision) throw error(409, 'SOURCE_REVISION_CONFLICT');
      return { request: { ...request, input: { ...request.input, snapshot: source.project } }, assertion: { sourceReadGranted: ctx.sourceReadGranted } };
    },
  };
}
