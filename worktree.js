/**
 * Git worktree tools for the Efficient Mode preset.
 *
 * The bundle's other Host plugin (`index.js`) only reads git facts for prompt
 * interpolation. This plugin gives the agent three actions that change
 * repository state:
 *
 * - `create_worktree` adds a branch and checkout and moves the session into it.
 * - `merge_worktree` merges a committed worktree branch into a branch that is
 *   checked out in another worktree.
 * - `archive_worktree` removes a worktree checkout after its work is committed.
 *
 * Two constraints shape the implementation:
 *
 * - The package imports Node builtins only. A profile-installed bundle cannot
 *   resolve dependencies that live in the dsh installation, so the tools are
 *   registered as plain definitions through `ctx.tools` and use
 *   `ctx.workingDirectory` by service name. No `@deepseek-ai/*` import is
 *   required.
 * - New checkouts stay inside the session workspace. The file sandbox's
 *   `workspace-write` root is the session's original directory, so a checkout
 *   outside that root would be readable but not writable through the fs tools.
 *   The default location is `<repository>/.worktrees/<branch>`; a session that
 *   started in a subdirectory uses that subdirectory instead. The directory is
 *   added to `.git/info/exclude` so the primary checkout stays clean.
 *
 * Every mutating git command disables hooks for the duration of the call. The
 * tools never fetch, push, force-push, or rewrite history. Merge conflicts are
 * aborted and reported; archive refuses uncommitted work unless `force` is set.
 * All three tools refuse to run under the read-only file policy.
 *
 * @module @zilorn/dsh-efficient-mode/worktree
 */

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Cordis plugin name. */
export const name = 'worktree-tools'

/** Services used to register tools and change the session directory. */
export const inject = ['tools', 'workingDirectory', 'sandboxPolicy']

/** Default per-command deadline, large enough for a cold checkout. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Default captured stdout/stderr budget per command. */
const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024

/** Directory (relative to a repository or workspace) that holds checkouts. */
const DEFAULT_DIRECTORY = '.worktrees'

/** Prefix for generated branch and checkout names. */
const DEFAULT_NAME_PREFIX = 'worktree-'

/** Longest branch name accepted from the model. */
const MAX_BRANCH_LENGTH = 255

/** Longest revision or path accepted from the model. */
const MAX_REVISION_LENGTH = 1024
const MAX_PATH_LENGTH = 4096

/** Git configuration that keeps a tool call non-interactive and hook-free. */
const MUTATION_CONFIG = ['-c', 'core.hooksPath=', '-c', 'core.fsmonitor=false']

/** Stand-in for a branch that a detached worktree does not have. */
const NO_BRANCH = ''

/**
 * Read and validate the optional row config.
 * @param config - the loader row's config, if any.
 * @returns normalized options for every registered tool.
 */
function resolveOptions(config) {
  const directory = config?.directory ?? DEFAULT_DIRECTORY
  if (!isRelativeDirectory(directory)) {
    throw new Error('worktree-tools: directory must be a relative path without dot segments')
  }
  const namePrefix = config?.namePrefix ?? DEFAULT_NAME_PREFIX
  if (typeof namePrefix !== 'string' || namePrefix.length === 0 || namePrefix.startsWith('-')) {
    throw new Error('worktree-tools: namePrefix must be a non-empty string that does not start with a dash')
  }
  const gitCommand = config?.gitCommand ?? 'git'
  if (typeof gitCommand !== 'string' || gitCommand.trim().length === 0) {
    throw new Error('worktree-tools: gitCommand must be a non-empty string')
  }
  const timeoutMs = positiveInteger(config?.timeoutMs, DEFAULT_TIMEOUT_MS, 'timeoutMs')
  const maxOutputBytes = positiveInteger(config?.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 'maxOutputBytes')
  return { directory, namePrefix, gitCommand, timeoutMs, maxOutputBytes }
}

/**
 * Read a positive integer option.
 * @param value - the supplied value, if any.
 * @param fallback - value to use when omitted.
 * @param key - option name for the error message.
 * @returns the validated integer.
 */
function positiveInteger(value, fallback, key) {
  if (value === undefined) return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`worktree-tools: ${key} must be a positive integer`)
  }
  return number
}

/**
 * Test a configured relative directory.
 * @param value - candidate directory.
 * @returns whether it is a relative path with no empty, dot, or parent segments.
 */
function isRelativeDirectory(value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) return false
  if (value.includes('\0') || value.includes(':') || value.startsWith('-')) return false
  return value.split(/[\\/]/).every((part) => part.length > 0 && part !== '.' && part !== '..')
}

/**
 * Run one git command.
 * @param options - resolved plugin options.
 * @param cwd - directory the command runs in.
 * @param args - git arguments, without the executable name.
 * @param signal - caller cancellation.
 * @param allowFailure - resolve a non-zero exit instead of rejecting.
 * @returns the command result.
 */
