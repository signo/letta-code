import { execFile as execFileCb } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { promisify } from "node:util";
import { GIT_DISABLE_COMMIT_SIGNING_ARGS } from "@/agent/memory-git-signing";
import { debugLog } from "@/utils/debug";

const execFile = promisify(execFileCb);

const GIT_TIMEOUT_MS = 30_000;
const HARNESS_GIT_ENV = {
  GIT_AUTHOR_NAME: "Letta Code",
  GIT_AUTHOR_EMAIL: "noreply@letta.com",
  GIT_COMMITTER_NAME: "Letta Code",
  GIT_COMMITTER_EMAIL: "noreply@letta.com",
};

interface GitResult {
  stdout: string;
  stderr: string;
}

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const allArgs = [...GIT_DISABLE_COMMIT_SIGNING_ARGS, ...args];
    const { stdout, stderr } = await execFile("git", allArgs, {
      cwd,
      env: {
        ...process.env,
        ...HARNESS_GIT_ENV,
      },
      encoding: "utf-8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 5,
    });
    return {
      stdout: stdout?.toString() ?? "",
      stderr: stderr?.toString() ?? "",
    };
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    const details = [err.message, err.stderr, err.stdout]
      .filter((part): part is string => Boolean(part?.trim()))
      .join("\n");
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}${details ? `: ${details}` : ""}`,
    );
  }
}

async function tryRunGit(
  cwd: string,
  args: string[],
): Promise<GitResult | null> {
  try {
    return await runGit(cwd, args);
  } catch {
    return null;
  }
}

function normalizeGitPath(path: string, cwd: string): string {
  const trimmed = path.trim();
  if (!trimmed) return trimmed;
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

function buildReflectionWorktreeId(now: Date = new Date()): string {
  const timestamp = now
    .toISOString()
    .replace(/[^0-9]/g, "")
    .slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function summarizeReflectionCommitSubject(subject: string): string {
  const summary = subject
    .trim()
    .replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, "")
    .trim();
  return summary || "reflection memory updates";
}

async function buildReflectionMergeMessage(
  parentMemoryDir: string,
  branchName: string,
): Promise<string> {
  const result = await tryRunGit(parentMemoryDir, [
    "log",
    "-1",
    "--pretty=%s",
    branchName,
  ]);
  const summary = summarizeReflectionCommitSubject(result?.stdout ?? "");
  return `merge(reflection): ${summary}`;
}

interface ReflectionTransactionLease {
  version: 1;
  id: string;
  parentAgentId: string;
  parentMemoryDir: string;
  worktreeDir: string;
  branchName: string;
  baseHead: string;
  phase: "staging" | "promoting" | "promoted";
}

const TRANSACTION_LEASE_PREFIX = ".letta-reflection-transaction-";

export interface ReflectionMemoryWorktree {
  id: string;
  parentAgentId: string;
  parentMemoryDir: string;
  worktreeBaseDir: string;
  worktreeDir: string;
  leasePath: string;
  branchName: string;
  baseHead: string;
  gitCommonDir: string;
}

export interface CreateReflectionMemoryWorktreeOptions {
  parentMemoryDir: string;
  /** Stable parent-agent identity used to scope the transaction lease. */
  parentAgentId?: string;
  now?: Date;
}

export async function createReflectionMemoryWorktree(
  options: CreateReflectionMemoryWorktreeOptions,
): Promise<ReflectionMemoryWorktree> {
  const parentMemoryDir = resolve(options.parentMemoryDir);
  const id = buildReflectionWorktreeId(options.now);
  const parentAgentId =
    options.parentAgentId ?? basename(dirname(parentMemoryDir));
  const worktreeBaseDir = join(dirname(parentMemoryDir), "memory-worktrees");
  const worktreeDir = join(worktreeBaseDir, `reflection-${id}`);
  const leasePath = join(
    worktreeBaseDir,
    `${TRANSACTION_LEASE_PREFIX}${id}.json`,
  );
  const branchName = `letta/reflection/${id}`;

  await mkdir(worktreeBaseDir, { recursive: true });

  const { stdout: baseHeadOut } = await runGit(parentMemoryDir, [
    "rev-parse",
    "--verify",
    "HEAD",
  ]);
  const baseHead = baseHeadOut.trim();
  if (!baseHead) {
    throw new Error(
      `Unable to create reflection memory worktree: ${parentMemoryDir} has no HEAD`,
    );
  }

  const lease: ReflectionTransactionLease = {
    version: 1,
    id,
    parentAgentId,
    parentMemoryDir,
    worktreeDir,
    branchName,
    baseHead,
    phase: "staging",
  };
  await writeFile(leasePath, JSON.stringify(lease), {
    encoding: "utf-8",
    flag: "wx",
  });
  try {
    await runGit(parentMemoryDir, [
      "worktree",
      "add",
      worktreeDir,
      "-b",
      branchName,
      baseHead,
    ]);
  } catch (error) {
    await rm(leasePath, { force: true }).catch(() => {});
    throw error;
  }

  const { stdout: commonDirOut } = await runGit(worktreeDir, [
    "rev-parse",
    "--git-common-dir",
  ]);
  const gitCommonDir = normalizeGitPath(commonDirOut, worktreeDir);
  debugLog(
    "memfs-git",
    "reflection worktree created id=%s branch=%s dir=%s parent=%s baseHead=%s gitCommonDir=%s",
    id,
    branchName,
    worktreeDir,
    parentMemoryDir,
    baseHead,
    gitCommonDir,
  );

  return {
    id,
    parentAgentId,
    parentMemoryDir,
    worktreeBaseDir,
    worktreeDir,
    leasePath,
    branchName,
    baseHead,
    gitCommonDir,
  };
}

export interface ReflectionMemoryScope {
  primaryRoot: string;
  writableRoots: string[];
  readonlyRoots: string[];
}

export function buildReflectionMemoryScope(
  worktree: ReflectionMemoryWorktree,
): ReflectionMemoryScope {
  return {
    primaryRoot: worktree.worktreeDir,
    writableRoots: [worktree.worktreeDir, worktree.gitCommonDir],
    readonlyRoots: [dirname(worktree.parentMemoryDir)],
  };
}

export type ReflectionMemoryWorktreeFinalizeStatus =
  | "merged"
  | "no_changes"
  | "pending_conflict"
  | "pending_manual_merge"
  | "dirty_uncommitted"
  | "failed";

export interface ReflectionMemoryWorktreeFinalizeResult {
  status: ReflectionMemoryWorktreeFinalizeStatus;
  parentMemoryDir: string;
  reflectionWorktreeDir: string;
  reflectionBranch: string;
  commitCount: number;
  head?: string;
  summary: string;
  error?: string;
}

export interface PendingReflectionMemoryWorktree {
  id: string;
  parentMemoryDir: string;
  reflectionWorktreeDir: string;
  reflectionBranch: string;
  commitCount: number;
  head?: string;
}

export function reflectionIntegrationConsumesTranscript(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return (
    result.status === "merged" ||
    result.status === "no_changes" ||
    result.status === "pending_conflict" ||
    result.status === "pending_manual_merge"
  );
}

export function reflectionIntegrationNeedsReminder(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return (
    result.status === "pending_conflict" ||
    result.status === "pending_manual_merge"
  );
}

export function reflectionIntegrationShouldRecompile(
  result: ReflectionMemoryWorktreeFinalizeResult,
): boolean {
  return result.status === "merged";
}

async function updateTransactionLease(
  worktree: ReflectionMemoryWorktree,
  phase: ReflectionTransactionLease["phase"],
): Promise<void> {
  const current = JSON.parse(
    readFileSync(worktree.leasePath, "utf-8"),
  ) as ReflectionTransactionLease;
  const next = JSON.stringify({ ...current, phase });
  const temporaryPath = `${worktree.leasePath}.tmp-${randomUUID()}`;
  await writeFile(temporaryPath, next, "utf-8");
  await rename(temporaryPath, worktree.leasePath);
}

async function getStatusPorcelain(cwd: string): Promise<string> {
  const { stdout } = await runGit(cwd, ["status", "--porcelain"]);
  return stdout.trim();
}

async function getCommitCount(
  worktree: ReflectionMemoryWorktree,
): Promise<number> {
  const { stdout } = await runGit(worktree.worktreeDir, [
    "rev-list",
    "--count",
    `${worktree.baseHead}..HEAD`,
  ]);
  return Number.parseInt(stdout.trim(), 10) || 0;
}

async function getHead(cwd: string): Promise<string | undefined> {
  const result = await tryRunGit(cwd, ["rev-parse", "--verify", "HEAD"]);
  const head = result?.stdout.trim();
  return head || undefined;
}

async function getBranchCommitCount(
  parentMemoryDir: string,
  branchName: string,
): Promise<number> {
  const result = await tryRunGit(parentMemoryDir, [
    "rev-list",
    "--count",
    `HEAD..${branchName}`,
  ]);
  return Number.parseInt(result?.stdout.trim() ?? "", 10) || 0;
}

function parseWorktreeListPorcelain(
  output: string,
): Array<{ path: string; head?: string; branch?: string }> {
  const entries: Array<{ path: string; head?: string; branch?: string }> = [];
  for (const block of output.split(/\n\s*\n/)) {
    const entry: { path?: string; head?: string; branch?: string } = {};
    for (const line of block.split("\n")) {
      const separatorIndex = line.indexOf(" ");
      const key = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
      const value = separatorIndex === -1 ? "" : line.slice(separatorIndex + 1);
      if (key === "worktree") entry.path = value;
      if (key === "HEAD") entry.head = value;
      if (key === "branch") entry.branch = value;
    }
    if (!entry.path) continue;
    entries.push({
      path: entry.path,
      ...(entry.head ? { head: entry.head } : {}),
      ...(entry.branch ? { branch: entry.branch } : {}),
    });
  }
  return entries;
}

/**
 * Discards all host-owned reflection transactions for one parent agent.
 * This intentionally never merges or resumes a transaction. A lease whose
 * promotion already reached canonical HEAD is simply cleaned up idempotently.
 */
export async function cleanupReflectionTransactions(
  parentMemoryDir: string,
): Promise<number> {
  const resolvedParent = resolve(parentMemoryDir);
  const worktreeBaseDir = join(dirname(resolvedParent), "memory-worktrees");
  let entries: string[];
  try {
    entries = (await readdir(worktreeBaseDir)).filter((entry) =>
      entry.startsWith(TRANSACTION_LEASE_PREFIX),
    );
  } catch {
    return 0;
  }

  let cleaned = 0;
  for (const entry of entries) {
    const leasePath = join(worktreeBaseDir, entry);
    let lease: ReflectionTransactionLease;
    try {
      lease = JSON.parse(
        readFileSync(leasePath, "utf-8"),
      ) as ReflectionTransactionLease;
    } catch {
      await rm(leasePath, { force: true }).catch(() => {});
      continue;
    }
    if (lease.parentMemoryDir !== resolvedParent) continue;
    const worktreeDir = resolve(lease.worktreeDir);
    const relativeWorktree = relative(worktreeBaseDir, worktreeDir);
    if (
      relativeWorktree.startsWith("..") ||
      isAbsolute(relativeWorktree) ||
      !lease.branchName.startsWith("letta/reflection/")
    ) {
      continue;
    }
    if (lease.phase === "promoting") {
      await tryRunGit(resolvedParent, ["merge", "--abort"]);
    }
    await cleanupWorktreeAndBranch(
      resolvedParent,
      worktreeDir,
      lease.branchName,
      { force: true, leasePath },
    );
    cleaned += 1;
  }
  return cleaned;
}

export async function listPendingReflectionMemoryWorktrees(
  parentMemoryDir: string,
): Promise<PendingReflectionMemoryWorktree[]> {
  const resolvedParent = await realpath(resolve(parentMemoryDir));
  const worktreeBaseDir = join(dirname(resolvedParent), "memory-worktrees");
  const worktreeList = await tryRunGit(resolvedParent, [
    "worktree",
    "list",
    "--porcelain",
  ]);
  if (!worktreeList) return [];

  const pending: PendingReflectionMemoryWorktree[] = [];
  for (const entry of parseWorktreeListPorcelain(worktreeList.stdout)) {
    const worktreeDir = normalizeGitPath(entry.path, resolvedParent);
    const relativeWorktreeDir = relative(worktreeBaseDir, worktreeDir);
    if (relativeWorktreeDir.startsWith("..") || isAbsolute(relativeWorktreeDir))
      continue;

    const branchName = entry.branch?.startsWith("refs/heads/")
      ? entry.branch.slice("refs/heads/".length)
      : undefined;
    if (!branchName?.startsWith("letta/reflection/")) continue;

    const isMerged = await tryRunGit(resolvedParent, [
      "merge-base",
      "--is-ancestor",
      branchName,
      "HEAD",
    ]);
    if (isMerged) {
      await cleanupWorktreeAndBranch(resolvedParent, worktreeDir, branchName, {
        force: true,
      });
      debugLog(
        "memfs-git",
        "reflection pending scan cleaned already-merged branch=%s worktree=%s",
        branchName,
        worktreeDir,
      );
      continue;
    }

    pending.push({
      id: branchName.slice("letta/reflection/".length),
      parentMemoryDir: resolvedParent,
      reflectionWorktreeDir: worktreeDir,
      reflectionBranch: branchName,
      commitCount: await getBranchCommitCount(resolvedParent, branchName),
      head: entry.head,
    });
  }

  if (pending.length > 0) {
    debugLog(
      "memfs-git",
      "reflection pending scan found=%d parent=%s branches=%s",
      pending.length,
      resolvedParent,
      pending.map((entry) => entry.reflectionBranch).join(","),
    );
  }

  return pending;
}

export async function integratePendingReflectionMemoryWorktrees(
  parentMemoryDir: string,
): Promise<ReflectionMemoryWorktreeFinalizeResult[]> {
  // Compatibility entry point: restart cleanup is discard-only, never resume.
  await cleanupReflectionTransactions(parentMemoryDir);
  return [];
}

async function cleanupWorktreeAndBranch(
  parentMemoryDir: string,
  worktreeDir: string,
  branchName: string,
  options: { force?: boolean; leasePath?: string } = {},
): Promise<void> {
  const removedWorktree = existsSync(worktreeDir);
  if (removedWorktree) {
    await runGit(parentMemoryDir, [
      "worktree",
      "remove",
      ...(options.force ? ["--force"] : []),
      worktreeDir,
    ]);
  }
  await tryRunGit(parentMemoryDir, [
    "branch",
    options.force ? "-D" : "-d",
    branchName,
  ]);
  const leasePath =
    options.leasePath ??
    join(
      dirname(worktreeDir),
      `${TRANSACTION_LEASE_PREFIX}${basename(worktreeDir).replace(/^reflection-/, "")}.json`,
    );
  await rm(leasePath, { force: true }).catch(() => {});
}

export async function finalizeReflectionMemoryWorktree(
  worktree: ReflectionMemoryWorktree,
  options: { shouldMerge: boolean },
): Promise<ReflectionMemoryWorktreeFinalizeResult> {
  const commitCount = await getCommitCount(worktree);
  const status = await getStatusPorcelain(worktree.worktreeDir);
  const head = await getHead(worktree.worktreeDir);

  if (status.length > 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=dirty_uncommitted commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "dirty_uncommitted",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection memory worktree had uncommitted changes; it was cleaned up so the transcript can be retried.",
    };
  }

  if (commitCount === 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=no_changes cleanedUp=true",
      worktree.id,
    );
    return {
      status: "no_changes",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary: "Reflection made no memory commits.",
    };
  }

  if (!options.shouldMerge) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true },
    );
    debugLog(
      "memfs-git",
      "reflection finalized id=%s status=failed commitCount=%d cleanedUp=true retryable=true",
      worktree.id,
      commitCount,
    );
    return {
      status: "failed",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection produced committed memory updates, but the subagent did not complete successfully; the worktree was cleaned up so the transcript can be retried.",
    };
  }

  const parentStatus = await getStatusPorcelain(worktree.parentMemoryDir);
  if (parentStatus.length > 0) {
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true, leasePath: worktree.leasePath },
    );
    return {
      status: "failed",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection was not promoted because the parent memory repo had uncommitted changes; the transaction was discarded.",
    };
  }

  debugLog(
    "memfs-git",
    "reflection merge attempt id=%s branch=%s parent=%s commitCount=%d",
    worktree.id,
    worktree.branchName,
    worktree.parentMemoryDir,
    commitCount,
  );
  await updateTransactionLease(worktree, "promoting");
  const mergeMessage = await buildReflectionMergeMessage(
    worktree.parentMemoryDir,
    worktree.branchName,
  );
  const mergeResult = await tryRunGit(worktree.parentMemoryDir, [
    "merge",
    worktree.branchName,
    "-m",
    mergeMessage,
  ]);
  if (!mergeResult) {
    await tryRunGit(worktree.parentMemoryDir, ["merge", "--abort"]);
    await cleanupWorktreeAndBranch(
      worktree.parentMemoryDir,
      worktree.worktreeDir,
      worktree.branchName,
      { force: true, leasePath: worktree.leasePath },
    );
    return {
      status: "failed",
      parentMemoryDir: worktree.parentMemoryDir,
      reflectionWorktreeDir: worktree.worktreeDir,
      reflectionBranch: worktree.branchName,
      commitCount,
      head,
      summary:
        "Reflection promotion conflicted; the merge was aborted and the transaction was discarded.",
    };
  }

  await updateTransactionLease(worktree, "promoted");
  const mergedHead = await getHead(worktree.parentMemoryDir);

  await cleanupWorktreeAndBranch(
    worktree.parentMemoryDir,
    worktree.worktreeDir,
    worktree.branchName,
  );
  debugLog(
    "memfs-git",
    "reflection finalized id=%s status=merged commitCount=%d parentHead=%s cleanedUp=true",
    worktree.id,
    commitCount,
    mergedHead ?? "<none>",
  );

  return {
    status: "merged",
    parentMemoryDir: worktree.parentMemoryDir,
    reflectionWorktreeDir: worktree.worktreeDir,
    reflectionBranch: worktree.branchName,
    commitCount,
    head: mergedHead,
    summary: `Merged ${commitCount} reflection memory commit(s) into parent memory main.`,
  };
}
