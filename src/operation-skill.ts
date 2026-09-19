import type { SkillRegistration } from '@deepseek-ai/dsh-skill';

export const obsidianOperationSkill: SkillRegistration = {
  name: 'obsidian-bound-vault', provider: 'dsh-obsidian-bridge', source: 'bundled',
  description: 'Operate the Obsidian Vault bound to this DSH instance through the official CLI; edit notes, use templates/styles, and reload locally built plugins.',
  invocation: { modelInvocable: true, userInvocable: true },
  metadata: { 'dsh-executor-portability': 'self-contained' },
  content: `# Bound Obsidian Vault operations

Use the official Obsidian CLI first, through dsh_obsidian_cli. The Bridge resolves
the bound Vault to the native CLI ID and verifies its live location and binding.
Never rely on the current active Vault, a display name, an old port, or assume the
Bridge vaultId equals the native Obsidian ID. Read the currently callable tool
catalogue; a managed executor may prefix these names with its server namespace.

1. Call dsh_obsidian_targets. Select the Vault intended by the user's task.
   If multiple bound Vaults remain ambiguous, ask which one. Listing is read-only.
2. Call dsh_obsidian_cli with vaultId, command and a parameters object. Do not pass
   a vault selector, shell syntax, or a CLI executable in parameters. The bridge
   supplies them. Paths are exact Vault-relative note paths, not active-file defaults.
3. Every write/UI change requires a unique requestId. Reuse it only for exactly the
   same request. A repeated request returns the durable receipt and is not rerun.
   unconfirmed/started means the result is unknown: inspect the target before any
   newly authorized retry. Do not generate a new ID to hide an uncertain result.

Examples (parameters are data, not a command string):
- read: {path: 'Notes/example.md'}
- create: {path: 'Notes/new.md', content: '# Title\\nBody'}
- append: {path: 'Notes/example.md', content: '\\nMore text'}
- search: {query: 'topic', format: 'json'}
- property:set: {path: 'Notes/example.md', name: 'status', value: 'draft'}
- create from template: {path: 'Notes/new.md', template: 'Project'}
- snippet:enable: {name: 'my-style'}
- plugin:reload: {id: 'my-plugin'}

Plugin work in the Bridge is limited to inspection and reload. Generate/build
plugin code with local engineering tools; the Bridge does not install, uninstall,
enable, disable or compile plugins. Do not treat Obsidian's internal objects as a
stable public API. The CLI is mandatory for this operation path. CLI_UNAVAILABLE
requires restoring the official CLI installation/configuration; do not silently
switch to arbitrary filesystem writes or another Vault. Unsupported operations
remain unsupported until implemented; no generic HTTP/eval fallback is promised.

Respect the user's requested scope. This skill provides operation guidance, not
authorization to publish, delete unrelated files, change bindings, or activate new
plugins. Core and Session Maintenance are not prerequisites for these operations.
Report actual results and limitations; a registered tool is not proof of a live write.
`,
};