function runGit(options, cwd, args, signal, allowFailure = false) {
  return new Promise((resolvePromise, reject) => {
    execFile(options.gitCommand, ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      windowsHide: true,
      signal,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_MERGE_AUTOEDIT: 'no',
      },
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolvePromise({ ok: true, code: 0, stdout, stderr })
        return
      }
      if (allowFailure) {
        resolvePromise({
          ok: false,
          code: typeof error.code === 'number' ? error.code : 1,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          error,
        })
        return
      }
      reject(gitFailure(options, args, error, stdout, stderr))
    })
  })
}

/**
 * Build a model-readable git failure without leaking an unbounded output dump.
 * @param options - resolved plugin options.
 * @param args - git arguments.
 * @param error - the child-process error.
 * @param stdout - captured stdout.
 * @param stderr - captured stderr.
 * @returns the error to reject with.
 */
function gitFailure(options, args, error, stdout, stderr) {
  if (error?.code === 'ENOENT') {
    return new Error(`worktree-tools: git executable not found: ${options.gitCommand}`)
  }
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return error
  const detail = truncate(`${stderr || stdout || error?.message || ''}`.trim(), 4000)
  const status = typeof error?.code === 'number' ? ` (exit ${error.code})` : ''
  return new Error(`git ${args.join(' ')} failed${status}${detail.length > 0 ? `: ${detail}` : ''}`)
}

/**
 * Keep a message bounded.
 * @param text - source text.
 * @param limit - maximum characters.
 * @returns the text, with a truncation marker when shortened.
 */
