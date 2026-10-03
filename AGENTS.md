# AGENTS.md

## Project

A dsh (DeepSeek Harness) plugin bundle that registers one Agent preset: **Efficient Mode**
(id `efficient`).

- The preset's base prompt is the body of `~/Documents/System prompt.md`, kept verbatim except for
  11 `[]` placeholders, which become `{{variable}}` references.
- A Host plugin shipped in this package ([index.js](index.js)) resolves those variables on every
  prompt assembly: current branch, main branch, committer, working-tree status, last 3 commits,
  working directory, is-git-repository, platform, shell, OS version, today's date.
- The persona row sets `complete: true`, so the rendered template is that agent's **entire** system
  prompt rather than a prefix other sections append to.

Layout: [cordis.patch.yml](cordis.patch.yml) declares the preset and the plugin rows it mounts,
[index.js](index.js) supplies the dynamic facts, [scripts/build-patch.mjs](scripts/build-patch.mjs)
generates the former from the prompt file, and
[scripts/verify.mjs](scripts/verify.mjs) checks the two halves against each other.

## Stack

- **Runtime**: Node.js >= 18, ESM. `index.js` imports only `node:child_process` and `node:os`. A
  profile-installed bundle cannot resolve dependencies that live in the dsh installation, so this
  package imports no harness package and has zero dependencies.
- **Plugin shape**: a Cordis plugin exporting `apply(ctx, config)`, `inject`, `name`; the bundle is
  `package.json` -> `dsh.bundle.patch` -> `cordis.patch.yml`.
- **dsh APIs used**: `ctx.systemPrompt.variable(name, provider)` registers a prompt variable
  (references resolve strictly); `@deepseek-ai/dsh-persona`'s `prefix` is a `{{...}}` template
  evaluated at render time; `@deepseek-ai/dsh-agent-preset`'s `config` declares the preset itself.
- **Tooling**: pnpm, driven by the dsh plugin manager. No build step.

## Commands

```bash
# Regenerate cordis.patch.yml from the base-prompt file (default source: ~/Documents/System prompt.md)
node scripts/build-patch.mjs

# Offline self-check: variable coverage, required config keys, render stability. Non-zero on failure.
node scripts/verify.mjs

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
  it; edit the source prompt file and re-run the script.
- **Never drop a row's `config` on a hunch.** A missing required key fails that row, and one failed
  row fails the **whole preset**: the roster card shows 加载失败 and no session can use it. Known
  required keys are `sampleOverCapGlobResults` on `dsh-tool-fs-search`, `prefix` on `dsh-persona`,
  and `section` on `dsh-plan-mode`. When adding or changing a tool row, copy the `config` the shipped
  `standard` preset passes to that same row. `scripts/verify.mjs` asserts the first two.
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
- **Reinstall after changes.** A local directory installs as a link, but an already-loaded JS module
  only refreshes when the dsh process restarts.

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
