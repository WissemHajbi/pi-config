import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function humanizeBranchName(branch: string): string {
  const cleaned = branch
    .replace(/^origin\//, "")
    .replace(/^(feature|fix|hotfix|chore|docs|refactor|test|ci|build|perf|style)\//i, "")
    .replace(/[._/-]+/g, " ")
    .replace(/\b\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return cleaned ? titleCase(cleaned) : branch;
}

function stripConventionalPrefix(subject: string): string {
  return subject
    .replace(/^(feat|fix|docs|chore|refactor|test|ci|perf|build|style|revert)(\([^)]+\))?:\s*/i, "")
    .replace(/[.]+$/, "")
    .trim();
}

function shorten(text: string, max = 72): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function remoteToGitHubBase(remoteUrl: string): string | null {
  const sshLikeMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshLikeMatch) return `https://${sshLikeMatch[1]}/${sshLikeMatch[2]}/${sshLikeMatch[3]}`;

  const urlMatch = remoteUrl.match(/^(?:https?:\/\/|ssh:\/\/git@)([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (urlMatch) return `https://${urlMatch[1]}/${urlMatch[2]}/${urlMatch[3]}`;

  return null;
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal) {
  return pi.exec("git", args, { cwd, signal });
}

async function openUrl(pi: ExtensionAPI, cwd: string, url: string, signal?: AbortSignal) {
  return pi.exec("cmd.exe", ["/c", "start", "", `"${url}"`], { cwd, signal });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("pr", {
    description: "Open the GitHub PR creation page from the current branch",
    handler: async (_args, ctx) => {
      const current = firstLine((await git(pi, ctx.cwd, ["branch", "--show-current"], ctx.signal)).stdout);
      if (!current) {
        ctx.ui.notify("Detached HEAD; checkout a branch first.", "warning");
        return;
      }

      const branchesResult = await git(pi, ctx.cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], ctx.signal);
      const localBranches = branchesResult.stdout
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean)
        .filter((b) => b !== current);

      const remoteBranchesResult = await git(pi, ctx.cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], ctx.signal);
      const remoteBranches = remoteBranchesResult.stdout
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean)
        .map((b) => b.replace(/^origin\//, ""))
        .filter((b) => b && b !== "HEAD" && b !== current);

      const remoteHeadResult = await git(pi, ctx.cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], ctx.signal);
      const defaultRemoteBranch = firstLine(remoteHeadResult.stdout).replace(/^origin\//, "");

      const branchChoices = Array.from(new Set([defaultRemoteBranch, ...remoteBranches, ...localBranches]))
        .filter(Boolean)
        .filter((branch) => branch !== current)
        .sort((a, b) => {
          if (a === defaultRemoteBranch) return -1;
          if (b === defaultRemoteBranch) return 1;
          return a.localeCompare(b);
        });

      if (branchChoices.length === 0) {
        ctx.ui.notify("No target branches found.", "warning");
        return;
      }

      const target = await ctx.ui.select("Open PR into which branch?", branchChoices);
      if (!target) return;

      if (target === current) {
        ctx.ui.notify("Target branch must be different from the current branch.", "warning");
        return;
      }

      const mergeBaseResult = await git(pi, ctx.cwd, ["merge-base", target, current], ctx.signal);
      const mergeBase = firstLine(mergeBaseResult.stdout);
      if (!mergeBase) {
        ctx.ui.notify(`Could not find merge-base between ${current} and ${target}.`, "error");
        return;
      }

      const aheadCountResult = await git(pi, ctx.cwd, ["rev-list", "--count", `${target}..${current}`], ctx.signal);
      const aheadCount = Number.parseInt(firstLine(aheadCountResult.stdout), 10);
      if (!Number.isFinite(aheadCount) || aheadCount <= 0) {
        ctx.ui.notify(`No commits to open in a PR from ${current} to ${target}.`, "warning");
        return;
      }

      const subjectsResult = await git(pi, ctx.cwd, ["log", "--format=%s", `${mergeBase}..${current}`], ctx.signal);
      const subjects = subjectsResult.stdout
        .split(/\r?\n/)
        .map((s) => stripConventionalPrefix(firstLine(s)))
        .filter(Boolean);

      const latestSubject = subjects[0] ?? "";
      const titleCandidate = latestSubject && !/^(wip|tmp|draft|update|misc|merge\b|bump\b)(\b|:)/i.test(latestSubject)
        ? latestSubject
        : humanizeBranchName(current);
      const title = shorten(titleCandidate, 72);

      const statResult = await git(pi, ctx.cwd, ["diff", "--shortstat", `${target}...${current}`], ctx.signal);
      const stat = firstLine(statResult.stdout);
      const recentChanges = subjects.slice(0, 3);

      const bodyLines = [
        "Summary",
        `${title}.`,
        "",
        "Changes",
        ...(recentChanges.length > 0 ? recentChanges.map((subject) => `- ${subject}`) : ["- Changes ready for review"]),
        ...(stat ? [`- ${stat}`] : []),
        "",
        "Testing",
        "- Not run",
      ];
      const body = bodyLines.join("\n");

      const upstreamResult = await git(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], ctx.signal);
      if (upstreamResult.code !== 0) {
        const originResult = await git(pi, ctx.cwd, ["remote", "get-url", "origin"], ctx.signal);
        if (originResult.code !== 0) {
          ctx.ui.notify("No here upstream branch and no origin remote found.", "error");
          return;
        }

        const pushResult = await git(pi, ctx.cwd, ["push", "-u", "origin", current], ctx.signal);
        if (pushResult.code !== 0) {
          ctx.ui.notify(pushResult.stderr.trim() || "Failed to push current branch.", "error");
          return;
        }
      }

      const originResult = await git(pi, ctx.cwd, ["remote", "get-url", "origin"], ctx.signal);
      const githubBase = firstLine(originResult.stdout) ? remoteToGitHubBase(firstLine(originResult.stdout)) : null;
      if (!githubBase) {
        ctx.ui.notify("origin remote is not a GitHub URL.", "error");
        return;
      }

      const compareUrl = `${githubBase}/compare/${encodeURIComponent(target)}...${encodeURIComponent(current)}?expand=1&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
      ctx.ui.notify(`Opening PR page for ${current} → ${target}...`, "info");
      const openResult = await openUrl(pi, ctx.cwd, compareUrl, ctx.signal);
      if (openResult.code !== 0) {
        ctx.ui.notify(compareUrl, "warning");
        return;
      }

      ctx.ui.notify("PR page opened in your browser.", "success");
    },
  });
}