function truncate(text, limit) {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... (truncated)`
}

/**
 * Run a mutating git command with hooks disabled.
 * @param options - resolved plugin options.
 * @param cwd - directory the command runs in.
 * @param args - git arguments after the configuration overrides.
 * @param signal - caller cancellation.
 * @returns the command result.
 */
function runMutation(options, cwd, args, signal) {
  return runGit(options, cwd, [...MUTATION_CONFIG, ...args], signal)
}

/**
 * Parse `git worktree list --porcelain -z`.
 * @param text - NUL-separated porcelain output.
 * @returns one record per worktree, in git's order (the primary checkout first).
 */
function parseWorktrees(text) {
  const records = []
  for (const block of text.split('\0\0')) {
    if (block.length === 0) continue
    let record
    for (const field of block.split('\0')) {
      if (field.length === 0) continue
      const space = field.indexOf(' ')
      const key = space < 0 ? field : field.slice(0, space)
      const value = space < 0 ? '' : field.slice(space + 1)
      if (key === 'worktree') {
        if (record !== undefined) records.push(record)
        record = {
          path: value,
          head: '',
          branch: null,
          bare: false,
          detached: false,
          locked: false,
          prunable: false,
        }
        continue
      }
      if (record === undefined) continue
      if (key === 'HEAD') record.head = value
      else if (key === 'branch') record.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value
      else if (key === 'bare') record.bare = true
      else if (key === 'detached') record.detached = true
      else if (key === 'locked') record.locked = true
      else if (key === 'prunable') record.prunable = true
    }
    if (record !== undefined) records.push(record)
  }
  return records
}

/**
 * Resolve a path through symlinks when it exists.
 * @param path - candidate path.
 * @returns the canonical path, or the resolved absolute path when absent.
 */
function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Test whether one path is the same as, or inside, another.
 * @param parent - candidate ancestor.
 * @param child - candidate descendant.
 * @returns whether child is inside parent.
 */
function isInsideOrEqual(parent, child) {
  let parentPath = resolve(parent)
  let childPath = resolve(child)
  if (process.platform === 'win32') {
    parentPath = parentPath.toLowerCase()
    childPath = childPath.toLowerCase()
  }
  const rel = relative(parentPath, childPath)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Test whether two paths identify the same location.
 * @param first - first path.
 * @param second - second path.
 * @returns whether they are equal and inside the same parent.
 */
function samePath(first, second) {
  let firstPath = resolve(first)
  let secondPath = resolve(second)
  if (process.platform === 'win32') {
    firstPath = firstPath.toLowerCase()
    secondPath = secondPath.toLowerCase()
  }
  return firstPath === secondPath
}

/**
 * Read the repository view for the session's current directory.
 * @param options - resolved plugin options.
 * @param cwd - session's current directory.
 * @param signal - caller cancellation.
 * @returns primary and current worktree records plus every registered checkout.
 */
async function resolveRepository(options, cwd, signal) {
  const inside = await runGit(options, cwd, ['rev-parse', '--is-inside-work-tree'], signal, true)
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    throw new Error(`worktree-tools: not inside a Git working tree: ${cwd}`)
  }
  const list = await runGit(options, cwd, ['worktree', 'list', '--porcelain', '-z'], signal)
  const canonicalCwd = canonicalPath(cwd)
  const records = parseWorktrees(list.stdout).map((record) => ({
    ...record,
    path: canonicalPath(record.path),
  }))
  if (records.length === 0) throw new Error(`worktree-tools: git reported no worktrees for ${cwd}`)
  const primary = records[0]
  const current = records
    .filter((record) => isInsideOrEqual(record.path, canonicalCwd))
    .sort((first, second) => second.path.length - first.path.length)[0]
  return { cwd: canonicalCwd, records, primary, current }
}

/**
 * Normalize a branch name supplied by the model.
 * @param value - raw branch name.
 * @param field - argument name for error messages.
 * @returns the branch name without a `refs/heads/` prefix.
 */
function normalizeBranch(value, field = 'branch') {
  if (typeof value !== 'string') throw new Error(`worktree-tools: ${field} must be a string`)
  let branch = value.trim()
  if (branch.startsWith('refs/heads/')) branch = branch.slice('refs/heads/'.length)
  if (branch.length === 0) throw new Error(`worktree-tools: ${field} must not be empty`)
  if (branch.length > MAX_BRANCH_LENGTH) throw new Error(`worktree-tools: ${field} is too long`)
  if (branch === 'HEAD' || branch === '@') throw new Error(`worktree-tools: ${field} cannot be ${branch}`)
  if (branch.startsWith('-')) throw new Error(`worktree-tools: ${field} must not start with a dash`)
  if (branch.includes('\\')) throw new Error(`worktree-tools: ${field} must use forward slashes only`)
  return branch
}

/**
 * Validate a new branch name with git's own ref grammar.
 * @param options - resolved plugin options.
 * @param repo - repository view.
 * @param branch - branch name.
 * @param signal - caller cancellation.
 * @returns when the name is valid.
 */
async function validateNewBranch(options, repo, branch, signal) {
  if (branch.includes('@{')) throw new Error(`worktree-tools: invalid branch name: ${branch}`)
  const check = await runGit(options, repo.primary.path, ['check-ref-format', '--branch', branch], signal, true)
  if (!check.ok) {
    const detail = truncate((check.stderr || check.stdout).trim(), 1000)
    throw new Error(`worktree-tools: invalid branch name ${JSON.stringify(branch)}${detail.length > 0 ? `: ${detail}` : ''}`)
  }
}

/**
 * Generate a branch name that is also a safe relative checkout path.
 * @param options - resolved plugin options.
 * @returns a unique branch name.
 */
function generateBranch(options) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${options.namePrefix}${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * Choose the managed checkout directory for this session.
 *
 * The file sandbox uses the session's immutable header directory as its
 * workspace-write root, so the chosen directory must stay inside it. When the
 * repository is inside that root, the pool is `<repository>/<directory>`. When
 * the session started in a subdirectory of the repository, the pool is
 * `<session-root>/<directory>`, which is still inside the repository. When the
 * two are unrelated, a repository-named subdirectory of the session root keeps
 * multiple repositories apart.
 * @param options - resolved plugin options.
 * @param repo - repository view.
 * @param agent - calling agent.
 * @returns the pool directory and whether it is inside the repository.
 */
function managedDirectory(options, repo, agent) {
  const header = agent?.session?.header?.cwd
  const workspace = typeof header === 'string' && isAbsolute(header) ? canonicalPath(header) : repo.primary.path
  if (isInsideOrEqual(workspace, repo.primary.path)) {
    return { path: join(repo.primary.path, options.directory), insideRepo: true }
  }
  if (isInsideOrEqual(repo.primary.path, workspace)) {
    return { path: join(workspace, options.directory), insideRepo: true }
  }
  return { path: join(workspace, options.directory, repoSlug(repo.primary.path)), insideRepo: false }
}

/**
 * Build a stable directory name for a repository outside the session root.
 * @param repositoryRoot - canonical repository root.
 * @returns a basename plus a short digest.
 */
function repoSlug(repositoryRoot) {
  const base = basename(repositoryRoot).replace(/[^A-Za-z0-9._-]+/g, '-') || 'repo'
  const digest = createHash('sha256').update(repositoryRoot).digest('hex').slice(0, 8)
  return `${base}-${digest}`
}

/**
 * Resolve a model-supplied path against the current directory.
 * @param value - path text.
 * @param cwd - current directory.
 * @param field - argument name for error messages.
 * @returns an absolute path.
 */
function resolveUserPath(value, cwd, field = 'path') {
  if (typeof value !== 'string') throw new Error(`worktree-tools: ${field} must be a string`)
  const path = value.trim()
  if (path.length === 0) throw new Error(`worktree-tools: ${field} must not be empty`)
  if (path.length > MAX_PATH_LENGTH) throw new Error(`worktree-tools: ${field} is too long`)
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

/**
 * Reject a checkout destination that would escape the session workspace or
 * write into git metadata.
 * @param agent - calling agent.
 * @param repo - repository view.
 * @param destination - proposed checkout path.
 * @param mode - active file-policy mode.
 * @returns when the path is acceptable.
 */
function assertDestinationAllowed(agent, repo, destination, mode) {
  const header = agent?.session?.header?.cwd
  const workspace = typeof header === 'string' && isAbsolute(header) ? canonicalPath(header) : repo.primary.path
  if (mode !== 'danger-full-access' && !isInsideOrEqual(workspace, destination)) {
    throw new Error(
      `worktree-tools: checkout path must stay inside the session workspace ${JSON.stringify(workspace)}; `
      + 'omit path to use the managed .worktrees directory',
    )
  }
  if (destination.split(sep).includes('.git')) {
    throw new Error('worktree-tools: checkout path must not contain a .git segment')
  }
  if (samePath(destination, repo.primary.path)) {
    throw new Error('worktree-tools: checkout path must not be the primary checkout')
  }
}

/**
 * Add the managed pool to the repository's local exclude file, best effort.
 * @param options - resolved plugin options.
 * @param repo - repository view.
 * @param pool - managed pool directory.
 * @param signal - caller cancellation.
 * @returns whether git now treats a probe path inside the pool as ignored.
 */
async function ensureExcluded(options, repo, pool, signal) {
  if (!isInsideOrEqual(repo.primary.path, pool)) return false
  const rel = relative(repo.primary.path, pool).split(sep).join('/')
  if (rel.length === 0 || rel.startsWith('..')) return false
  const common = await runGit(options, repo.primary.path, ['rev-parse', '--git-common-dir'], signal, true)
  if (!common.ok) return false
  const commonDir = resolve(repo.primary.path, common.stdout.trim())
  const ignoreFile = join(commonDir, 'info', 'exclude')
  try {
    const existing = existsSync(ignoreFile) ? readFileSync(ignoreFile, 'utf8') : ''
    const already = existing.split(/\r?\n/).some((line) => {
      const text = line.trim()
      return text === rel || text === `${rel}/`
    })
    if (!already) {
      const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
      mkdirSync(dirname(ignoreFile), { recursive: true })
      appendFileSync(ignoreFile, `${existing}${separator}${rel}/\n`)
    }
    const probe = await runGit(options, repo.primary.path, ['check-ignore', '-q', '--', join(pool, '.probe')], signal, true)
    return probe.ok
  } catch {
    return false
  }
}

/**
 * Resolve a revision to a commit in a specific worktree.
 * @param options - resolved plugin options.
 * @param cwd - worktree to resolve in.
 * @param revision - local commit, branch, or tag.
 * @param signal - caller cancellation.
 * @returns the full commit id.
 */
async function resolveCommit(options, cwd, revision, signal) {
  const result = await runGit(options, cwd, ['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`], signal, true)
  if (!result.ok) {
    const detail = truncate((result.stderr || result.stdout).trim(), 2000)
    throw new Error(`worktree-tools: cannot resolve ${JSON.stringify(revision)} to a local commit${detail.length > 0 ? `: ${detail}` : ''}`)
  }
  return result.stdout.trim()
}

