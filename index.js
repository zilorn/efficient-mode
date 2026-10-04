/**
 * Efficient Mode (高效模式) prompt facts.
 *
 * Registers the prompt variables that the `efficient` agent preset's base
 * prompt interpolates: the live git facts, the invocation environment, and the
 * input-language instruction. The preset's `deployment:persona-prefix` section
 * is a `{{variable}}` template, and the prompt registry resolves those
 * references strictly, at render time, for every model step.
 *
 * Two properties shape the implementation:
 *
 * - Variable providers are synchronous, because interpolation happens inside
 *   assembly. The git probe therefore runs `git` through `execFileSync` under a
 *   hard wall-clock budget, and every call site is failure-tolerant: a missing
 *   binary, a non-repository directory, or a timeout yields a placeholder
 *   instead of an exception, because a provider that returns `undefined` makes
 *   the whole prompt fail to render.
 * - One snapshot per session is cached, so a conversation's prompt stays
 *   byte-identical across steps. The template tells the model that the git
 *   status is "a snapshot in time, and will not update during the
 *   conversation", and a stable prompt also keeps the provider prefix cache
 *   reusable.
 *
 * The language instruction is the one deliberately per-turn value. The base
 * prompt has to tell the model to answer in Chinese exactly while the user is
 * writing Chinese, so the plugin remembers the language of each agent's latest
 * human input and refreshes that verdict whenever a message is claimed for a
 * step — the last moment before the step's prompt is assembled. Inputs from
 * other producers (scheduled prompts, goal rounds, subagents) never overwrite
 * the verdict, so the hint follows the human across the whole conversation.
 *
 * The module imports Node builtins only. A profile-installed bundle resolves
 * its bare imports from the profile, not from the dsh installation, so
 * depending on a harness package here would make activation depend on the
 * install layout.
 *
 * @module @zilorn/dsh-efficient-mode
 */

import { execFileSync } from 'node:child_process'
import { release as osRelease, type as osType } from 'node:os'

/** Cordis plugin name. */
export const name = 'efficient-mode'

/** The prompt registry these facts are contributed to. */
export const inject = ['systemPrompt']

/** Commits listed by `{{git_commits}}`, matching the template's `[commits(3)]`. */
const DEFAULT_COMMIT_COUNT = 3

/** Wall-clock budget shared by every git call of one probe. */
const GIT_PROBE_BUDGET_MS = 3000

/** Cap on `{{git_status}}` lines before a trailing count of hidden paths. */
const MAX_STATUS_LINES = 20

/** Retained session snapshots; the oldest entry is evicted first. */
const MAX_SNAPSHOTS = 64

/** Stand-in for a git fact that could not be read. */
const UNKNOWN = '(unknown)'

/** Stand-in for a fact that only exists inside a repository. */
const NO_REPOSITORY = '(not a git repository)'

/** The instruction `{{language_instruction}}` carries while the latest human input is Chinese. */
const CHINESE_INSTRUCTION = '用户输入中文，请使用中文回答（包括提问）；中途的回复无需使用中文。'

/** Han ideographs, the script Chinese shares with Japanese kanji and rare Korean hanja. */
const HAN = /\p{Script=Han}/u

/** Japanese kana; their presence marks a text as Japanese rather than Chinese. */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u

/** Whitespace, ignored when measuring a message's Han share. */
const WHITESPACE = /\s/u

/** Han share above which a message counts as Chinese. */
const CHINESE_SHARE = 0.25

/**
 * Read an effective commit count from the row config, which is optional and
 * unvalidated because this plugin declares no Config schema.
 * @param config - the loader row's config, if any.
 * @returns the bounded commit count to list.
 */
function commitCountOf(config) {
  const value = Number(config?.commitCount)
  if (!Number.isInteger(value) || value < 1) return DEFAULT_COMMIT_COUNT
  return Math.min(value, 50)
}

/**
 * Run one git command inside a probe budget.
 * @param cwd - the directory the command runs in.
 * @param args - git arguments, without the executable name.
 * @param deadline - epoch milliseconds after which the call is abandoned.
 * @returns trimmed stdout.
 * @throws when git is missing, exits non-zero, or exceeds the remaining budget.
 */
function runGit(cwd, args, deadline) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error('git probe budget exhausted')
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    timeout: remaining,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/**
 * Run one git command, treating every failure as "no answer".
 * @param cwd - the directory the command runs in.
 * @param args - git arguments, without the executable name.
 * @param deadline - epoch milliseconds after which the call is abandoned.
 * @returns trimmed stdout, or `undefined` when the command did not answer.
 */
