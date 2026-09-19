import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cliArgs, createCliTargetResolver, resolveCliExecutable, validateCliPaths, validateCliRequest, type CliTarget } from '../src/obsidian-cli.ts';
import { ObsidianOperations, type OperationDomain, type OperationReceipt } from '../src/operation-service.ts';
import type { ObsidianBridgeLifecycle } from '../src/api.ts';
import type { DshInstanceIdentity, VaultIdentity } from 'dsh-obsidian-bridge-protocol/binding';

let root: string;
const signal = () => new AbortController().signal;
beforeEach(async () => { root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-cli-test-'))); });
afterEach(async () => { if (dirname(root) === await realpath(tmpdir()) && root.startsWith(join(await realpath(tmpdir()), 'dsh-cli-test-'))) await rm(root, { recursive: true, force: true }); });
const target = (): CliTarget => ({ root, vaultId: 'bridge-vault', nativeVaultId: 'native-id', bindingRevision: 3, bootId: 'boot', publisherId: 'publisher', origin: 'http://127.0.0.1:23456' });
function fixture() {
  let receipts: Record<string, OperationReceipt> = {};
  const domain: OperationDomain = { global: { get: () => ({ receipts }), set: async value => { receipts = structuredClone(value.receipts); } }, close: vi.fn(async () => undefined) };
  const runner = vi.fn(async (_exe: string, args: readonly string[]) => args[1] === 'vault' ? root : 'ok');
  const resolveTarget = vi.fn(async () => target());
  const options = { resolveTarget, executable: async () => 'fake-native-cli', storage: { open: async () => domain }, runner };
  return { options, runner, resolveTarget, domain, service: new ObsidianOperations(options) };
}
it('pins the native Vault first and treats shell syntax, quotes and newlines as argument data', () => {
  const content = 'quote " hi\n$(do-not-execute); `escape` & whoami';
  expect(cliArgs(target(), 'create', { path: 'Notes/hello world.md', content })).toEqual(['vault=native-id', 'create', `content=${content}`, 'path=Notes/hello world.md']);
});
it.each([
  ['read', { path: '../outside.md' }], ['create', { path: 'C:/outside.md' }], ['read', { path: '.obsidian/plugins/a/main.js' }],
  ['append', { path: 'note.md', content: 'a', vault: 'other' }], ['read', { file: 'ambiguous' }],
  ['plugin:install', { id: 'plugin' }], ['plugin:disable', { id: 'plugin' }], ['eval', { code: 'unsafe' }], ['constructor', {}],
  ['plugin:reload', { id: '../plugin' }], ['append', { path: 'x.md', content: 'x', inline: 'true' }],
])('rejects routing/scope escapes: %s %j', (command, args) => { expect(() => validateCliRequest(command, args)).toThrow(); });
it('rejects paths traversing a junction outside the Vault, even for new notes', async () => {
  const outside = await mkdtemp(join(tmpdir(), 'dsh-cli-test-outside-'));
  try {
    await symlink(outside, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
    const args = { path: 'external/new/sub/note.md', content: 'x' };
    await expect(validateCliPaths(target(), validateCliRequest('create', args), args)).rejects.toMatchObject({ code: 'PATH_ESCAPE' });
  } finally { if (dirname(resolve(outside)) === resolve(tmpdir()) && outside.startsWith(join(tmpdir(), 'dsh-cli-test-outside-'))) await rm(outside, { recursive: true, force: true }); }
});
it('does not dispatch after a CLI target-path mismatch', async () => {
  const f = fixture(); f.runner.mockResolvedValue('another/vault');
  await expect(f.service.execute({ vaultId: 'bridge-vault', command: 'append', parameters: { path: 'x.md', content: 'hi' }, requestId: 'one' }, 'session', signal())).rejects.toMatchObject({ code: 'CLI_TARGET_MISMATCH' });
  expect(f.runner).toHaveBeenCalledTimes(1); expect(f.domain.global.get().receipts).toEqual({}); await f.service.dispose();
});
it('rejects a binding change immediately before dispatch without writing', async () => {
  const f = fixture(); f.resolveTarget.mockResolvedValueOnce(target()).mockResolvedValue({ ...target(), bindingRevision: 4 });
  await expect(f.service.execute({ vaultId: 'bridge-vault', command: 'plugin:reload', parameters: { id: 'fixture' }, requestId: 'one' }, 'session', signal())).rejects.toMatchObject({ code: 'BINDING_CHANGED' });
  expect(f.runner).toHaveBeenCalledTimes(1); await f.service.dispose();
});
it('persists write receipts, deduplicates concurrent retries and survives service recreation without retaining note content', async () => {
  const f = fixture(); const request = { vaultId: 'bridge-vault', command: 'append', parameters: { path: 'x.md', content: 'private note body' }, requestId: 'one' };
  const results = await Promise.all([f.service.execute(request, 'session', signal()), f.service.execute(request, 'session', signal())]);
  expect(f.runner.mock.calls.filter(call => call[1][1] === 'append')).toHaveLength(1);
  expect(results[1]).toMatchObject({ replayed: true, receipt: { state: 'completed' } });
  expect(JSON.stringify(f.domain.global.get())).not.toContain('private note body');
  await f.service.dispose(); const restarted = new ObsidianOperations(f.options);
  expect(await restarted.execute(request, 'session', signal())).toMatchObject({ replayed: true });
  await expect(restarted.execute({ ...request, parameters: { path: 'x.md', content: 'changed' } }, 'session', signal())).rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT' });
  await restarted.dispose();
});
it('never replays a write after an uncertain subprocess result', async () => {
  const f = fixture(); f.runner.mockImplementation(async (_exe, args) => { if (args[1] === 'vault') return root; throw new Error('timeout'); });
  const request = { vaultId: 'bridge-vault', command: 'plugin:reload', parameters: { id: 'fixture' }, requestId: 'reload-one' };
  await expect(f.service.execute(request, 'session', signal())).rejects.toThrow('timeout');
  expect(await f.service.execute(request, 'session', signal())).toMatchObject({ replayed: true, receipt: { state: 'unconfirmed' } });
  expect(f.runner).toHaveBeenCalledTimes(2); await f.service.dispose();
});
it('does not invoke the CLI when unavailable or already cancelled', async () => {
  const f = fixture(); const service = new ObsidianOperations({ ...f.options, executable: () => resolveCliExecutable(join(root, 'missing.com')) });
  await expect(service.execute({ vaultId: 'bridge-vault', command: 'read', parameters: { path: 'x.md' } }, 'session', signal())).rejects.toMatchObject({ code: 'CLI_UNAVAILABLE' });
  const abort = new AbortController(); abort.abort();
  await expect(f.service.execute({ vaultId: 'bridge-vault', command: 'read', parameters: { path: 'x.md' } }, 'session', abort.signal)).rejects.toThrow();
  expect(f.runner).not.toHaveBeenCalled(); await service.dispose(); await f.service.dispose();
});
it('accepts a Bridge self-reload boot change only after reconfirming the same native Vault and binding', async () => {
  const f = fixture(); f.resolveTarget.mockResolvedValueOnce(target()).mockResolvedValueOnce(target()).mockResolvedValue({ ...target(), bootId: 'new-boot', origin: 'http://127.0.0.1:24444' });
  expect(await f.service.execute({ vaultId: 'bridge-vault', command: 'plugin:reload', parameters: { id: 'obsidian-deepharness-bridge' }, requestId: 'self-reload' }, 'session', signal())).toMatchObject({ state: 'completed' });
  expect(f.runner.mock.calls.filter(call => call[1][1] === 'plugin:reload')).toHaveLength(1); await f.service.dispose();
});
it('does not confirm self-reload if the binding changed', async () => {
  const f = fixture(); f.resolveTarget.mockResolvedValueOnce(target()).mockResolvedValueOnce(target()).mockResolvedValue({ ...target(), bootId: 'new-boot', bindingRevision: 4 });
  await expect(f.service.execute({ vaultId: 'bridge-vault', command: 'plugin:reload', parameters: { id: 'obsidian-deepharness-bridge' }, requestId: 'self-reload' }, 'session', signal())).rejects.toMatchObject({ code: 'POST_DISPATCH_TARGET_CHANGED' });
  expect(Object.values(f.domain.global.get().receipts)[0]?.state).toBe('unconfirmed'); await f.service.dispose();
});
it('maps live Bridge identity to native ID by canonical path, never by name or copied ID', async () => {
  const registryPath = join(root, 'registry.json');
  const own = { instanceId: 'dsh', profileId: 'web' } as DshInstanceIdentity;
  const identity = { vaultId: 'bridge-vault', origin: 'http://127.0.0.1:23456', bootId: '11111111-1111-4111-8111-111111111111', publisherId: '22222222-2222-4222-8222-222222222222', binding: { revision: 3, target: { instanceId: 'dsh', profileId: 'web' } } } as VaultIdentity;
  const lifecycle = { refreshVaults: async () => undefined, getInstanceIdentity: () => own, forVault: () => ({}), listVaults: () => [{ ...identity, state: 'bound' }] } as unknown as ObsidianBridgeLifecycle;
  await writeFile(registryPath, JSON.stringify({ vaults: { 'native-id': { path: root }, 'wrong-copy': { path: join(root, 'copy') } } }));
  await mkdir(join(root, 'copy'));
  const proof = { locationProtocolVersion: 1, vaultId: identity.vaultId, publisherId: identity.publisherId, bootId: identity.bootId, origin: identity.origin, vaultRoot: root };
  const request = vi.fn(async () => new Response(JSON.stringify(proof)));
  const resolver = createCliTargetResolver({ lifecycle, probe: async () => identity, registryPath, fetch: request as unknown as typeof fetch });
  expect(await resolver('bridge-vault', signal())).toMatchObject({ nativeVaultId: 'native-id', root });
  proof.bootId = '33333333-3333-4333-8333-333333333333';
  await expect(resolver('bridge-vault', signal())).rejects.toMatchObject({ code: 'LOCATION_MISMATCH' });
  proof.bootId = identity.bootId;
  await writeFile(registryPath, JSON.stringify({ vaults: { a: { path: root }, b: { path: root } } }));
  await expect(resolver('bridge-vault', signal())).rejects.toMatchObject({ code: 'NATIVE_VAULT_AMBIGUOUS' });
  identity.binding.target = { instanceId: 'foreign', profileId: 'web' };
  await expect(resolver('bridge-vault', signal())).rejects.toMatchObject({ code: 'BINDING_CHANGED' });
});
