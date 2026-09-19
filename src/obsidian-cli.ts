import { execFile } from 'node:child_process';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, win32 } from 'node:path';
import { z } from 'zod';
import { normalizeBridgeOrigin } from './control-client.ts';
import { vaultLocationSchema } from './vault-folder.ts';
import type { VaultIdentity } from 'dsh-obsidian-bridge-protocol/binding';
import type { ObsidianBridgeLifecycle } from './api.ts';

export class CliError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); }
}
const fail = (code: string, message: string): never => { throw new CliError(code, message); };
export async function readBoundedJson(path: string): Promise<unknown> {
  const file = await open(path, 'r');
  try {
    const bytes = Buffer.alloc(1_048_577);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1_048_576) fail('REGISTRY_TOO_LARGE', 'Obsidian registry exceeds the read limit');
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await file.close(); }
}
export function defaultObsidianRegistry(): string {
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'obsidian', 'obsidian.json');
}
export interface CliTarget {
  vaultId: string; nativeVaultId: string; root: string; bindingRevision: number;
  bootId: string; publisherId: string; origin: string;
}
export interface TargetOptions {
  lifecycle: ObsidianBridgeLifecycle;
  probe(origin: string): Promise<VaultIdentity>;
  registryPath?: string;
  fetch?: typeof fetch;
}
/** Read-only identity mapping: a copied Bridge ID cannot select a different native Vault. */
export function createCliTargetResolver(options: TargetOptions) {
  return async (vaultId: string, signal: AbortSignal): Promise<CliTarget> => {
    signal.throwIfAborted();
    await options.lifecycle.refreshVaults?.();
    const own = options.lifecycle.getInstanceIdentity?.();
    const matches = options.lifecycle.listVaults?.().filter(v => v.vaultId === vaultId) ?? [];
    const candidate = matches[0];
    if (!own || matches.length !== 1 || candidate?.state !== 'bound') fail('VAULT_NOT_BOUND', 'Select an online Vault bound to this DSH instance/profile');
    // The runtime also rejects a blocked DSH identity or a disposed route.
    options.lifecycle.forVault?.(vaultId);
    const fresh = await options.probe(candidate!.origin);
    if (fresh.vaultId !== vaultId || fresh.binding.target?.instanceId !== own!.instanceId || fresh.binding.target.profileId !== own!.profileId || fresh.binding.revision !== candidate!.binding.revision)
      fail('BINDING_CHANGED', 'Vault binding changed; refresh the target');
    const origin = normalizeBridgeOrigin(fresh.origin);
    const response = await (options.fetch ?? fetch)(`${origin}/discovery/v1/vault-location`, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]) });
    if (!response.ok || Number(response.headers.get('content-length')) > 65_536) fail('LOCATION_UNAVAILABLE', 'Vault live location proof is unavailable');
    const reader = response.body?.getReader();
    if (!reader) fail('LOCATION_UNAVAILABLE', 'Vault live location proof is empty');
    let size = 0; const chunks: Uint8Array[] = [];
    try { for (;;) { const part = await reader!.read(); if (part.done) break; size += part.value.length; if (size > 65_536) fail('LOCATION_TOO_LARGE', 'Vault location proof exceeds limit'); chunks.push(part.value); } }
    finally { await reader!.cancel().catch(() => undefined); }
    const proof = vaultLocationSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    if (proof.vaultId !== vaultId || proof.bootId !== fresh.bootId || proof.publisherId !== fresh.publisherId || proof.origin !== origin || !isAbsolute(proof.vaultRoot))
      fail('LOCATION_MISMATCH', 'Vault location proof does not match the live identity');
    const root = await realpath(proof.vaultRoot);
    const registry = z.object({ vaults: z.record(z.string(), z.object({ path: z.string() })) }).parse(await readBoundedJson(options.registryPath ?? defaultObsidianRegistry()));
    const nativeIds: string[] = [];
    for (const [id, value] of Object.entries(registry.vaults)) {
      if (isAbsolute(value.path) && await realpath(value.path).catch(() => undefined) === root) nativeIds.push(id);
    }
    if (nativeIds.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(nativeIds[0]!)) fail('NATIVE_VAULT_AMBIGUOUS', 'Bound Vault must map to exactly one native Obsidian Vault ID');
    signal.throwIfAborted();
    return { vaultId, nativeVaultId: nativeIds[0]!, root, bindingRevision: fresh.binding.revision, bootId: fresh.bootId, publisherId: fresh.publisherId, origin };
  };
}

