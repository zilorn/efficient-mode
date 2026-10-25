# AGENTS.md

## Project

A dsh (DeepSeek Harness) plugin bundle that registers one Agent preset: **Efficient Mode**
(id `efficient`).

- The preset's base prompt is the body of [base-prompt.md](base-prompt.md), kept verbatim except
  for 11 `[]` placeholders, which become `{{variable}}` references.
- A Host plugin shipped in this package ([index.js](index.js)) resolves those variables on every
  prompt assembly: current branch, main branch, committer, working-tree status, last 3 commits,
  working directory, is-git-repository, platform, shell, OS version, and today's date.
- A second Host plugin ([worktree.js](worktree.js)) registers `create_worktree`, `merge_worktree`,
  and `archive_worktree` as plain tool definitions. New checkouts stay inside the session workspace;
  the tools never fetch or push.
- The persona row sets `complete: true`, so the rendered template is that agent's **entire** system
  prompt rather than a prefix other sections append to.
- Workspace instruction files reach the agent separately: the preset mounts
  `dsh-agent-instructions`, which injects the global and project `AGENTS.md`/`CLAUDE.md` chain as a
  baseline user message rather than a system-prompt section.

Layout: [cordis.patch.yml](cordis.patch.yml) declares the preset and the plugin rows it mounts,
[index.js](index.js) supplies the dynamic facts, [worktree.js](worktree.js) supplies the Git
worktree tools, [scripts/build-patch.mjs](scripts/build-patch.mjs) generates the former from
[base-prompt.md](base-prompt.md), [scripts/verify.mjs](scripts/verify.mjs) checks the two halves
against each other, and [scripts/verify-worktree.mjs](scripts/verify-worktree.mjs) exercises the
worktree lifecycle against a temporary repository.

## Stack

- **Runtime**: Node.js >= 18, ESM. `index.js` imports only `node:child_process` and `node:os`;
  `worktree.js` imports Node builtins only. A profile-installed bundle cannot resolve dependencies
  that live in the dsh installation, so this package imports no harness package and has zero
  dependencies.
- **Plugin shape**: a Cordis plugin exporting `apply(ctx, config)`, `inject`, `name`; the bundle is
  `package.json` -> `dsh.bundle.patch` -> `cordis.patch.yml`.
- **dsh APIs used**: `ctx.systemPrompt.variable(name, provider)` registers a prompt variable
  (references resolve strictly); `@deepseek-ai/dsh-persona`'s `prefix` is a `{{...}}` template
  evaluated at render time; `@deepseek-ai/dsh-agent-preset`'s `config` declares the preset itself;
  `ctx.tools.register` registers plain tool definitions; `ctx.workingDirectory.ensure/set` reads and
  changes the session directory.
- **Tooling**: pnpm, driven by the dsh plugin manager. No build step.

## Commands

```bash
# Regenerate cordis.patch.yml from the base-prompt template (default source: base-prompt.md)
node scripts/build-patch.mjs

# Offline self-check: variable coverage, required config keys, render stability. Non-zero on failure.
node scripts/verify.mjs

# Worktree lifecycle against a temporary repository: create, commit, merge, conflict, archive.
node scripts/verify-worktree.mjs

# Check module exports, schemas and real prompt assembly using a client runtime
node scripts/verify-client.mjs /path/to/resources/app/dsh

# Syntax check
node --check index.js

# Install / update into the desktop profile (a local directory installs as a link)
dsh plugin --profile desktop add /home/zilorn/Projects/better-system-prompt
```

An agent can also install it in-session through the `plugin_manager` tool's `install_bundle`; that is
a tool call, not a shell command.

To confirm the preset row is live, query `Config.listConfigs` through `cordis_inspect_query` with
`name` filtered to `@deepseek-ai/dsh-agent-preset` and look for `include:preset-efficient`. The
roster card's diagnostic text and the prompt an actual session renders are visible only in the
browser.

## Notes

- **Never hand-edit the `prefix` block in `cordis.patch.yml`.** `scripts/build-patch.mjs` generates
  it; edit [base-prompt.md](base-prompt.md) and re-run the script.
- **Never drop a row's `config` on a hunch.** A missing required key fails that row, and one failed
  row fails the **whole preset**: the roster card shows 加载失败 and no session can use it. Known
  required keys are `sampleOverCapGlobResults` on `dsh-tool-fs-search`, `prefix` on `dsh-persona`,
  `maxBytes` on `dsh-agent-instructions`, and `section` on `dsh-plan-mode`. When adding or changing a
  tool row, copy the `config` the shipped `standard` preset passes to that same row.
  `scripts/verify.mjs` asserts the first three.
- **`@deepseek-ai/*` names are the real module names of packages shipped inside dsh.** The Loader
  loads them by name, so keep them verbatim; renaming one breaks resolution. This repository's own
  package is `@zilorn/dsh-efficient-mode`. Changing the scope means editing both `package.json`'s
  `name` and the `name` on the `prompt-facts` row, then reinstalling.
- **The YAML inside `build-patch.mjs` is a JS template literal.** Never put a raw backtick in its
  comments, or escape it properly; otherwise the script fails to parse. This has bitten twice.
- **Prompt-variable references resolve strictly.** An unregistered `{{name}}` in the template, or a
  provider returning `undefined`, fails the entire prompt assembly. Every provider must return a
  string and fall back to placeholder text.
