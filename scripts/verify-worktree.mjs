#!/usr/bin/env node
/**
 * Integration check for the worktree tools.
 *
 * The test owns a temporary Git repository and a stub Cordis context, then calls
 * the registered tools exactly as the model would. It covers the complete
 * worktree lifecycle and the two safety paths:
 *
 * 1. `create_worktree` creates the branch/checkout, switches the session, and
 *    excludes the managed pool from the primary checkout.
 * 2. A commit in the checkout merges into the primary branch with a real merge
 *    commit.
 * 3. A dirty archive is refused.
 * 4. A conflicting merge is aborted and leaves the target HEAD and files
 *    unchanged.
 * 5. `archive_worktree` removes the checkout, moves the session back, and can
 *    delete a merged branch.
 *
 * Exits non-zero on any failure. Usage: node scripts/verify-worktree.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../worktree.js'

/**
 * Run git and fail on a non-zero exit.
 * @param cwd - repository or worktree directory.
 * @param args - git arguments.
 * @returns trimmed stdout.
 */
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim()
}

/**
 * Run git and return its status without throwing.
 * @param cwd - repository or worktree directory.
 * @param args - git arguments.
 * @returns the raw process result.
 */
function gitResult(cwd, args) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

/**
 * Create a repository with one commit on `main`.
 * @returns the canonical repository root.
 */
function createRepository() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-worktree-verify-')))
  git(root, ['init', '-q', '-b', 'main'])
  git(root, ['config', 'user.name', 'Worktree Verifier'])
  git(root, ['config', 'user.email', 'worktree@example.invalid'])
  writeFileSync(join(root, 'a.txt'), 'base\n')
  git(root, ['add', 'a.txt'])
  git(root, ['commit', '-qm', 'test: initial commit'])
  return root
}

/**
 * Build a stub context and the three tools.
 * @param root - repository root and immutable session header cwd.
 * @returns the tools, a mutable session cwd, and a call helper.
 */