export type CliRunner = (executable: string, args: readonly string[], root: string, signal: AbortSignal) => Promise<string>;
export const runCli: CliRunner = (executable, args, root, signal) => new Promise((resolve, reject) => {
  execFile(executable, [...args], { cwd: root, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 1_048_576, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) }, (error, stdout) => {
    // Do not put command text, note contents or process diagnostics in errors.
    if (error) reject(new CliError('CLI_EXECUTION_UNCONFIRMED', 'CLI did not complete successfully; verify the target before retrying a write'));
    else if (/^\s*(?:error:|unknown command|command line interface is not enabled)/im.test(stdout)) reject(new CliError('CLI_REPORTED_ERROR', 'Obsidian CLI reported an error; no success receipt was confirmed'));
    else resolve(stdout);
  });
});
export async function resolveCliExecutable(configured = ''): Promise<string> {
  if (configured) {
    if (!isAbsolute(configured) || /\.(?:cmd|bat|ps1)$/i.test(configured) || !(await stat(configured).catch(() => undefined))?.isFile())
      fail('CLI_UNAVAILABLE', 'Configure an absolute native Obsidian CLI executable (not a shell script)');
    return realpath(configured);
  }
  const names = process.platform === 'win32' ? ['Obsidian.com'] : ['obsidian'];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
    for (const name of names) { const path = join(dir, name); if ((await stat(path).catch(() => undefined))?.isFile()) return realpath(path); }
  }
  return fail('CLI_UNAVAILABLE', 'Official Obsidian CLI is unavailable; install a supported Obsidian installer, enable CLI, or configure obsidianCliPath');
}

