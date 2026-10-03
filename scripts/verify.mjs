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

/** Collect the variable providers `apply()` registers, without a live context. */
function collectProviders() {
  const providers = new Map()
  const ctx = {
    effect: (callback) => callback(),
    systemPrompt: {
      variable: (name, provider) => {
        providers.set(name, provider)
        return () => {}
      },
    },
  }
  apply(ctx, {})
  return providers
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

const providers = collectProviders()
const template = extractTemplate(readFileSync(PATCH_PATH, 'utf8'))

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

console.log(`template: ${template.split('\n').length} lines, ${references.length} prompt variables`)
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
