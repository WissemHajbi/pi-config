import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function firstLine(text: string): string {
  // Git commands often return multi-line output; keep only the first line.
  return text.trim().split(/\r?\n/)[0]?.trim() ?? "";
}

function titleCase(text: string): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

// Turn a branch slug into a readable fallback PR title.
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

// Remove common commit prefixes so the PR copy reads cleanly.
function stripConventionalPrefix(subject: string): string {
  return subject
    .replace(/^:[a-z0-9_+-]+:\s*/i, "")
    .replace(/^(feat|fix|docs|chore|refactor|test|ci|perf|build|style|revert)(\([^)]+\))?:\s*/i, "")
    .replace(/[.]+$/, "")
    .trim();
}

function shorten(text: string, max = 72): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

// Support the usual SSH and HTTPS GitHub remote formats.
function parseGitHubRemote(remoteUrl: string): { webBase: string; owner: string; repo: string } | null {
  const sshLikeMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshLikeMatch) {
    return {
      webBase: `https://${sshLikeMatch[1]}/${sshLikeMatch[2]}/${sshLikeMatch[3]}`,
      owner: sshLikeMatch[2],
      repo: sshLikeMatch[3],
    };
  }

  const urlMatch = remoteUrl.match(/^(?:https?:\/\/|ssh:\/\/git@)([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (urlMatch) {
    return {
      webBase: `https://${urlMatch[1]}/${urlMatch[2]}/${urlMatch[3]}`,
      owner: urlMatch[2],
      repo: urlMatch[3],
    };
  }

  return null;
}

// Ignore symbolic refs like HEAD and keep only real remote branches.
function cleanRemoteBranchName(ref: string): string | null {
  if (!ref.startsWith("origin/")) return null;
  const branch = ref.slice("origin/".length);
  if (!branch || branch === "HEAD" || branch === "origin") return null;
  return branch;
}

// Split an upstream ref such as origin/main into remote + branch.
function parseUpstreamRef(ref: string): { remote: string; branch: string } | null {
  const [remote, ...branchParts] = ref.split("/");
  const branch = branchParts.join("/").trim();
  if (!remote || !branch) return null;
  return { remote, branch };
}

async function git(pi: ExtensionAPI, cwd: string, args: string[], signal?: AbortSignal) {
  return pi.exec("git", args, { cwd, signal });
}

async function openUrl(pi: ExtensionAPI, cwd: string, url: string, signal?: AbortSignal) {
  if (process.platform === "win32") {
    return pi.exec("cmd.exe", ["/d", "/s", "/c", "start", "", url], { cwd, signal });
  }

  if (process.platform === "darwin") {
    return pi.exec("open", [url], { cwd, signal });
  }

  return pi.exec("xdg-open", [url], { cwd, signal });
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

      // Collect local and remote branches so the user can choose a base branch.
      const branchesResult = await git(pi, ctx.cwd, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], ctx.signal);
      const localBranches = branchesResult.stdout
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean)
        .filter((b) => b !== current && b !== "origin" && b !== "HEAD");

      const remoteBranchesResult = await git(pi, ctx.cwd, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin/"], ctx.signal);
      const remoteBranches = remoteBranchesResult.stdout
        .split(/\r?\n/)
        .map((b) => b.trim())
        .filter(Boolean)
        .map(cleanRemoteBranchName)
        .filter((b): b is string => Boolean(b))
        .filter((b) => b !== current);

      const remoteHeadResult = await git(pi, ctx.cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], ctx.signal);
      const defaultRemoteBranch = firstLine(remoteHeadResult.stdout).replace(/^origin\//, "");

      const branchChoices = Array.from(new Set([defaultRemoteBranch, ...remoteBranches, ...localBranches]))
        .filter((branch) => branch && branch !== current && branch !== "origin")
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

      // Use the recent commit subjects to build the PR title and summary.
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
      ];
      const body = bodyLines.join("\n");

      // Resolve origin to a GitHub repository before calling the API.
      const originResult = await git(pi, ctx.cwd, ["remote", "get-url", "origin"], ctx.signal);
      if (originResult.code !== 0) {
        ctx.ui.notify("No origin remote found.", "error");
        return;
      }
      const originUrl = firstLine(originResult.stdout);

      const repo = parseGitHubRemote(originUrl);
      if (!repo) {
        ctx.ui.notify("origin remote is not a GitHub URL.", "error");
        return;
      }

      const token = process.env.GH_TOKEN;
      if (!token) {
        ctx.ui.notify("Set GH_TOKEN or GITHUB_TOKEN to create PRs programmatically.", "error");
        return;
      }

      // Exit early if GitHub already has an open PR for this branch.
      const existingPrResponse = await fetch(
        `https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?head=${encodeURIComponent(`${repo.owner}:${current}`)}&state=open&per_page=1`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: ctx.signal,
        },
      );
      if (!existingPrResponse.ok) {
        ctx.ui.notify(`GitHub API error (${existingPrResponse.status}) while checking for existing PRs.`, "error");
        return;
      }

      const existingPrs = (await existingPrResponse.json().catch(() => [])) as Array<{ html_url?: string }>;
      if (existingPrs.length > 0) {
        const existingPrUrl = existingPrs[0]?.html_url;
        ctx.ui.notify(existingPrUrl ? `This branch already has an open PR: ${existingPrUrl}` : "This branch already has an open PR.", "info");
        return;
      }

      // Push any local commits before creating a new PR.
      const upstreamResult = await git(pi, ctx.cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], ctx.signal);
      if (upstreamResult.code === 0) {
        const upstream = parseUpstreamRef(firstLine(upstreamResult.stdout));
        if (upstream) {
          const unpushedResult = await git(pi, ctx.cwd, ["rev-list", "--count", `${upstream.remote}/${upstream.branch}..${current}`], ctx.signal);
          const unpushedCount = Number.parseInt(firstLine(unpushedResult.stdout), 10);
          if (Number.isFinite(unpushedCount) && unpushedCount > 0) {
            ctx.ui.notify(`Pushing ${unpushedCount} local commit(s) on ${current}...`, "info");
            const pushResult = await git(pi, ctx.cwd, ["push", "origin", current], ctx.signal);
            if (pushResult.code !== 0) {
              ctx.ui.notify(pushResult.stderr.trim() || "Failed to push local commits.", "error");
              return;
            }
          }
        }
      } else {
        ctx.ui.notify(`Pushing ${current} to origin...`, "info");
        const pushResult = await git(pi, ctx.cwd, ["push", "-u", "origin", current], ctx.signal);
        if (pushResult.code !== 0) {
          ctx.ui.notify(pushResult.stderr.trim() || "Failed to push current branch.", "error");
          return;
        }
      }

      ctx.ui.notify(`Creating PR for ${current} → ${target}...`, "info");
      const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title,
          body,
          head: current,
          base: target,
          draft: false,
        }),
        signal: ctx.signal,
      });

      const payload = (await response.json().catch(() => null)) as { html_url?: string; message?: string; errors?: Array<{ message?: string }> } | null;
      if (!response.ok) {
        const message = payload?.message ?? payload?.errors?.[0]?.message ?? `GitHub API error (${response.status})`;
        ctx.ui.notify(message, "error");
        return;
      }

      const prUrl = payload?.html_url;
      if (!prUrl) {
        ctx.ui.notify("PR created but GitHub did not return a URL.", "warning");
        return;
      }

      await openUrl(pi, ctx.cwd, prUrl, ctx.signal);
      ctx.ui.notify(`PR created and opened: ${prUrl}`, "success");
    },
  });
}