function tryGit(cwd, args, deadline) {
  try {
    return runGit(cwd, args, deadline)
  } catch {
    return undefined
  }
}

/**
 * Name the branch pull requests usually target: the remote's default branch
 * when one is published, otherwise the first conventional local branch.
 * @param cwd - repository working tree.
 * @param deadline - epoch milliseconds after which git calls are abandoned.
 * @param fallback - branch name to use when nothing else identifies one.
 * @returns the main branch name.
 */
function detectMainBranch(cwd, deadline, fallback) {
  const remoteHead = tryGit(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], deadline)
  if (remoteHead) return remoteHead.replace(/^origin\//, '')
  for (const candidate of ['main', 'master']) {
    if (tryGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], deadline) !== undefined) {
      return candidate
    }
  }
  return fallback
}

/**
 * Render the working-tree status the way `git status --short` prints it.
 * @param cwd - repository working tree.
 * @param deadline - epoch milliseconds after which git calls are abandoned.
 * @returns `(clean)`, the changed paths, or an unavailability note.
 */
function renderStatus(cwd, deadline) {
  const porcelain = tryGit(cwd, ['status', '--porcelain'], deadline)
  if (porcelain === undefined) return '(status unavailable)'
  if (porcelain === '') return '(clean)'
  const lines = porcelain.split('\n')
  const shown = lines.slice(0, MAX_STATUS_LINES)
  if (lines.length > MAX_STATUS_LINES) shown.push(`(+${lines.length - MAX_STATUS_LINES} more changed paths)`)
  return shown.join('\n')
}

/**
 * Read every git fact this preset's prompt renders.
 * @param cwd - directory to inspect; anything outside a repository yields placeholders.
 * @param commitCount - how many recent commits to list.
 * @returns one immutable snapshot of the repository state.
 */
function probeGit(cwd, commitCount) {
  const deadline = Date.now() + GIT_PROBE_BUDGET_MS
  if (tryGit(cwd, ['rev-parse', '--is-inside-work-tree'], deadline) !== 'true') {
    return {
      repository: false,
      branch: NO_REPOSITORY,
      mainBranch: NO_REPOSITORY,
      user: NO_REPOSITORY,
      status: NO_REPOSITORY,
      commits: NO_REPOSITORY,
    }
  }
  const head = tryGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'], deadline)
  const branch = head || tryGit(cwd, ['rev-parse', '--short', 'HEAD'], deadline) || '(no commits yet)'
  const log = tryGit(cwd, ['log', `-n${commitCount}`, '--pretty=format:%h %s'], deadline)
  return {
    repository: true,
    branch,
    mainBranch: detectMainBranch(cwd, deadline, branch),
    user: tryGit(cwd, ['config', 'user.name'], deadline) || UNKNOWN,
    status: renderStatus(cwd, deadline),
    commits: log || '(no commits yet)',
  }
}

/** Session snapshots, keyed by session id (or working directory without one). */
const snapshots = new Map()

/** Whether each agent's latest human input is Chinese; absent until first resolved. */
const chineseInputs = new Map()

/**
 * Read the session's git snapshot, probing the first time and reusing it after.
 * @param key - the session id, or the working directory when no agent is known.
 * @param cwd - directory to inspect on a miss.
 * @param commitCount - how many recent commits to list.
 * @returns the session's snapshot.
 */
function snapshotFor(key, cwd, commitCount) {
  const cached = snapshots.get(key)
  if (cached !== undefined && cached.cwd === cwd && cached.commitCount === commitCount) return cached.facts

  const facts = probeGit(cwd, commitCount)
  if (snapshots.size >= MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next()
    if (oldest.done !== true) snapshots.delete(oldest.value)
  }
  snapshots.set(key, { cwd, commitCount, facts })
  return facts
}

/**
 * Resolve the working directory of the agent being assembled.
 *
 * `AssembleContext` declares only `scope` and `signal`; the agent loop adds the
 * agent, and other assemblers add nothing. Every shape is therefore optional.
 * @param context - the assembly context handed to the variable provider.
 * @returns an absolute directory, never empty.
 */
function workingDirectoryOf(context) {
  const agent = context?.agent
  const candidates = [agent?.session?.header?.cwd, agent?.session?.cwd, agent?.cwd, context?.cwd]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return process.cwd()
}

/**
 * Build the fact lookup for one provider call.
 * @param context - the assembly context handed to the variable provider.
 * @param commitCount - how many recent commits to list.
 * @returns the session's git snapshot.
 */
function factsOf(context, commitCount) {
  const cwd = workingDirectoryOf(context)
  const key = context?.agent?.id
  return snapshotFor(key === undefined ? cwd : String(key), cwd, commitCount)
}

