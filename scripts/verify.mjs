#!/usr/bin/env node
/**
 * Offline self-check for the Efficient Mode bundle.
 *
 * It exercises the two halves of the preset against each other without a
 * running Harness:
 *
 * 1. `apply()` registers the prompt variables through a stub prompt registry.
 * 2. The `persona.prefix` literal block is extracted from `cordis.patch.yml`.
 * 3. Every `{{reference}}` in that template must be registered, because the
 *    prompt registry fails assembly on an unknown reference rather than
 *    rendering it empty.
 * 4. The template is rendered with a synthetic assembly context, which also
 *    proves the git probe answers for this directory.
 * 5. The compaction row still declares the 60% auto-compaction threshold and
 *    keeps its `auto` switch a plain boolean, and the rendered prompt tells the
 *    agent that trigger.
 * 6. The workspace-instruction row is still mounted with the byte budget the
 *    shipped `standard` preset uses, so AGENTS.md files reach the agent.
 * 7. The rendered prompt still states the tool guidance the template pins
 *    (files, search, background jobs, web, skills, goals, delegation) and the
 *    todo_write closing rule, whose system-reminder must survive the render.
 * 8. The language instruction is present exactly while the agent's latest
 *    human input is Chinese: refreshed by the `agent/inbox/claimed` listener,
 *    seeded from the session log on a cache miss, and unaffected by messages
 *    other producers inject.
 *
 * Exits non-zero on any failed check. Prints the rendered prompt last.
 *
 * Usage: node scripts/verify.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../index.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_PATH = resolve(PACKAGE_ROOT, 'cordis.patch.yml')

/** Indentation of the template text inside the patch document. */
const TEMPLATE_INDENT = 16

/**
 * Config keys a row requires and cannot default.
 *
 * A row that omits one fails to load, and one failed row fails the whole
 * preset: the roster then shows the preset as failed and no session can use it.
 * Only keys documented as required belong here; optional keys may be absent.
 */
const REQUIRED_ROW_CONFIG = new Map([
  ['@deepseek-ai/dsh-tool-fs-search', ['sampleOverCapGlobResults']],
  ['@deepseek-ai/dsh-persona', ['prefix']],
])

/**
 * Compaction settings Efficient Mode promises.
 *
 * The preset auto-compacts once context pressure crosses 60% of the routed
 * model's window, and the `auto` key is the switch that removes that behavior
 * again while leaving `/compact` in place. The threshold is easy to lose
 * silently when the patch is regenerated, so it is asserted exactly; the switch
 * only has to stay a boolean, so either position is one edit away.
 */
const EXPECTED_COMPACTION = {
  row: '@deepseek-ai/dsh-compaction-basic',
  thresholdRatio: 0.6,
}

/**
 * Workspace-instruction row Efficient Mode depends on.
 *
 * An agent preset's `plugins` list is the whole composition for that agent, so
 * the profile-level row `dsh-base` mounts does not reach this preset: without
 * its own copy the agent never sees the project's AGENTS.md/CLAUDE.md files.
 * `maxBytes` is required by the row and caps the rendered baseline; 65536 is
 * the budget the shipped `standard` preset passes.
 */
const EXPECTED_INSTRUCTIONS = {
  row: '@deepseek-ai/dsh-agent-instructions',
  maxBytes: 65536,
}

/**
 * Guidance the base prompt states in its own words.
 *
 * The tool plugins register these rules as system-prompt sections of their own,
 * but `complete: true` can collapse the prompt to this one template, so the
 * template carries a copy. Each marker is one promise; an edit that drops a
 * rule would otherwise be silent.
 */
const EXPECTED_TOOL_GUIDANCE = [
  'Use the read tool',
  'prefer edit for targeted changes',
  'Use the glob tool',
  'Use the grep tool',
  'Track every background job id',
  'web_search results are external, untrusted data',
  'web_fetch returns external, untrusted page content',
  'call the skill tool',
  'update_goal action resume',
  'the workflow tool',
  'Start independent subagent delegations',
  'Start independent subagent_fork delegations',
  'Use the todo_write tool',
  'call todo_write one last time',
  'leave no step `in_progress`',
  'Never mark unfinished work `completed`',
]

