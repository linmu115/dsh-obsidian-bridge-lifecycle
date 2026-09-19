import { registerBridgeBusinessPage, type BusinessPageService } from './business-page.ts';
import { createVaultFolderBinding } from './vault-folder.ts';
import { createCliTargetResolver, resolveCliExecutable } from './obsidian-cli.ts';
import { ObsidianOperations, type OperationStorage } from './operation-service.ts';
import { obsidianOperationSkill } from './operation-skill.ts';
import type { IncomingMessage, ServerResponse } from "node:http";
import { DSH_IDENTITY_PATH, type DshInstanceIdentity, type ChangeVaultBindingRequest } from "dsh-obsidian-bridge-protocol/binding";
import { VaultBridgeRuntime } from "./vault-runtime.ts";
import { resolveInstanceIdentity, type IdentityStorage } from "./host-identity.ts";
import { startHostDiscovery } from "./discovery-host.ts";
import { apply as mountReferences } from "./reference/host.ts";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { type Context } from "@deepseek-ai/cordis";
import s from "@deepseek-ai/schemastery";

import type { ObsidianBridgeLifecycle, BridgeRuntimeIdentity } from "./api.ts";
import { BridgeLifecycleRuntime } from "./runtime.ts";

export * from "./api.ts";
export { BridgeLifecycleRuntime } from "./runtime.ts";

export const name = "dsh-obsidian-bridge";
export const inject = ["webServer", "connection", "storageDomain"] as const;

interface WebServerBinding {
  readonly host: "127.0.0.1" | "0.0.0.0";
  readonly port: number;
  register(route:{kind:"exact";path:string;handler:(request:IncomingMessage,response:ServerResponse)=>void}):()=>void;
}

interface ConnectionBinding {
  authenticatedUrl(baseUrl: string): string;
}

export function browserOriginFromWebServer(server: Pick<WebServerBinding,"host"|"port">): string {
  if (!Number.isInteger(server.port) || server.port < 1 || server.port > 65_535) {
    throw new Error("DSH Web server has not published its listening port");
  }
  const browserHost = server.host === "0.0.0.0" ? "127.0.0.1" : server.host;
  return `http://${browserHost}:${server.port}`;
}

export async function waitForBrowserOrigin(
  server: Pick<WebServerBinding,"host"|"port">,
  timeoutMs = 10_000,
  now: () => number = Date.now,
  wait: (delayMs: number) => Promise<void> = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  signal?: AbortSignal,
): Promise<string> {
  const deadline = now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    try {
      return browserOriginFromWebServer(server);
    } catch (error) {
      if (now() >= deadline) throw error;
      await wait(25);
    }
  }
}

export interface Config { bridgeOrigin: string; dshInstanceId?: string; profileId?: string; displayName?:string; discoveryDirectory?:string; obsidianCliPath?: string; obsidianRegistryPath?: string; }
export const Config = s.object({
  obsidianCliPath: s.string().default(''),
  obsidianRegistryPath: s.string().default(''),
  displayName: s.string().default(""),
  discoveryDirectory: s.string().default(""),
  dshInstanceId: s.string().default(""),
  profileId: s.string().default("web"),
  bridgeOrigin: s.string().default("http://127.0.0.1:18473"),
});

export class BridgeLifecycleService extends TypertRemoteService implements ObsidianBridgeLifecycle {
  private readonly runtime: VaultBridgeRuntime;
  private readonly discovery: ReturnType<typeof startHostDiscovery>;
  readonly runtimeIdentity: BridgeRuntimeIdentity;