/**
 * Join the visible text of one message's content blocks.
 * @param message - a user message, or any shape an assembly may hand over.
 * @returns the concatenated text, or an empty string when there is none.
 */
function textOf(message) {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Whether a text is predominantly Chinese.
 *
 * The Han share guards against quoted fragments: a Chinese word inside an
 * English sentence does not flip the language. Kana mark Japanese text that
 * happens to use kanji, so their presence rules Chinese out.
 * @param text - the candidate input.
 * @returns whether the text counts as Chinese.
 */
function isChinese(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  if (KANA.test(text)) return false
  let characters = 0
  let han = 0
  for (const character of text) {
    if (WHITESPACE.test(character)) continue
    characters += 1
    if (HAN.test(character)) han += 1
  }
  return characters > 0 && han / characters >= CHINESE_SHARE
}

/**
 * Find the latest human input in a session's existing history.
 *
 * This answers the turns no fresh input starts: a resumed session continued by
 * a goal round or a scheduled prompt still answers the person who last wrote
 * to it. A message without text (an image alone) yields an empty string.
 * @param agent - the agent being assembled, when the assembler supplied one.
 * @returns the message text, or an empty string when none can be read.
 */
function latestHumanInput(agent) {
  const session = agent?.session
  if (typeof session?.deriveMessages !== 'function') return ''
  try {
    const messages = session.deriveMessages()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (message?.role === 'user' && message.source?.kind === 'user') return textOf(message)
    }
  } catch {
    return ''
  }
  return ''
}

/**
 * Cache one agent's language verdict, evicting the oldest entry past the cap.
 * @param key - the agent id.
 * @param chinese - whether its latest human input is Chinese.
 */
function rememberInput(key, chinese) {
  if (chineseInputs.size >= MAX_SNAPSHOTS) {
    const oldest = chineseInputs.keys().next()
    if (oldest.done !== true) chineseInputs.delete(oldest.value)
  }
  chineseInputs.set(key, chinese)
}

/**
 * Whether the agent's latest human input is Chinese.
 *
 * The `agent/inbox/claimed` listener fills the per-agent verdict; a cache miss
 * falls back to the session log once, so a resumed session with no claimed
 * input yet still resolves.
 * @param context - the assembly context handed to the variable provider.
 * @returns whether the language instruction applies.
 */
function usesChinese(context) {
  const agent = context?.agent
  const id = agent?.id
  const key = id === undefined ? undefined : String(id)
  if (key !== undefined) {
    const cached = chineseInputs.get(key)
    if (cached !== undefined) return cached
  }
  const chinese = isChinese(latestHumanInput(agent))
  if (key !== undefined) rememberInput(key, chinese)
  return chinese
}

/**
 * Format today's date in the host's local timezone.
 * @param now - the instant to format.
 * @returns `YYYY-MM-DD`.
 */
function localDate(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Register this preset's prompt variables for the mounting scope.
 *
 * Every reference in the preset's `{{...}}` template must be registered here,
 * because an unknown reference fails prompt assembly rather than rendering
 * empty.
 * @param ctx - the preset scope context; `systemPrompt` is injected.
 * @param config - optional row config, currently only `commitCount`.
 */
export function apply(ctx, config) {
  const commitCount = commitCountOf(config)
  const register = (variable, provider) => {
    ctx.effect(() => ctx.systemPrompt.variable(variable, provider), `efficient-mode.variable(${variable})`)
  }

  // A claimed message is what the step's prompt answers, and the claim happens
  // before that step is assembled: record the language now, so the provider
  // below can read it while rendering.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return
    const id = agent?.id
    if (id === undefined) return
    rememberInput(String(id), isChinese(textOf(message)))
  })

  register('working_directory', (context) => workingDirectoryOf(context))
  register('is_git_repository', (context) => String(factsOf(context, commitCount).repository))
  register('git_branch', (context) => factsOf(context, commitCount).branch)
  register('git_main_branch', (context) => factsOf(context, commitCount).mainBranch)
  register('git_user', (context) => factsOf(context, commitCount).user)
  register('git_status', (context) => factsOf(context, commitCount).status)
  register('git_commits', (context) => factsOf(context, commitCount).commits)
  register('platform', () => process.platform)
  register('shell', () => (process.platform === 'win32' ? 'pwsh' : 'bash'))
  register('os_version', () => `${osType()} ${osRelease()}`)
  register('today', () => localDate())
  register('language_instruction', (context) => (usesChinese(context) ? CHINESE_INSTRUCTION : ''))
}
