import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("declares the native context cohort without altering the supported profile contract", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  expect(manifest.version).toBe("0.4.1-rc2.3");
  expect(manifest.peerDependencies["dsh-annotation-core"].split(" || ")).toContain("0.3.12-rc2.19");
  expect(manifest.peerDependenciesMeta["dsh-annotation-core"]).toEqual({ optional: true });
  expect(manifest.files).toContain("docs/changes");
});