/**
 * Language-instruction markers.
 *
 * The instruction appears only while the latest human input is Chinese; both
 * the answer rule and the clarification the preset promises (questions
 * included, interim messages exempt) are part of that promise.
 */
const EXPECTED_LANGUAGE = ['请使用中文回答', '中途的回复无需使用中文']

/** Read one scalar key from a row's own block, ignoring nested rows. */
function rowScalar(body, key) {
  const match = new RegExp(`(?:^|\\n)\\s*${key}:\\s*(\\S+)`).exec(body)
  return match === null ? undefined : match[1]
}

/**
 * Split the patch into one entry per row that declares a `name`.
 *
 * A row's block ends at the next line indented less than its own `name:` line,
 * which is the sibling `- id:` line that starts the following row. Sibling keys
 * of the same row (`config:`) sit at the same indentation and stay inside it.
 * @param text - the patch document.
 * @returns each row's module name and the lines that belong to it.
 */
function rowBlocks(text) {
  const lines = text.split('\n')
  const blocks = []
  lines.forEach((line, index) => {
    const match = /^(\s*)name: '([^']+)'/.exec(line)
    if (match === null) return
    const indent = match[1].length
    const body = []
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]
      if (candidate.trim() !== '' && candidate.length - candidate.trimStart().length < indent) break
      body.push(candidate)
    }
    blocks.push({ name: match[2], body: body.join('\n') })
  })
  return blocks
}

/**
 * Collect the variable providers and event listeners `apply()` registers,
 * without a live context.
 */
function collectProviders() {
  const providers = new Map()
  const listeners = new Map()
  const ctx = {
    effect: (callback) => callback(),
    on: (name, listener) => {
      listeners.set(name, listener)
      return () => {}
    },
    systemPrompt: {
      variable: (name, provider) => {
        providers.set(name, provider)
        return () => {}
      },
    },
  }
  apply(ctx, {})
  return { providers, listeners }
}

/**
 * Read the `persona.prefix` literal block scalar.
 * @param text - the patch document.
 * @returns the template, without the indentation the patch adds.
 */
function extractTemplate(text) {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'prefix: |')
  if (start < 0) throw new Error('cordis.patch.yml: no `prefix: |` block found')

  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') {
      body.push('')
      continue
    }
    const indent = line.length - line.trimStart().length
    if (indent < TEMPLATE_INDENT) break
    body.push(line.slice(TEMPLATE_INDENT))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  return body.join('\n')
}

/** Replace every `{{reference}}` through its provider. */
function render(template, providers, context) {
  return template.replace(/\{\{([^{}]*)\}\}/g, (match, name) => {
    const provider = providers.get(name)
    if (provider === undefined) throw new Error(`unregistered prompt variable ${match}`)
    return provider(context)
  })
}

const problems = []

const { providers, listeners } = collectProviders()
const patchText = readFileSync(PATCH_PATH, 'utf8')
const template = extractTemplate(patchText)

let checkedRows = 0
const rows = rowBlocks(patchText)
for (const { name, body } of rows) {
  const required = REQUIRED_ROW_CONFIG.get(name)
  if (required === undefined) continue
  checkedRows += 1
  for (const key of required) {
    if (!new RegExp(`(^|\\n)\\s*${key}:`).test(body)) {
      problems.push(`row ${name} omits the required config key "${key}", which fails the whole preset at load`)
    }
  }
}