type Spec = { write?: boolean; args: string[]; required?: string[]; flags?: string[]; paths?: string[] };
const spec = (args: string, required = '', write = false, flags = '', paths = ''): Spec => ({ args: args.split(' ').filter(Boolean), required: required.split(' ').filter(Boolean), write, flags: flags.split(' ').filter(Boolean), paths: paths.split(' ').filter(Boolean) });
/** Fixed grammar, not a per-Vault capability registry. Target selectors are never model arguments. */
export const CLI_COMMANDS: Readonly<Record<string, Spec>> = Object.freeze({
  vault: spec('info'), files: spec('folder ext', '', false, 'total', 'folder'), folders: spec('folder', '', false, 'total', 'folder'),
  read: spec('path', 'path', false, '', 'path'), file: spec('path', 'path', false, '', 'path'),
  search: spec('query path limit format', 'query', false, 'total case', 'path'), 'search:context': spec('query path limit format', 'query', false, 'case', 'path'),
  create: spec('path content template', 'path', true, 'overwrite open newtab', 'path'),
  append: spec('path content', 'path content', true, 'inline', 'path'), prepend: spec('path content', 'path content', true, 'inline', 'path'),
  move: spec('path to', 'path to', true, '', 'path to'), rename: spec('path name', 'path name', true, '', 'path name'), delete: spec('path', 'path', true, '', 'path'),
  open: spec('path', 'path', true, 'newtab', 'path'),
  'property:read': spec('path name', 'path name', false, '', 'path'),
  'property:set': spec('path name value type', 'path name value', true, '', 'path'), 'property:remove': spec('path name', 'path name', true, '', 'path'),
  templates: spec('', '', false, 'total'), 'template:read': spec('name title', 'name', false, 'resolve'),
  snippets: spec(''), 'snippets:enabled': spec(''), 'snippet:enable': spec('name', 'name', true), 'snippet:disable': spec('name', 'name', true),
  plugins: spec('filter format', '', false, 'versions'), plugin: spec('id', 'id'), 'plugin:reload': spec('id', 'id', true),
});
export type CliParameters = Record<string, string | number | boolean>;
export function validateCliRequest(command: string, parameters: CliParameters): Spec {
  const operation = Object.hasOwn(CLI_COMMANDS, command) ? CLI_COMMANDS[command]! : undefined;
  if (!operation) return fail('UNSUPPORTED_COMMAND', 'Unsupported bridge CLI command; plugin operations only support inspection and reload');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return fail('INVALID_PARAMETERS', 'Parameters must be an object');
  for (const key of Object.keys(parameters)) {
    const value = parameters[key];
    if (operation.flags!.includes(key)) { if (typeof value !== 'boolean') fail('INVALID_PARAMETERS', 'Flags must be booleans'); continue; }
    if (!operation.args.includes(key) || !['string', 'number'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || /\0/.test(String(value))) fail('INVALID_PARAMETERS', 'Unknown or invalid CLI parameter');
    if (String(value).length > 24_000) fail('INPUT_TOO_LARGE', 'CLI input exceeds this transport limit; split the operation into smaller edits');
  }
  for (const key of operation.required!) if (parameters[key] === undefined || (key !== 'content' && key !== 'value' && String(parameters[key]).length === 0)) fail('INVALID_PARAMETERS', `Required parameter: ${key}`);
  if (command === 'plugin:reload' && !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(String(parameters.id))) fail('INVALID_PARAMETERS', 'A plugin ID is required');
  for (const key of operation.paths!) if (parameters[key] !== undefined) {
    const path = String(parameters[key]);
    if (isAbsolute(path) || win32.isAbsolute(path) || path.includes('\\') || path.split('/').some(part => part === '..' || part.startsWith('.')) || /[\0:\r\n]/.test(path))
      fail('INVALID_PATH', 'Use a Vault-relative note path with no parent traversal or hidden configuration directory');
  }
  return operation;
}
/** Reject symlink escapes as well as lexical traversal, including new descendants. */
export async function validateCliPaths(target: CliTarget, operation: Spec, parameters: CliParameters): Promise<void> {
  for (const key of operation.paths!) {
    if (parameters[key] === undefined) continue;
    let path = join(target.root, String(parameters[key]));
    while (true) {
      const resolved = await realpath(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
      if (resolved !== undefined) {
        const suffix = relative(target.root, resolved);
        if (suffix === '..' || suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(suffix)) fail('PATH_ESCAPE', 'Path resolves outside the bound Vault');
        break;
      }
      const parent = join(path, '..'); if (parent === path) fail('INVALID_PATH', 'Unable to resolve note path'); path = parent;
    }
  }
}
export function cliArgs(target: CliTarget, command: string, parameters: CliParameters): string[] {
  const operation = validateCliRequest(command, parameters);
  const args = [`vault=${target.nativeVaultId}`, command];
  for (const key of Object.keys(parameters).sort()) {
    const value = parameters[key];
    if (operation.flags!.includes(key)) { if (value) args.push(key); }
    else args.push(`${key}=${String(value)}`);
  }
  if (args.join(' ').length > 28_000) fail('INPUT_TOO_LARGE', 'CLI command exceeds transport size; split the operation');
  return args;
}
export function sameTarget(a: CliTarget, b: CliTarget): boolean {
  return a.vaultId === b.vaultId && a.nativeVaultId === b.nativeVaultId && a.root === b.root && a.bindingRevision === b.bindingRevision && a.bootId === b.bootId && a.publisherId === b.publisherId && a.origin === b.origin;
}