/**
 * Read a worktree's HEAD commit.
 * @param options - resolved plugin options.
 * @param cwd - worktree.
 * @param signal - caller cancellation.
 * @returns the full commit id.
 */
async function headCommit(options, cwd, signal) {
  return resolveCommit(options, cwd, 'HEAD', signal)
}

/**
 * Require a clean worktree before a merge or archive.
 * @param options - resolved plugin options.
 * @param cwd - worktree to inspect.
 * @param label - role in the error message.
 * @param signal - caller cancellation.
 * @returns when the worktree is clean.
 */
async function requireClean(options, cwd, label, signal) {
  const status = await runGit(options, cwd, ['status', '--porcelain=v1', '--untracked-files=normal'], signal)
  if (status.stdout.trim().length > 0) {
    throw new Error(
      `${label} worktree has uncommitted changes. Commit or discard them before continuing:\n`
      + truncate(status.stdout.trim(), 4000),
    )
  }
}

/**
 * Test whether one commit is an ancestor of another.
 * @param options - resolved plugin options.
 * @param cwd - repository worktree.
 * @param ancestor - candidate ancestor.
 * @param descendant - candidate descendant.
 * @param signal - caller cancellation.
 * @returns whether ancestor is contained in descendant.
 */
async function isAncestor(options, cwd, ancestor, descendant, signal) {
  const result = await runGit(options, cwd, ['merge-base', '--is-ancestor', ancestor, descendant], signal, true)
  if (result.ok) return true
  if (result.code === 1) return false
  const detail = truncate((result.stderr || result.stdout).trim(), 2000)
  throw new Error(`worktree-tools: cannot compare ${ancestor} and ${descendant}${detail.length > 0 ? `: ${detail}` : ''}`)
}

/**
 * Test whether a git directory currently records an in-progress merge.
 * @param options - resolved plugin options.
 * @param cwd - target worktree.
 * @param signal - caller cancellation.
 * @returns whether MERGE_HEAD exists.
 */
async function hasMergeHead(options, cwd, signal) {
  const result = await runGit(options, cwd, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], signal, true)
  return result.ok
}