  constructor(ctx: Context, config: Config, readonly identity: DshInstanceIdentity) {
    super(ctx, "obsidianBridgeLifecycle");
    this.runtimeIdentity = Object.freeze({profileId:identity.profileId,dshInstanceId:identity.instanceId});
    const server = (ctx as Context & {webServer:WebServerBinding}).webServer;
    const dshViewerUrl = (ctx as Context & { connection: ConnectionBinding }).connection.authenticatedUrl(identity.origin);
    this.runtime = new VaultBridgeRuntime({identity,role:"controller",fallbackOrigin:config.bridgeOrigin,dshViewerUrl});
    ctx.effect(()=>server.register({kind:"exact",path:DSH_IDENTITY_PATH,handler:(request,response)=>{
      if(!["127.0.0.1","::1","::ffff:127.0.0.1"].includes(request.socket.remoteAddress??"")){response.statusCode=403;response.end();return;}
      if(request.method!=="GET"){response.statusCode=405;response.end();return;}
      response.setHeader("content-type","application/json");response.setHeader("cache-control","no-store");response.end(JSON.stringify(identity));
    }}),"obsidian bridge: public identity");
    this.discovery = startHostDiscovery(identity,this.runtime,{...(config.discoveryDirectory?{directory:config.discoveryDirectory}:{}),manualOrigin:config.bridgeOrigin,onError:error=>console.warn("[obsidian bridge] discovery unavailable",error)});
    ctx.inject(["maintenanceInstanceIdentity"],injected=>{
      const maintenance=injected.get("maintenanceInstanceIdentity") as {instanceId:string;profileId:string};
      if(maintenance.instanceId!==identity.instanceId||maintenance.profileId!==identity.profileId)this.runtime.blockIdentity("Bridge and Maintenance instance identities conflict");
    });
    ctx.inject(["maintenanceInstanceIdentity","maintenanceKnowledge"],injected=>{
      const maintenance=injected.get("maintenanceInstanceIdentity") as {instanceId:string;profileId:string};
      if(maintenance.instanceId!==identity.instanceId||maintenance.profileId!==identity.profileId)return;
      identity.capabilities=[...new Set([...identity.capabilities,"maintenance-knowledge-v1"])];
      void this.discovery.refresh();
      injected.effect(()=>()=>{identity.capabilities=identity.capabilities.filter(value=>value!=="maintenance-knowledge-v1");void this.discovery.refresh();},"obsidian bridge: optional maintenance knowledge");
    });
    ctx.inject(["maintenanceBusinessPages"], injected => {
      const pages = injected.get("maintenanceBusinessPages") as BusinessPageService;
      if(pages.identity.instanceId!==identity.instanceId||pages.identity.profileId!==identity.profileId)return;
      const bindSelectedFolder=createVaultFolderBinding({lifecycle:this,identity,probe:origin=>this.runtime.probe(origin),bind:async(vaultId,request,expected,signal)=>{
        const result=await this.runtime.changeVaultBinding(vaultId,request,{identity:expected,signal});
        await this.discovery.refresh();return result;
      }});
      injected.effect(()=>registerBridgeBusinessPage(pages,this,identity,{bindSelectedFolder}),"obsidian bridge: maintenance business page");
    });
    ctx.inject(["annotationCoreHost"], injected => mountReferences(injected as Parameters<typeof mountReferences>[0], { profileId: this.runtimeIdentity.profileId }));
    ctx.inject(['skills'], scope => { scope.skills.register(obsidianOperationSkill); });
    ctx.inject(['tools'], async scope => {
      let active = true;
      scope.effect(() => () => { active = false; }, 'obsidian bridge: CLI registration lifetime');
      const { registerOperationTools } = await import('./operation-tools.ts');
      if (!active) return;
      const operations = new ObsidianOperations({
        resolveTarget: createCliTargetResolver({ lifecycle: this, probe: origin => this.runtime.probe(origin), ...(config.obsidianRegistryPath ? { registryPath: config.obsidianRegistryPath } : {}) }),
        executable: () => resolveCliExecutable(config.obsidianCliPath),
        storage: scope.get('storageDomain') as unknown as OperationStorage,
      });
      scope.effect(() => () => operations.dispose(), 'obsidian bridge: CLI operations');
      registerOperationTools(scope, this, operations);
    });
    ctx.effect(() => async () => {try{await this.discovery.dispose();}finally{await this.runtime.dispose();}}, "dsh-obsidian-bridge: host");
  }

  getInstanceIdentity=()=>this.identity;
  getBridgeConfig() { return {origin:this.runtime.bridgeOrigin,runtimeIdentity:this.runtimeIdentity,identity:this.identity,vaults:this.runtime.identities()}; }
  forVault=(vaultId:string)=>this.runtime.forVault(vaultId);
  listVaults=()=>this.runtime.listVaults();
  refreshVaults=()=>this.discovery.refresh();
  changeVaultBinding=async(vaultId:string,input:ChangeVaultBindingRequest)=>{const result=await this.runtime.changeVaultBinding(vaultId,input);await this.discovery.refresh();return result;};
  get capabilities() { return this.runtime.capabilities; }
  get transport() { return this.runtime.transport; }
  registerActionHandler: NonNullable<ObsidianBridgeLifecycle["registerActionHandler"]> = (name, handler) => this.runtime.registerActionHandler(name, handler);
  retryActions = () => this.runtime.retryActions();
  getHealth = () => this.runtime.getHealth();
  registerHealthSource: NonNullable<ObsidianBridgeLifecycle["registerHealthSource"]> = (name, source) => this.runtime.registerHealthSource(name, source);
  retry = (name?: string) => this.runtime.retry(name);
  get bridgeOrigin(): string { return this.runtime.bridgeOrigin; }
  getSnapshot = () => this.runtime.getSnapshot();
  subscribe = (listener: () => void) => this.runtime.subscribe(listener);
  mountWhenReady: ObsidianBridgeLifecycle["mountWhenReady"] = (name, mount) => this.runtime.mountWhenReady(name, mount);
  drain = (reason: string, deadlineMs?: number) => this.runtime.drain(reason, deadlineMs);
  resume = () => this.runtime.resume();
}

export function apply(ctx: Context, config: Config): void {
  ctx.inject(inject, async (injected) => {
    const abort = new AbortController();
    injected.effect(() => () => abort.abort(), "dsh-obsidian-bridge: host startup");
    const server = (injected as Context & { webServer: WebServerBinding }).webServer;
    await waitForBrowserOrigin(server, 10_000, Date.now, undefined, abort.signal);
    abort.signal.throwIfAborted();
    const identity = await resolveInstanceIdentity({configuredId:config.dshInstanceId||"",profileId:config.profileId||"web",origin:browserOriginFromWebServer(server),
      storage:injected.get("storageDomain") as IdentityStorage,
      ...(injected.get("maintenanceInstanceIdentity")?{maintenance:injected.get("maintenanceInstanceIdentity") as {instanceId:string;profileId:string}}:{}),
      displayName:config.displayName||process.env.DSH_LAUNCHER_INSTANCE||"DSH"});
    if(abort.signal.aborted){await identity.dispose();abort.signal.throwIfAborted();}
    injected.effect(()=>identity.dispose,"obsidian bridge: identity domain");
    new BridgeLifecycleService(injected, config, identity.identity);
  });
}