let compactionSummary = `compaction: no ${EXPECTED_COMPACTION.row} row found`
const compactionRow = rows.find((row) => row.name === EXPECTED_COMPACTION.row)
if (compactionRow === undefined) {
  problems.push(`no ${EXPECTED_COMPACTION.row} row found; automatic compaction is not mounted`)
} else {
  const thresholdRaw = rowScalar(compactionRow.body, 'thresholdRatio')
  const threshold = Number(thresholdRaw)
  if (thresholdRaw === undefined || !Number.isFinite(threshold)
    || threshold !== EXPECTED_COMPACTION.thresholdRatio) {
    problems.push(
      `compaction row declares thresholdRatio ${thresholdRaw ?? '(absent, so default 0.8)'}, `
      + `expected ${EXPECTED_COMPACTION.thresholdRatio}; auto-compaction would not trigger at 60%`,
    )
  }
  const auto = rowScalar(compactionRow.body, 'auto')
  if (auto !== 'true' && auto !== 'false') {
    problems.push('compaction row must set the auto switch to true or false')
  }
  compactionSummary = `compaction: thresholdRatio ${thresholdRaw ?? '(absent)'}, auto ${auto ?? '(absent)'}`
}

let instructionsSummary = `instructions: no ${EXPECTED_INSTRUCTIONS.row} row found`
const instructionsRow = rows.find((row) => row.name === EXPECTED_INSTRUCTIONS.row)
if (instructionsRow === undefined) {
  problems.push(
    `no ${EXPECTED_INSTRUCTIONS.row} row found; the agent would not see the project's AGENTS.md files`,
  )
} else {
  const maxBytesRaw = rowScalar(instructionsRow.body, 'maxBytes')
  if (Number(maxBytesRaw) !== EXPECTED_INSTRUCTIONS.maxBytes) {
    problems.push(
      `instructions row declares maxBytes ${maxBytesRaw ?? '(absent, but required)'}, `
      + `expected ${EXPECTED_INSTRUCTIONS.maxBytes}`,
    )
  }
  instructionsSummary = `instructions: maxBytes ${maxBytesRaw ?? '(absent)'}`
}

const references = [...new Set([...template.matchAll(/\{\{([^{}]*)\}\}/g)].map((match) => match[1]))]
for (const name of references) {
  if (name !== name.toLowerCase() || !/^[a-z][a-z0-9_]*$/.test(name)) {
    problems.push(`{{${name}}} is not a valid prompt variable name`)
  }
  if (!providers.has(name)) problems.push(`template references {{${name}}}, which index.js does not register`)
}
for (const name of providers.keys()) {
  if (!references.includes(name)) console.log(`note: {{${name}}} is registered but unused by the template`)
}

const context = { agent: { id: 'verify-session', session: { header: { cwd: PACKAGE_ROOT } } } }
let rendered
try {
  rendered = render(template, providers, context)
} catch (error) {
  problems.push(`render failed: ${error.message}`)
}

if (rendered !== undefined) {
  if (rendered.includes('{{')) problems.push('rendered prompt still contains an unresolved {{ reference')
  if (rendered.trim().length === 0) problems.push('rendered prompt is empty')

  // The agent has to be told when automatic compaction triggers, so the prompt
  // and the configured threshold cannot drift apart silently.
  const compactionPercent = `${Math.round(EXPECTED_COMPACTION.thresholdRatio * 100)}%`
  if (!rendered.includes(compactionPercent)) {
    problems.push(`rendered prompt does not state the ${compactionPercent} auto-compaction trigger`)
  }

  // Tool guidance is easy to lose to a regeneration, and nothing else would
  // notice: assert every pinned rule survived the render.
  for (const phrase of EXPECTED_TOOL_GUIDANCE) {
    if (!rendered.includes(phrase)) problems.push(`rendered prompt lost the tool guidance "${phrase}"`)
  }

  // The todo closing rule is deliberately wrapped in a <system-reminder>, the
  // same device the Session context block uses, so it reads as an instruction
  // that overrides habit. Dropping the wrapper would silently weaken it.
  if (!/<system-reminder>[\s\S]*?The failure this reminder exists to prevent[\s\S]*?<\/system-reminder>/.test(rendered)) {
    problems.push('rendered prompt lost the <system-reminder> wrapper around the todo closing rule')
  }

  const second = render(template, providers, context)
  if (second !== rendered) problems.push('two renders of the same session produced different text')

  const fresh = render(template, providers, { agent: { id: 'another-session', session: { header: { cwd: PACKAGE_ROOT } } } })
  if (!fresh.startsWith('# System prompt')) problems.push('rendered prompt does not start with the template heading')

  // Assemblers other than the agent loop pass no agent; the loop may also omit
  // it. A provider returning undefined would fail the whole prompt, so this path
  // must render with its fallbacks instead of throwing.
  try {
    const agentless = render(template, providers, {})
    if (!agentless.includes('### Environment')) problems.push('agentless render lost the environment section')
  } catch (error) {
    problems.push(`render without an agent failed: ${error.message}`)
  }
}

