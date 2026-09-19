import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const retired = ["dsh-obsidian-bridge-lifecycle", "dsh-obsidian-bridge-protocol", "dsh-obsidian-reference-adapter", "dsh-obsidian-session-reference-suite"];
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

it("ships one Bridge node with standalone public runtime and type exports, without retired packages or Core/Sticker/SM", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "dsh-bridge-package-"));
  try {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(manifest.name).toBe("dsh-obsidian-bridge");
    expect(manifest.version).toBe("0.4.1-rc2.3");
    expect(manifest.peerDependenciesMeta["dsh-annotation-core"].optional).toBe(true);
    for (const name of retired) {
      expect(manifest.dependencies?.[name]).toBeUndefined();
      expect(manifest.peerDependencies?.[name]).toBeUndefined();
    }
    expect(manifest.files).toContain("dist");
    expect(manifest.files).not.toContain("lib");
    const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
    expect(patch.match(/^\s+name:/gm)).toHaveLength(1);
    expect(patch).toContain("name: dsh-obsidian-bridge");
    const installed = join(fixture, "node_modules", manifest.name);
    await mkdir(installed, { recursive: true });
    await cp(join(root, "dist"), join(installed, "dist"), { recursive: true });
    await writeFile(join(installed, "package.json"), JSON.stringify(manifest));
    await writeFile(join(installed, "cordis.patch.yml"), patch);
    // Link only named host dependencies, never the workspace node_modules directory.
    for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/schemastery", "@deepseek-ai/dsh-typert-protocol", "@deepseek-ai/dsh-typert-registry", "react", "zod", "@types/node"]) {
      const target = join(fixture, "node_modules", name);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(join(root, "node_modules", name)), target, "junction");
    }
    for (const file of await files(join(installed, "dist"))) {
      const text = await readFile(file, "utf8");
      for (const name of [...retired, "dsh-annotation-core", "dsh-session-sticker-board", "dsh-session-maintenance"])
        expect(text, file).not.toMatch(new RegExp(`(?:from\\s*|import\\s*\\(|require\\s*\\()?["']${name}(?:/[^"']*)?["']`));
    }
    await writeFile(join(fixture, "smoke.mjs"), `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
for (const name of ${JSON.stringify([...retired, "dsh-annotation-core", "dsh-session-sticker-board", "dsh-session-maintenance"])}) assert.throws(() => require.resolve(name));
const host = await import('dsh-obsidian-bridge');
assert.equal(host.name, 'dsh-obsidian-bridge');
for (const path of ['api', 'transport', 'typert', 'protocol', 'protocol/data', 'protocol/binding']) assert.ok(Object.keys(await import('dsh-obsidian-bridge/' + path)).length);
const data = await import('dsh-obsidian-bridge/protocol/data');
assert.ok(data.stickerSchema);
let loaded;
vm.runInNewContext(readFileSync(require.resolve('dsh-obsidian-bridge/client'), 'utf8'), {window:{__ModuleLoader__:{load(value){loaded=value;}}}, console, URL, AbortController, setTimeout, clearTimeout, setInterval, clearInterval});
assert.equal(loaded.id, 'dsh-obsidian-bridge');
assert.equal(typeof loaded.factory(require).apply, 'function');
`);
    execFileSync(process.execPath, [join(fixture, "smoke.mjs")], { cwd: fixture, encoding: "utf8" });
    await writeFile(join(fixture, "consumer.ts"), `
import type { ObsidianBridgeLifecycle, ReferenceHandoffInput } from 'dsh-obsidian-bridge/api';
import type { BridgeHttpClient } from 'dsh-obsidian-bridge/transport';
import type { StickerRecord } from 'dsh-obsidian-bridge/protocol/data';
import type { VaultIdentity } from 'dsh-obsidian-bridge/protocol/binding';
import type { BridgeStatus } from 'dsh-obsidian-bridge/protocol';
import type { BridgeLifecycleService } from 'dsh-obsidian-bridge';
export type Consumer = [ObsidianBridgeLifecycle, ReferenceHandoffInput, BridgeHttpClient, StickerRecord, VaultIdentity, BridgeStatus, BridgeLifecycleService];
`);
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--skipLibCheck", "--moduleResolution", "Bundler", "--module", "ESNext", "--target", "ES2023", "consumer.ts"], { cwd: fixture, encoding: "utf8" });
  } finally {
    // Only the exact temporary fixture allocated above can be removed.
    if (dirname(fixture) === resolve(tmpdir()) && fixture.startsWith(join(resolve(tmpdir()), "dsh-bridge-package-"))) await rm(fixture, { recursive: true, force: true });
  }
}, 30_000);

it("keeps the transport and protocol browser exports free of Node-only chunks", async () => {
  const seen = new Set<string>();
  async function visit(file: string): Promise<void> {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readFile(file, "utf8");
    expect(text, file).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()["']node:/);
    for (const match of text.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) await visit(resolve(dirname(file), match[1]!));
  }
  for (const path of ["api.js", "transport.js", "protocol.js", "protocol/data.js", "protocol/binding.js"]) await visit(join(root, "dist", path));
  expect(seen.size).toBeGreaterThan(5);
});