/**
 * Select the source worktree for a merge or archive.
 * @param repo - repository view.
 * @param args - normalized arguments.
 * @param cwd - session's current directory.
 * @returns the matching non-bare worktree.
 */
function selectSource(repo, args, cwd) {
  let candidates = repo.records.filter((record) => !record.bare)
  if (args.branch !== undefined) {
    const branch = normalizeBranch(args.branch)
    candidates = candidates.filter((record) => record.branch === branch)
  }
  if (args.path !== undefined) {
    const path = canonicalPath(resolveUserPath(args.path, cwd))
    candidates = candidates.filter((record) => samePath(record.path, path))
  }
  if (args.branch === undefined && args.path === undefined) {
    if (repo.current !== undefined) return repo.current
    throw new Error(`worktree-tools: no worktree contains the current directory ${JSON.stringify(cwd)}; pass branch or path`)
  }
  if (candidates.length === 0) {
    const wanted = [args.branch === undefined ? undefined : `branch ${args.branch}`, args.path === undefined ? undefined : `path ${args.path}`]
      .filter((value) => value !== undefined).join(' and ')
    throw new Error(`worktree-tools: no registered worktree matches ${wanted}`)
  }
  if (candidates.length > 1) {
    throw new Error('worktree-tools: more than one worktree matches; pass branch or path to disambiguate')
  }
  return candidates[0]
}

/**
 * Select the target worktree for a merge.
 * @param repo - repository view.
 * @param args - normalized arguments.
 * @returns the target worktree.
 */
function selectTarget(repo, args) {
  if (args.into !== undefined) {
    const branch = normalizeBranch(args.into, 'into')
    const target = repo.records.find((record) => !record.bare && record.branch === branch)
    if (target === undefined) {
      throw new Error(`worktree-tools: target branch ${JSON.stringify(branch)} is not checked out in any worktree; check it out first`)
    }
    return target
  }
  const primary = repo.primary
  if (primary.bare) throw new Error('worktree-tools: the primary checkout is bare; pass into to name a checked-out target branch')
  if (primary.branch === null || primary.branch === NO_BRANCH) {
    throw new Error('worktree-tools: the primary checkout is detached; pass into to name a checked-out target branch')
  }
  return primary
}

/**
 * Reject a mutating call under the read-only file policy.
 * @param ctx - plugin context with sandboxPolicy.
 * @param agent - calling agent, whose session selects the policy.
 * @param action - tool name for the error message.
 * @returns the active policy mode.
 */
function requireWritablePolicy(ctx, agent, action) {
  const mode = ctx.sandboxPolicy?.resolve?.({ session: agent.session })?.mode
  if (mode === 'read-only') {
    throw new Error(`worktree-tools: ${action} is blocked by the read-only file policy`)
  }
  if (mode !== 'workspace-write' && mode !== 'danger-full-access') {
    throw new Error(`worktree-tools: ${action} requires a writable file policy, got ${JSON.stringify(mode)}`)
  }
  return mode
}

/**
 * Create a worktree and switch the session into it.
 * @param options - resolved plugin options.
 * @param ctx - plugin context with tools and workingDirectory.
 * @param args - normalized arguments.
 * @param exec - tool execution identity and cancellation.
 * @returns the created checkout details.
 */
