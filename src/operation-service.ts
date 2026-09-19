import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { CliError, cliArgs, runCli, sameTarget, validateCliPaths, validateCliRequest, type CliParameters, type CliRunner, type CliTarget } from './obsidian-cli.ts';

const receiptSchema = z.object({ digest: z.string(), state: z.enum(['started', 'completed', 'unconfirmed']), vaultId: z.string(), command: z.string(), bindingRevision: z.number(), at: z.number() }).strict();
export type OperationReceipt = z.infer<typeof receiptSchema>;
export const operationDomainSpec = { name: 'dsh_obsidian_cli_receipts_v1', version: 1, tables: {}, global: { schema: z.object({ receipts: z.record(z.string(), receiptSchema) }).strict(), initial: { receipts: {} } } };
export interface OperationDomain {
  global: { get(): { receipts: Record<string, OperationReceipt> }; set(value: { receipts: Record<string, OperationReceipt> }): Promise<void> };
  close(): Promise<void>;
}
export interface OperationStorage { open(spec: typeof operationDomainSpec): Promise<OperationDomain> }
export interface OperationRequest { vaultId: string; command: string; parameters: CliParameters; requestId?: string }
export interface OperationOptions {
  resolveTarget(vaultId: string, signal: AbortSignal): Promise<CliTarget>;
  executable(): Promise<string>;
  storage: OperationStorage;
  runner?: CliRunner;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Serial dispatch prevents read/modify and receipt races inside this Bridge owner. */
export class ObsidianOperations {
  private readonly ready: Promise<OperationDomain>;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stop = new AbortController();
  constructor(private options: OperationOptions) {
    this.ready = options.storage.open(operationDomainSpec);
    // Readiness failures are reported by execute, with no unhandled rejection.
    void this.ready.catch(() => undefined);
  }
  execute(input: OperationRequest, owner: string, signal: AbortSignal): Promise<unknown> {
    const work = this.queue.then(() => this.perform(input, owner, AbortSignal.any([signal, this.stop.signal])));
    this.queue = work.catch(() => undefined); return work;
  }
  private async perform(input: OperationRequest, owner: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const operation = validateCliRequest(input.command, input.parameters);
    if (!owner || !input.vaultId || (operation.write && !/^[a-zA-Z0-9_.:-]{1,160}$/.test(input.requestId ?? ''))) throw new CliError('REQUEST_ID_REQUIRED', 'A session owner, Vault ID and stable requestId are required for writes');
    const domain = await this.ready;
    const parameters = Object.fromEntries(Object.entries(input.parameters).sort(([a], [b]) => a.localeCompare(b)));
    const digest = hash({ vaultId: input.vaultId, command: input.command, parameters });
    const key = hash({ owner, requestId: input.requestId });
    if (operation.write) {
      const previous = domain.global.get().receipts[key];
      if (previous) {
        if (previous.digest !== digest) throw new CliError('REQUEST_ID_CONFLICT', 'requestId was already used for a different operation');
        return { replayed: true, receipt: previous, outputRetained: false, message: previous.state === 'completed' ? 'Previously completed; not executed again' : 'Outcome unconfirmed; verify before any new attempt' };
      }
      if (Object.keys(domain.global.get().receipts).length >= 10_000) throw new CliError('RECEIPT_STORE_FULL', 'Receipt retention limit reached; explicit maintenance is required');
    }
    const executable = await this.options.executable();
    const target = await this.options.resolveTarget(input.vaultId, signal);
    await validateCliPaths(target, operation, parameters);
    const args = cliArgs(target, input.command, parameters);
    const run = this.options.runner ?? runCli;
    // A CLI can report disabled/unsupported without a useful exit code. Require an
    // independently resolved native target before sending the operation.
    const returnedPath = (await run(executable, [`vault=${target.nativeVaultId}`, 'vault', 'info=path'], target.root, signal)).trim();
    if (!returnedPath || await realpath(returnedPath).catch(() => undefined) !== target.root) throw new CliError('CLI_TARGET_MISMATCH', 'CLI did not resolve the bound Vault path');
    if (!sameTarget(target, await this.options.resolveTarget(input.vaultId, signal))) throw new CliError('BINDING_CHANGED', 'Binding or Vault process changed before CLI dispatch');
    signal.throwIfAborted();
    const receipt: OperationReceipt = { digest, state: 'started', vaultId: target.vaultId, command: input.command, bindingRevision: target.bindingRevision, at: Date.now() };
    const save = async (state: OperationReceipt['state']) => {
      receipt.state = state;
      await domain.global.set({ receipts: { ...domain.global.get().receipts, [key]: { ...receipt } } });
    };
    if (operation.write) await save('started');
    try {
      signal.throwIfAborted();
      const output = await run(executable, args, target.root, signal);
      signal.throwIfAborted();
      if (input.command === 'plugin:reload' && parameters.id === 'obsidian-deepharness-bridge') {
        // Reloading the executor itself deliberately changes its boot and endpoint.
        // Wait only for identity reads, never resend the reload command.
        const deadline = Date.now() + 15_000;
        let reloaded: CliTarget | undefined;
        do {
          reloaded = await this.options.resolveTarget(input.vaultId, signal).catch(() => undefined);
          if (reloaded && reloaded.bootId !== target.bootId) break;
          reloaded = undefined;
          await delay(250, undefined, { signal });
        } while (Date.now() < deadline);
        if (!reloaded || reloaded.root !== target.root || reloaded.nativeVaultId !== target.nativeVaultId || reloaded.vaultId !== target.vaultId || reloaded.bindingRevision !== target.bindingRevision)
          throw new CliError('POST_DISPATCH_TARGET_CHANGED', 'Bridge reload returned but its original bound Vault was not reconfirmed');
      } else if (!sameTarget(target, await this.options.resolveTarget(input.vaultId, signal))) {
        throw new CliError('POST_DISPATCH_TARGET_CHANGED', 'CLI returned but the Vault identity changed; reconcile the result before retrying');
      }
      if (operation.write) await save('completed');
      return { vaultId: target.vaultId, bindingRevision: target.bindingRevision, command: input.command, state: 'completed', output, ...(operation.write ? { receipt, replayed: false } : {}) };
    } catch (error) {
      if (operation.write) await save('unconfirmed').catch(() => undefined);
      throw error;
    }
  }
  async dispose() { this.stop.abort(); await this.queue; const domain = await this.ready.catch(() => undefined); await domain?.close(); }
}
