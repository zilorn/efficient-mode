#!/usr/bin/env node
/**
 * Check against a supplied installed/extracted dsh runtime, without booting a
 * profile or making model calls. Uses the client's own resolver, YAML parser,
 * plugin schemas, Cordis scopes, persona and prompt registry. No dependencies
 * are installed into this bundle.
 *
 * Usage: node scripts/verify-client.mjs /path/to/resources/app/dsh
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Facts from '../index.js'
import * as Worktree from '../worktree.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv[2]) throw new Error('Pass the dsh runtime directory containing package.json and node_modules')
const clientRoot = resolve(process.argv[2])
const requireClient = createRequire(resolve(clientRoot, 'package.json'))
const load = (name) => {
  if (name === '@zilorn/dsh-efficient-mode') return Promise.resolve(Facts)
  if (name === '@zilorn/dsh-efficient-mode/worktree') return Promise.resolve(Worktree)
  return import(pathToFileURL(requireClient.resolve(name)).href)
}
const { parse } = requireClient('yaml')
// Preserve disabled expressions as data; the checks below inspect both platform
// branches and never evaluate code from YAML.
const patch = parse(readFileSync(resolve(root, 'cordis.patch.yml'), 'utf8'), {
  customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (text) => text }],
})
const preset = patch.flatMap((entry) => entry.insert ?? []).find((row) => row.config?.id === 'efficient')
assert(preset, 'efficient preset declaration is missing')
const rows = []
function visit(row) {
  if (row.name === 'cordis:group') {
    for (const child of row.config) visit(child)
  } else {
    rows.push(row)
  }
}
visit(preset)
for (const row of preset.config.plugins) visit(row)
const modules = new Map(await Promise.all([...new Set(rows.map((row) => row.name))]
  .map(async (name) => [name, await load(name)])))
for (const row of rows) {
  const plugin = modules.get(row.name)
  const schema = plugin.Config ?? plugin.default?.Config
  if (!schema) continue
  const result = await schema['~standard'].validate(row.config ?? {})
  assert(!result.issues, `${row.id}: ${JSON.stringify(result.issues)}`)
}
const worktreeRow = rows.find((row) => row.id === 'worktree-tools')
assert(worktreeRow, 'worktree-tools row is missing')
const worktreePlugin = modules.get(worktreeRow.name)
assert.equal(worktreePlugin.name, 'worktree-tools')
assert.equal(typeof worktreePlugin.apply, 'function')
assert.deepEqual([...worktreePlugin.inject].sort(), ['sandboxPolicy', 'tools', 'workingDirectory'])
console.log(`client ${JSON.parse(readFileSync(resolve(clientRoot, 'package.json'), 'utf8')).version}: ${rows.length} plugin rows resolve and pass client schemas`)

const [{ Context }, { default: SystemPrompt, renderPrompt }, { createScope }] = await Promise.all([
  load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-system-prompt'), load('@deepseek-ai/dsh-scope'),
])

// Register the three tools with the client's real registry. This checks the
// output schemas against the client's enforced JSON Schema subset and proves
// the plain definitions satisfy the registry contract without a harness import.
const { default: ToolsService } = await load('@deepseek-ai/dsh-tools')
const toolCtx = new Context()
try {
  await toolCtx.plugin(SystemPrompt, { personaPrefix: '' })
  await toolCtx.plugin(ToolsService)
  worktreePlugin.apply({ tools: toolCtx.tools, workingDirectory: {} }, {})
  const names = toolCtx.tools.definitions().map((definition) => definition.name)
  for (const expected of ['create_worktree', 'merge_worktree', 'archive_worktree']) {
    assert(names.includes(expected), `${expected} must register with the client tool registry`)
  }
  console.log('client tools: create_worktree, merge_worktree, archive_worktree registered')
} finally {
  await toolCtx.fiber.dispose()
}

const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Deployment persona' })
  ctx.systemPrompt.section({ name: 'other-guidance', order: 1000, text: 'Other plugin section' })
  const key = { agent: 'efficient-client-check' }
  const scope = createScope(ctx, key)
  const factsRow = rows.find((row) => row.id === 'prompt-facts')
  const personaRow = rows.find((row) => row.id === 'persona')
  await scope.ctx.plugin(Facts, factsRow.config ?? {})
  await scope.ctx.plugin(modules.get(personaRow.name), personaRow.config)
  const sessionCwd = resolve(root, 'scripts')
  const context = { scope: key, agent: { id: key.agent, session: { header: { cwd: sessionCwd } } } }
  const assembly = await ctx.systemPrompt.assemble(context)
  assert.equal(assembly.sections.length, 1, 'complete persona must remain the sole system section')
  const rendered = renderPrompt(assembly)
  assert.equal(Object.keys(assembly.variables).length, 11)
  assert(rendered.includes(`Primary working directory: \`${sessionCwd}\``), 'session cwd must reach the prompt')
  assert(!rendered.includes('{{'), 'all prompt variables must resolve')
  assert.equal(rendered, renderPrompt(await ctx.systemPrompt.assemble(context)), 'session prompt must remain stable')
  assert(renderPrompt(await ctx.systemPrompt.assemble()).includes('Deployment persona'), 'preset must stay scoped')
  console.log('client prompt: scoped persona, 11 variables, complete prompt and session stability passed')
} finally {
  await ctx.fiber.dispose()
}
