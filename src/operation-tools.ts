import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ObsidianBridgeLifecycle } from './api.ts';
import { CLI_COMMANDS, type CliParameters } from './obsidian-cli.ts';
import { type ObsidianOperations } from './operation-service.ts';
import { obsidianOperationSkill } from './operation-skill.ts';

export function registerOperationTools(ctx: Context, lifecycle: ObsidianBridgeLifecycle, operations: ObsidianOperations) {
  const output = { schema: { type: 'string' as const }, render: (_args: unknown, text: string) => [{ type: 'text' as const, text }] };
  const tools: ToolDefinition[] = [
    defineTool({ name: 'dsh_obsidian_guide', description: 'Read the Bridge-bundled bound-Vault operation skill. Use before Obsidian operations; official CLI is mandatory.', parameters: {}, output, execute: async () => obsidianOperationSkill.content }),
    defineTool({ name: 'dsh_obsidian_targets', description: 'List Vaults bound to this DSH instance/profile. Does not change bindings or inspect per-Vault operation capabilities.', parameters: {}, output,
      execute: async () => { await lifecycle.refreshVaults?.(); return JSON.stringify({ vaults: lifecycle.listVaults?.().filter(v => v.state === 'bound').map(v => ({ vaultId: v.vaultId, displayName: v.displayName, bindingRevision: v.binding.revision })) ?? [] }); } }),
    defineTool({ name: 'dsh_obsidian_cli', description: 'Run the official CLI against an explicitly bound Vault. Read dsh_obsidian_guide first. Writes require requestId; reusing it returns a receipt, never repeats the operation. Plugin management is limited to inspection/reload.',
      parameters: { vaultId: { type: 'string', required: true }, command: { type: 'string', enum: Object.keys(CLI_COMMANDS), required: true }, parameters: { type: 'json', required: true }, requestId: { type: 'string' } }, output,
      execute: async (args, exec) => {
        if (!exec.agent) throw new Error('A DSH conversation is required');
        return JSON.stringify(await operations.execute({ vaultId: args.vaultId, command: args.command, parameters: args.parameters as CliParameters, ...(args.requestId ? { requestId: args.requestId } : {}) }, exec.agent.session.id, exec.signal));
      } }),
  ];
  for (const tool of tools) ctx.tools.register(tool);
  // Optional managed-executor export; regular DSH tool policy remains in force.
  ctx.inject(['dshRuntimeSupport' as never], scope => {
    const support = scope.get('dshRuntimeSupport' as never) as unknown as { managedTools?: { exportTool(tool: ToolDefinition): () => void } };
    if (!support.managedTools?.exportTool) return;
    for (const tool of tools) scope.effect(() => support.managedTools!.exportTool(tool), 'obsidian bridge: managed CLI tool');
  });
}