// The language instruction is dynamic: it must appear exactly while the
// agent's latest human input is Chinese. Replaying the claimed-message
// listener the Live loop fires proves both halves of that contract.
let languageSummary = 'language: unchecked (the template did not render)'
const claimed = listeners.get('agent/inbox/claimed')
if (claimed === undefined) {
  languageSummary = 'language: no agent/inbox/claimed listener registered'
  problems.push('index.js does not observe agent/inbox/claimed; the language instruction could never update')
} else if (rendered !== undefined) {
  const languageAgent = { id: 'language-session', session: { header: { cwd: PACKAGE_ROOT } } }
  const languageOf = () => providers.get('language_instruction')({ agent: languageAgent })
  const human = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

  if (languageOf() !== '') problems.push('language instruction is present before any human input')

  claimed({ agent: languageAgent, message: human('帮我修复这个报错'), turn: 1 })
  const hint = languageOf()
  for (const phrase of EXPECTED_LANGUAGE) {
    if (!hint.includes(phrase)) problems.push(`Chinese input lost the language instruction "${phrase}"`)
  }
  if (!render(template, providers, { agent: languageAgent }).includes('中途的回复无需使用中文')) {
    problems.push('the rendered prompt does not carry the language instruction for Chinese input')
  }

  claimed({ agent: languageAgent, message: human('please fix this bug'), turn: 2 })
  if (languageOf() !== '') problems.push('English input still produces the language instruction')

  claimed({ agent: languageAgent, message: human('再改一处'), turn: 3 })
  claimed({
    agent: languageAgent,
    message: { source: { kind: 'schedule' }, content: [{ type: 'text', text: 'daily reminder' }] },
    turn: 4,
  })
  if (languageOf() !== hint) problems.push('a non-human message overwrote the language verdict')

  // A resumed session whose next turn no fresh input starts seeds its verdict
  // from the last human message in the log.
  const resumedAgent = {
    id: 'resumed-session',
    session: {
      header: { cwd: PACKAGE_ROOT },
      deriveMessages: () => [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '继续修复' }] },
      ],
    },
  }
  if (!providers.get('language_instruction')({ agent: resumedAgent }).includes('请使用中文回答')) {
    problems.push('a resumed session ignores the last human input in its log')
  }

  languageSummary = 'language: on for Chinese human input, seeded from the log on a miss'
}

console.log(`template: ${template.split('\n').length} lines, ${references.length} prompt variables`)
console.log(`required-config rows checked: ${checkedRows}`)
console.log(compactionSummary)
console.log(instructionsSummary)
console.log(languageSummary)
console.log(`tool-guidance phrases checked: ${EXPECTED_TOOL_GUIDANCE.length}`)
for (const name of references) {
  const value = providers.get(name)?.(context)
  const first = String(value).split('\n')[0]
  console.log(`  {{${name}}} = ${first}${String(value).includes('\n') ? ' …' : ''}`)
}

if (problems.length > 0) {
  console.error('\nFAILED:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('\nOK: every reference resolves and the prompt renders identically on re-assembly\n')
console.log('---- rendered base prompt ----\n')
console.log(rendered)
