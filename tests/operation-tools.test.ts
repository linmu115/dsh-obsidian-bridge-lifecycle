import { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import { expect, it, vi } from 'vitest';
import { registerOperationTools } from '../src/operation-tools.ts';
import type { ObsidianBridgeLifecycle } from '../src/api.ts';
import type { ObsidianOperations } from '../src/operation-service.ts';
import { obsidianOperationSkill } from '../src/operation-skill.ts';

it('exports the same policy-registered definitions to a late managed provider and withdraws them on unload', async () => {
  const ctx = new Context(); const definitions: ToolDefinition[] = [];
  const provider = ctx.plugin({ apply(scope) { scope.provide('tools', { register: (tool: ToolDefinition) => { definitions.push(tool); } }); } });
  await provider.await();
  const operations = { execute: vi.fn(async () => ({ state: 'completed' })) } as unknown as ObsidianOperations;
  const lifecycle = { refreshVaults: vi.fn(async () => undefined), listVaults: () => [{ vaultId: 'v', state: 'bound', displayName: 'Notes', binding: { revision: 2 } }, { vaultId: 'foreign', state: 'foreign', binding: { revision: 1 } }] } as unknown as ObsidianBridgeLifecycle;
  const owner = ctx.plugin({ inject: ['tools'], apply(scope) { registerOperationTools(scope, lifecycle, operations); } });
  await owner.await();
  expect(definitions.map(t => t.name)).toEqual(['dsh_obsidian_guide', 'dsh_obsidian_targets', 'dsh_obsidian_cli']);
  const revoke = vi.fn(); const exportTool = vi.fn((_tool: ToolDefinition) => revoke);
  const managed = ctx.plugin({ apply(scope) { scope.provide('dshRuntimeSupport', { managedTools: { exportTool } }); } });
  try {
    await managed.await(); await vi.waitFor(() => expect(exportTool).toHaveBeenCalledTimes(3));
    expect(exportTool.mock.calls.map(call => call[0])).toEqual(definitions);
    expect(obsidianOperationSkill.content).toContain('official Obsidian CLI');
    expect(obsidianOperationSkill.metadata?.['dsh-executor-portability']).toBe('self-contained');
    await owner.dispose(); await vi.waitFor(() => expect(revoke).toHaveBeenCalledTimes(3));
  } finally { await owner.dispose(); await managed.dispose(); await provider.dispose(); }
});