function createHarness(root, mode = 'workspace-write') {
  const tools = new Map()
  let cwd = root
  const ctx = {
    tools: {
      register(definition) {
        if (tools.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    workingDirectory: {
      async ensure(_agent, signal) {
        signal?.throwIfAborted()
        return cwd
      },
      async set(_agent, path, signal) {
        signal?.throwIfAborted()
        cwd = realpathSync.native(path)
        return cwd
      },
    },
    sandboxPolicy: {
      resolve: () => ({ mode }),
    },
  }
  apply(ctx, {})
  const agent = { id: 'worktree-verifier', session: { header: { cwd: root } } }
  return {
    tools,
    get cwd() {
      return cwd
    },
    async call(name, args) {
      const definition = tools.get(name)
      assert(definition, `tool ${name} was not registered`)
      return definition.execute(args, {
        agent,
        signal: AbortSignal.timeout(30_000),
      })
    },
  }
}

const root = createRepository()
try {
  const harness = createHarness(root)
  const readOnly = createHarness(root, 'read-only')
  await assert.rejects(
    readOnly.call('create_worktree', { branch: 'feat/read-only' }),
    /read-only file policy/,
    'read-only policy must block worktree creation',
  )

  const created = await harness.call('create_worktree', { branch: 'feat/test' })
  assert.equal(created.branch, 'feat/test')
  assert.equal(created.path, join(root, '.worktrees', 'feat', 'test'))
  assert.equal(created.repositoryRoot, root)
  assert.equal(created.ignored, true, 'managed .worktrees directory must be excluded')
  assert(existsSync(created.path), 'checkout directory must exist')
  assert.equal(harness.cwd, created.path, 'session must enter the new checkout')
  assert.equal(git(created.path, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/test')
  assert.equal(git(created.path, ['rev-parse', 'HEAD']), created.baseCommit)
  assert.equal(git(root, ['status', '--porcelain']), '', 'primary checkout must stay clean')

  writeFileSync(join(created.path, 'b.txt'), 'feature\n')
  git(created.path, ['add', 'b.txt'])
  git(created.path, ['commit', '-qm', 'test: add feature file'])

  const merged = await harness.call('merge_worktree', {})
  assert.equal(merged.sourceBranch, 'feat/test')
  assert.equal(merged.targetBranch, 'main')
  assert.equal(merged.alreadyUpToDate, false)
  assert.equal(existsSync(join(root, 'b.txt')), true, 'merge must reach the primary checkout')
  const parents = git(root, ['rev-list', '--parents', '-n1', merged.commit]).split(/\s+/)
  assert.equal(parents.length, 3, '--no-ff merge must create a two-parent commit')
  assert.equal(git(root, ['status', '--porcelain']), '')

  writeFileSync(join(created.path, 'a.txt'), 'uncommitted\n')
  await assert.rejects(
    harness.call('archive_worktree', {}),
    /uncommitted changes/,
    'archive must refuse a dirty checkout',
  )
  git(created.path, ['checkout', '--', 'a.txt'])

  const archived = await harness.call('archive_worktree', { delete_branch: true })
  assert.equal(archived.branchDeleted, true)
  assert.equal(archived.branchRetained, false)
  assert.equal(archived.cwd, root)
  assert.equal(harness.cwd, root, 'session must return to the primary checkout')
  assert.equal(existsSync(created.path), false, 'archived checkout must be removed')
  assert.equal(git(root, ['branch', '--list', 'feat/test']), '', 'merged branch must be deleted')

  const keep = await harness.call('create_worktree', { branch: 'feat/keep' })
  const kept = await harness.call('archive_worktree', {})
  assert.equal(kept.branchRetained, true, 'archive must keep the branch by default')
  assert.equal(kept.branchDeleted, false)
  assert.equal(harness.cwd, root, 'session must return to the primary checkout')
  assert.equal(git(root, ['branch', '--list', 'feat/keep']).trim(), 'feat/keep')
  assert.equal(existsSync(keep.path), false)
  git(root, ['branch', '-D', 'feat/keep'])

  const generated = await harness.call('create_worktree', { path: '.custom/auto' })
  assert.match(generated.branch, /^worktree-\d{8}\d{6}-[0-9a-f]{6}$/)
  assert.equal(generated.path, join(root, '.custom', 'auto'))
  assert.equal(generated.ignored, true, 'custom checkout path must be excluded too')
  assert.equal(git(root, ['status', '--porcelain']), '', 'custom checkout must not dirty the primary')
  const generatedArchive = await harness.call('archive_worktree', { delete_branch: true })
  assert.equal(generatedArchive.branchDeleted, true)

  await assert.rejects(
    harness.call('create_worktree', { branch: 'feat/outside', path: '../outside' }),
    /session workspace/,
    'checkout paths outside the session workspace must be rejected',
  )

  const conflict = await harness.call('create_worktree', { branch: 'feat/conflict' })
  writeFileSync(join(conflict.path, 'a.txt'), 'feature version\n')
  git(conflict.path, ['add', 'a.txt'])
  git(conflict.path, ['commit', '-qm', 'test: feature conflict'])
  writeFileSync(join(root, 'a.txt'), 'main version\n')
  git(root, ['add', 'a.txt'])
  git(root, ['commit', '-qm', 'test: main conflict'])
  const before = git(root, ['rev-parse', 'HEAD'])

  await assert.rejects(
    harness.call('merge_worktree', {}),
    /failed and was aborted/,
    'conflicting merge must be aborted',
  )
  assert.equal(git(root, ['rev-parse', 'HEAD']), before, 'aborted merge must not move target HEAD')
  assert.equal(git(root, ['status', '--porcelain']), '', 'aborted merge must leave no conflict state')
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'main version\n')
  const mergeHead = gitResult(root, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'])
  assert.notEqual(mergeHead.status, 0, 'MERGE_HEAD must be gone after the abort')

  await assert.rejects(
    harness.call('archive_worktree', { delete_branch: true }),
    /not merged/,
    'unmerged branch deletion must be refused',
  )
  const cleanup = await harness.call('archive_worktree', { delete_branch: true, force: true })
  assert.equal(cleanup.branchDeleted, true)
  assert.equal(existsSync(conflict.path), false)
  assert.equal(harness.cwd, root)

  const release = await harness.call('create_worktree', { branch: 'release' })
  const into = await harness.call('create_worktree', { branch: 'feat/into' })
  writeFileSync(join(into.path, 'into.txt'), 'release-only\n')
  git(into.path, ['add', 'into.txt'])
  git(into.path, ['commit', '-qm', 'test: release-only change'])
  const intoMerge = await harness.call('merge_worktree', { into: 'release' })
  assert.equal(intoMerge.sourceBranch, 'feat/into')
  assert.equal(intoMerge.targetBranch, 'release')
  assert.equal(existsSync(join(release.path, 'into.txt')), true, 'into must merge into the named target')
  assert.equal(existsSync(join(root, 'into.txt')), false, 'into must not touch the primary checkout')
  const intoArchive = await harness.call('archive_worktree', { delete_branch: true, force: true })
  assert.equal(intoArchive.branchDeleted, true)
  const releaseArchive = await harness.call('archive_worktree', {
    branch: 'release',
    delete_branch: true,
    force: true,
  })
  assert.equal(releaseArchive.branchDeleted, true)
  assert.equal(harness.cwd, root)

  console.log('worktree tools: create, commit, --no-ff merge, named target, conflict abort, dirty refusal, archive passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