- **The git probe is synchronous** (`execFileSync`, 3 second budget for the whole probe) and cached
  once per session. That matches the template's "snapshot in time" wording and keeps the prompt
  byte-identical across steps so the provider prefix cache stays reusable.
- **`complete: true` discards sections other plugins contribute**, so do not mount a plugin whose
  only model-facing effect is a section. `dsh-plan-mode` is the example: mounting it turns the
  composer's plan chip into a no-op the model never sees.
- **Workspace instructions need their own row in the preset.** `dsh-agent-instructions` injects
  `$DSH_HOME/AGENTS.md` and the project's AGENTS.md/CLAUDE.md chain as a baseline **user message**,
  so `complete: true` does not suppress it. A preset's `plugins` list is that agent's whole
  composition, so the profile-level row `dsh-base` mounts does not reach it; the preset declares
  `maxBytes: 65536` itself, matching the shipped `standard` preset. The Session-context block in
  [base-prompt.md](base-prompt.md) stays a hand-written snapshot of the global preferences and does
  not track that file.
- **Auto-compaction is row config inside the generated patch.** The `compaction-basic` row sets
  `thresholdRatio: 0.6`, so pressure triggers at 60% of the routed model's window, and `auto` is the
  switch whose `false` keeps only manual `/compact`. Both live in the YAML template of
  [scripts/build-patch.mjs](scripts/build-patch.mjs): edit there and regenerate; the linked profile
  install re-reads a bundle patch at boot, so restart dsh to apply. The base prompt tells the agent
  the same trigger in the Context management section of [base-prompt.md](base-prompt.md).
  [scripts/verify.mjs](scripts/verify.mjs) asserts the 60% threshold, the boolean switch, and that
  the rendered prompt names the configured percentage.
- **Tool guidance is restated in the template.** Tools and Goals and delegation in
  [base-prompt.md](base-prompt.md) carry the rules dsh's tool plugins also register as sections
  (read/write/edit, glob/grep, background jobs, web, skills, goals, delegation), because
  `complete: true` can collapse those sections away. A task-intake rule also sits inside a
  `<system-reminder>` block: after the user posts a task, locate the change with grep or rg, then
  read the matching file before editing. The todo rule additionally sits inside a
  `<system-reminder>` block that insists on a final `todo_write` before the answer, because agents
  kept leaving the last step `in_progress`. [scripts/verify.mjs](scripts/verify.mjs) asserts one
  marker phrase per rule, plus that both reminders are still wrapped. When dsh changes its own
  wording, decide deliberately whether to sync the template copy.
- **Reinstall after changes.** A local directory installs as a link, but an already-loaded JS module
  only refreshes when the dsh process restarts.
- **Delegation targets dsh 0.2.1-rc.3.** The control row now owns list_agents; the
  old dsh-tool-subagent-control/list-agents subpath is not exported. The spawn row uses
  modelSelection: true and modelDiscovery: true, matching standard. Do not restore
  modelSelectionSettings or backgroundMode; the provider now owns managed child behavior.
  The offline verifier rejects these obsolete entries. verify-client.mjs optionally loads
  the supplied client's modules and schemas and exercises real scoped prompt assembly,
  without adding dependencies to this package or booting a profile.
- **Worktree tools are plain definitions, not `defineTool` calls.** The package must not import
  `@deepseek-ai/*`, so [worktree.js](worktree.js) supplies raw parameter and output JSON Schemas
  itself. `create_worktree` puts checkouts under `.worktrees/` inside the session workspace and adds
  the pool to `.git/info/exclude`; `merge_worktree` requires clean source and target, uses `--no-ff`,
  and aborts conflicts; `archive_worktree` keeps the branch by default and needs `force` for dirty
  checkouts or unmerged branch deletion. The tools never fetch or push, and all three refuse the
  read-only file policy; under `workspace-write` the new checkout must stay inside the session
  workspace. [scripts/verify-worktree.mjs](scripts/verify-worktree.mjs) exercises the whole lifecycle
  and the conflict path. Do not also mount `@deepseek-ai/dsh-experimental-tool-worktree`: it registers
  the same `create_worktree` name and the duplicate fails the whole preset at load.

## Worktree workflow

When the user asks for a worktree, the agent must isolate the work:

1. Call `create_worktree` before changing files. It creates a branch and checkout and moves the
   session into it.
2. Make every file change in that checkout. Do not edit the primary checkout for the task.
3. When the task is complete, commit inside the worktree and report the branch, commit, and a short
   summary to the user.
4. Wait for the user's approval before calling `merge_worktree` or `archive_worktree`.
5. `merge_worktree` merges only clean, committed work and aborts conflicts. `archive_worktree`
   removes the checkout and keeps the branch unless `delete_branch: true`; `force` is for explicit
   data loss.

The same rule is in [base-prompt.md](base-prompt.md) so the model sees it at runtime. Keep the two
copies aligned when editing either one.

## Git

- Write commit messages in English.
- Message format: `feat/fix/docs/refactor: [summary]`, briefly describing what was done. Keep it
  short.
- Commit as soon as a task is finished; do not wait for confirmation. Split large tasks into several
  commits, one concern each.
- After committing, report the result to the user as a table:

  | Commit | Type | What changed |
  |---|---|---|
  | `1a0ee54` | docs | Require English commit messages in AGENTS.md |