async function createWorktree(options, ctx, args, exec) {
  if (exec.agent === undefined) throw new Error('worktree-tools: create_worktree requires a calling agent')
  const agent = exec.agent
  const policy = requireWritablePolicy(ctx, agent, 'create_worktree')
  const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
  const repo = await resolveRepository(options, cwd, exec.signal)
  const branch = args.branch === undefined ? generateBranch(options) : normalizeBranch(args.branch)
  await validateNewBranch(options, repo, branch, exec.signal)
  const existing = await runGit(
    options,
    repo.primary.path,
    ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    exec.signal,
    true,
  )
  if (existing.ok) throw new Error(`worktree-tools: branch already exists: ${branch}`)
  const baseCommit = await resolveCommit(options, cwd, args.from ?? 'HEAD', exec.signal)
  const pool = managedDirectory(options, repo, agent)
  const destination = args.path === undefined
    ? join(pool.path, branch)
    : resolveUserPath(args.path, cwd)
  assertDestinationAllowed(agent, repo, destination, policy)
  if (existsSync(destination)) throw new Error(`worktree-tools: checkout path already exists: ${destination}`)
  mkdirSync(dirname(destination), { recursive: true })
  const ignoreTarget = args.path === undefined || isInsideOrEqual(pool.path, destination)
    ? pool.path
    : destination
  const ignored = await ensureExcluded(options, repo, ignoreTarget, exec.signal)
  try {
    await runMutation(
      options,
      repo.primary.path,
      ['worktree', 'add', '-b', branch, '--', destination, baseCommit],
      exec.signal,
    )
  } catch (error) {
    throw new Error(
      `worktree-tools: could not create worktree ${branch} at ${destination}. `
      + `A branch or partial checkout may remain. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const canonicalDestination = canonicalPath(destination)
  let nextCwd
  try {
    nextCwd = await ctx.workingDirectory.set(agent, canonicalDestination, exec.signal)
  } catch (error) {
    throw new Error(
      `worktree-tools: worktree ${branch} was created at ${canonicalDestination}, `
      + `but switching the session directory failed. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  return {
    path: nextCwd,
    branch,
    baseCommit,
    repositoryRoot: repo.primary.path,
    ignored,
  }
}

/**
 * Merge one committed worktree branch into a checked-out target branch.
 * @param options - resolved plugin options.
 * @param ctx - plugin context.
 * @param args - normalized arguments.
 * @param exec - tool execution identity and cancellation.
 * @returns the merge result.
 */
async function mergeWorktree(options, ctx, args, exec) {
  if (exec.agent === undefined) throw new Error('worktree-tools: merge_worktree requires a calling agent')
  requireWritablePolicy(ctx, exec.agent, 'merge_worktree')
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
  const repo = await resolveRepository(options, cwd, exec.signal)
  const source = selectSource(repo, args, cwd)
  if (source.bare) throw new Error('worktree-tools: cannot merge from a bare checkout')
  if (samePath(source.path, repo.primary.path)) {
    throw new Error('worktree-tools: the source is the primary checkout; pass branch or path to name a worktree')
  }
  if (source.branch === null || source.branch === NO_BRANCH) {
    throw new Error('worktree-tools: the source worktree is detached; create or check out a branch before merging')
  }
  const target = selectTarget(repo, args)
  if (samePath(source.path, target.path) || source.branch === target.branch) {
    throw new Error('worktree-tools: source and target must be different branches in different worktrees')
  }
  await requireClean(options, source.path, 'Source', exec.signal)
  await requireClean(options, target.path, 'Target', exec.signal)
  const sourceTip = await headCommit(options, source.path, exec.signal)
  const targetTip = await headCommit(options, target.path, exec.signal)
  if (await isAncestor(options, target.path, sourceTip, targetTip, exec.signal)) {
    return {
      sourceBranch: source.branch,
      sourcePath: source.path,
      targetBranch: target.branch ?? NO_BRANCH,
      targetPath: target.path,
      commit: targetTip,
      alreadyUpToDate: true,
    }
  }
  try {
    await runMutation(
      options,
      target.path,
      ['merge', '--no-ff', '--no-edit', '--no-autostash', '--no-gpg-sign', source.branch],
      exec.signal,
    )
  } catch (error) {
    let aborted = false
    if (await hasMergeHead(options, target.path, exec.signal)) {
      const abort = await runGit(options, target.path, ['merge', '--abort'], exec.signal, true)
      aborted = abort.ok
    }
    const current = await headCommit(options, target.path, exec.signal)
    if (aborted && current !== targetTip) {
      throw new Error(
        `worktree-tools: merge of ${source.branch} into ${target.branch} failed, `
        + `and the target HEAD moved to ${current}. Inspect the target worktree before continuing.`,
        { cause: error },
      )
    }
    throw new Error(
      `worktree-tools: merge of ${source.branch} into ${target.branch} failed${aborted ? ' and was aborted' : ''}. `
      + `The target ${aborted ? 'is unchanged' : 'may need manual inspection'}. `
      + `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const commit = await headCommit(options, target.path, exec.signal)
  return {
    sourceBranch: source.branch,
    sourcePath: source.path,
    targetBranch: target.branch ?? NO_BRANCH,
    targetPath: target.path,
    commit,
    alreadyUpToDate: false,
  }
}

/**
 * Remove a worktree checkout, optionally deleting its branch.
 * @param options - resolved plugin options.
 * @param ctx - plugin context.
 * @param args - normalized arguments.
 * @param exec - tool execution identity and cancellation.
 * @returns the archive result and the session's resulting directory.
 */
async function archiveWorktree(options, ctx, args, exec) {
  if (exec.agent === undefined) throw new Error('worktree-tools: archive_worktree requires a calling agent')
  const agent = exec.agent
  requireWritablePolicy(ctx, agent, 'archive_worktree')
  const cwd = await ctx.workingDirectory.ensure(agent, exec.signal)
  const repo = await resolveRepository(options, cwd, exec.signal)
  const source = selectSource(repo, args, cwd)
  if (source.bare) throw new Error('worktree-tools: cannot archive a bare checkout')
  if (samePath(source.path, repo.primary.path)) {
    throw new Error('worktree-tools: the primary checkout cannot be archived; pass branch or path to name a worktree')
  }
  if (!args.force) await requireClean(options, source.path, 'Worktree', exec.signal)
  const branch = source.branch
  let merged = false
  if (args.deleteBranch && branch !== null) {
    const primaryTip = await headCommit(options, repo.primary.path, exec.signal)
    merged = await isAncestor(options, repo.primary.path, branch, primaryTip, exec.signal)
    if (!merged && !args.force) {
      throw new Error(
        `worktree-tools: branch ${branch} is not merged into the primary checkout. `
        + 'Merge it first, or pass force: true to delete it without a merge check.',
      )
    }
  }
  let nextCwd = cwd
  if (isInsideOrEqual(source.path, cwd)) {
    nextCwd = await ctx.workingDirectory.set(agent, repo.primary.path, exec.signal)
  }
  try {
    await runMutation(
      options,
      repo.primary.path,
      ['worktree', 'remove', ...(args.force ? ['--force'] : []), '--', source.path],
      exec.signal,
    )
  } catch (error) {
    throw new Error(
      `worktree-tools: could not remove worktree ${source.path}. ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  let branchDeleted = false
  if (args.deleteBranch && branch !== null) {
    try {
      await runMutation(
        options,
        repo.primary.path,
        ['branch', args.force ? '-D' : '-d', '--', branch],
        exec.signal,
      )
      branchDeleted = true
    } catch (error) {
      throw new Error(
        `worktree-tools: worktree ${source.path} was removed, but branch ${branch} was not deleted. `
        + `${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
  }
  return {
    path: source.path,
    branch: branch ?? NO_BRANCH,
    detached: branch === null,
    branchDeleted,
    branchRetained: branch !== null && !branchDeleted,
    cwd: nextCwd,
    repositoryRoot: repo.primary.path,
    forced: args.force,
  }
}

/**
 * Read an object argument from the executor.
 * @param args - parsed arguments.
 * @returns the argument record.
 */
function argumentObject(args) {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new Error('worktree-tools: arguments must be an object')
  }
  return args
}

/**
 * Reject arguments the schema does not declare.
 * @param args - argument record.
 * @param allowed - allowed keys.
 * @returns when every key is known.
 */
function assertKeys(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) throw new Error(`worktree-tools: unknown argument ${JSON.stringify(key)}`)
  }
}

/**
 * Read an optional string argument.
 * @param value - supplied value.
 * @param field - argument name.
 * @returns the trimmed value, or undefined when omitted.
 */
function optionalString(value, field) {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`worktree-tools: ${field} must be a string`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`worktree-tools: ${field} must not be empty`)
  if (text.includes('\0')) throw new Error(`worktree-tools: ${field} must not contain NUL bytes`)
  return text
}

/**
 * Read an optional boolean argument.
 * @param value - supplied value.
 * @param field - argument name.
 * @returns the boolean, or false when omitted.
 */
function optionalBoolean(value, field) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error(`worktree-tools: ${field} must be a boolean`)
  return value
}

/**
 * Normalize create_worktree arguments.
 * @param args - parsed arguments.
 * @returns normalized arguments.
 */
function createArgs(args) {
  const object = argumentObject(args)
  assertKeys(object, ['branch', 'from', 'path'])
  const from = optionalString(object.from, 'from')
  if (from !== undefined && from.length > MAX_REVISION_LENGTH) {
    throw new Error(`worktree-tools: from is too long`)
  }
  return {
    branch: optionalString(object.branch, 'branch'),
    from,
    path: optionalString(object.path, 'path'),
  }
}

/**
 * Normalize merge_worktree arguments.
 * @param args - parsed arguments.
 * @returns normalized arguments.
 */
function mergeArgs(args) {
  const object = argumentObject(args)
  assertKeys(object, ['branch', 'path', 'into'])
  return {
    branch: object.branch === undefined ? undefined : normalizeBranch(object.branch),
    path: optionalString(object.path, 'path'),
    into: object.into === undefined ? undefined : normalizeBranch(object.into, 'into'),
  }
}

/**
 * Normalize archive_worktree arguments.
 * @param args - parsed arguments.
 * @returns normalized arguments.
 */
function archiveArgs(args) {
  const object = argumentObject(args)
  assertKeys(object, ['branch', 'path', 'delete_branch', 'force'])
  return {
    branch: object.branch === undefined ? undefined : normalizeBranch(object.branch),
    path: optionalString(object.path, 'path'),
    deleteBranch: optionalBoolean(object.delete_branch, 'delete_branch'),
    force: optionalBoolean(object.force, 'force'),
  }
}

/**
 * Build the canonical text output used by every tool.
 * @param schema - output JSON schema.
 * @returns the output declaration.
 */
function textOutput(schema) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

/**
 * Build the create_worktree definition.
 * @param options - resolved plugin options.
 * @param ctx - plugin context with tools and workingDirectory.
 * @returns the tool definition.
 */
function createTool(options, ctx) {
  return {
    name: 'create_worktree',
    description:
      'Create a new local Git branch and worktree, then move this session into the new checkout. '
      + 'The branch starts at `from` (default HEAD) and no fetch is performed. '
      + 'The checkout lives under the repository\'s .worktrees directory unless `path` is supplied; '
      + 'the managed directory is added to .git/info/exclude. Uncommitted files stay in the source checkout. '
      + 'Make the task changes here, commit them, and report the branch and commit to the user before merging or archiving. '
      + 'Nothing is pushed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branch: { type: 'string', description: 'New branch name. Omit to generate a unique worktree-* name.' },
        from: { type: 'string', description: 'Local commit, branch, or tag to start from. Defaults to HEAD; no fetch.' },
        path: {
          type: 'string',
          description: 'Optional checkout path inside the session workspace; relative paths resolve against the current directory. Defaults to the managed .worktrees directory.',
        },
      },
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'branch', 'baseCommit', 'repositoryRoot', 'ignored'],
      properties: {
        path: { type: 'string', description: 'Canonical checkout path and the session\'s new working directory.' },
        branch: { type: 'string' },
        baseCommit: { type: 'string' },
        repositoryRoot: { type: 'string', description: 'Primary checkout of the source repository.' },
        ignored: { type: 'boolean', description: 'Whether git now ignores the managed directory.' },
      },
    }),
    async execute(args, exec) {
      return createWorktree(options, ctx, createArgs(args), exec)
    },
  }
}

/**
 * Build the merge_worktree definition.
 * @param options - resolved plugin options.
 * @param ctx - plugin context with tools and workingDirectory.
 * @returns the tool definition.
 */
function mergeTool(options, ctx) {
  return {
    name: 'merge_worktree',
    description:
      'Merge a committed worktree branch into a branch checked out in another worktree. '
      + 'The source defaults to the worktree containing the current directory; the target defaults to '
      + 'the primary checkout\'s current branch. Both worktrees must be clean. The merge is --no-ff, '
      + 'a conflict is aborted instead of left in progress, and nothing is pushed. '
      + 'Use this only after the user approves the worktree result.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branch: { type: 'string', description: 'Source branch to merge. Omit when the current directory is inside the source worktree.' },
        path: { type: 'string', description: 'Source worktree path. Omit when the current directory is inside the source worktree.' },
        into: { type: 'string', description: 'Target branch, which must be checked out in a worktree. Defaults to the primary checkout\'s current branch.' },
      },
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      required: ['sourceBranch', 'sourcePath', 'targetBranch', 'targetPath', 'commit', 'alreadyUpToDate'],
      properties: {
        sourceBranch: { type: 'string' },
        sourcePath: { type: 'string' },
        targetBranch: { type: 'string' },
        targetPath: { type: 'string' },
        commit: { type: 'string', description: 'Target HEAD after the merge, or the existing target HEAD when already up to date.' },
        alreadyUpToDate: { type: 'boolean' },
      },
    }),
    async execute(args, exec) {
      return mergeWorktree(options, ctx, mergeArgs(args), exec)
    },
  }
}

/**
 * Build the archive_worktree definition.
 * @param options - resolved plugin options.
 * @param ctx - plugin context with tools and workingDirectory.
 * @returns the tool definition.
 */
function archiveTool(options, ctx) {
  return {
    name: 'archive_worktree',
    description:
      'Remove a worktree checkout after its work is committed. The branch is kept unless '
      + '`delete_branch` is true; deleting an unmerged branch requires `force`. Uncommitted files '
      + 'also require `force`, which discards them. If this session is inside the worktree, the '
      + 'session moves back to the primary checkout first. Use this only after the user approves cleanup. '
      + 'Nothing is pushed.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        branch: { type: 'string', description: 'Worktree branch to archive. Omit when the current directory is inside it.' },
        path: { type: 'string', description: 'Worktree path to archive. Omit when the current directory is inside it.' },
        delete_branch: { type: 'boolean', description: 'Delete the branch after removing the checkout. Defaults to false.' },
        force: { type: 'boolean', description: 'Discard uncommitted files and allow deleting an unmerged branch. Defaults to false.' },
      },
    },
    output: textOutput({
      type: 'object',
      additionalProperties: false,
      required: ['path', 'branch', 'detached', 'branchDeleted', 'branchRetained', 'cwd', 'repositoryRoot', 'forced'],
      properties: {
        path: { type: 'string', description: 'Removed checkout path.' },
        branch: { type: 'string', description: 'Branch name, or an empty string for a detached worktree.' },
        detached: { type: 'boolean' },
        branchDeleted: { type: 'boolean' },
        branchRetained: { type: 'boolean' },
        cwd: { type: 'string', description: 'Session working directory after the archive.' },
        repositoryRoot: { type: 'string' },
        forced: { type: 'boolean' },
      },
    }),
    async execute(args, exec) {
      return archiveWorktree(options, ctx, archiveArgs(args), exec)
    },
  }
}

/**
 * Register the worktree tools for the mounting preset.
 * @param ctx - preset scope with `tools` and `workingDirectory` injected.
 * @param config - optional row config.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  ctx.tools.register(createTool(options, ctx))
  ctx.tools.register(mergeTool(options, ctx))
  ctx.tools.register(archiveTool(options, ctx))
}
