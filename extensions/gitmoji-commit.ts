import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_DIFF_CHARS = 140_000;
const GIT_MAX_BUFFER = 50 * 1024 * 1024;

const COMMIT_MESSAGE_PROMPT = `You write precise git commit subjects from real repository changes.

Rules:
- Read the provided git status, name-status, diff stat, and diff content.
- Return exactly one commit subject line and nothing else.
- Start with one suitable gitmoji emoji.
- If the staged work is heavily design/UI related, start with the lipstick emoji: 💄.
- If the staged work removes/deletes code or removes a feature, start with the fire emoji: 🔥.
- If the staged work is an unfinished feature/change, work in progress, placeholder, or partial implementation, start with the construction emoji: 🚧.
- If the staged work is heavily about translations, next-intl, i18n, internationalization, or language JSON files, start with the pencil2 emoji: ✏️.
- For any code changes or edits to existing features, start with the recycle emoji: ♻️.
- Be specific to this commit's actual changes; never use generic phrases like "latest changes", "current project state", "implementation work", or "project files".
- Keep it under 90 characters when possible.
- Use imperative mood, e.g. "Add", "Fix", "Refactor", "Update", "Remove".
- Mention the most important changed feature, module, behavior, or file area.
- Do not wrap the message in quotes or markdown.

Examples:
✨ Add product variant filters to catalog search
🐛 Fix cart total recalculation after coupon removal
♻️ Refactor order DTO mapping for checkout responses`;

type GitFile = {
	status: string;
	path: string;
};

type GitmojiChoice = {
	emoji: string;
	verb: string;
};

const GITMOJI = {
	feature: { emoji: "✨", verb: "Update" },
	fix: { emoji: "🐛", verb: "Fix" },
	docs: { emoji: "📝", verb: "Update" },
	style: { emoji: "💄", verb: "Improve" },
	test: { emoji: "✅", verb: "Update" },
	config: { emoji: "🔧", verb: "Configure" },
	deps: { emoji: "📦", verb: "Update" },
	wip: { emoji: "🚧", verb: "Continue" },
	remove: { emoji: "🔥", verb: "Remove" },
	move: { emoji: "🚚", verb: "Move" },
	refactor: { emoji: "♻️", verb: "Refactor" },
	security: { emoji: "🔒", verb: "Secure" },
	i18n: { emoji: "✏️", verb: "Update" },
} as const satisfies Record<string, GitmojiChoice>;

async function git(ctx: ExtensionCommandContext, args: string[]): Promise<string> {
	const { stdout, stderr } = await execFileAsync("git", args, {
		cwd: ctx.cwd,
		encoding: "utf8",
		maxBuffer: GIT_MAX_BUFFER,
	});
	return `${stdout ?? ""}${stderr ?? ""}`.trim();
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
}

function parseNameStatus(output: string): GitFile[] {
	return output
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const parts = line.split(/\t+/u);
			const status = parts[0] ?? "M";
			const path = parts[parts.length - 1] ?? line;
			return { status, path };
		});
}

function hasAny(files: GitFile[], matcher: (path: string, file: GitFile) => boolean): boolean {
	return files.some((file) => matcher(file.path.toLowerCase(), file));
}

function allFiles(files: GitFile[], matcher: (path: string, file: GitFile) => boolean): boolean {
	return files.length > 0 && files.every((file) => matcher(file.path.toLowerCase(), file));
}

function isDesignUiPath(path: string): boolean {
	return /(\.css$|\.scss$|\.sass$|\.less$|tailwind|theme|styles?\/|ui\/|components?\/|design|layout|page|pages\/|app\/|screen|screens|modal|dialog|button|card|form|navbar|sidebar|header|footer|avatar|badge|icon)/u.test(path);
}

function isDesignUiHeavy(files: GitFile[]): boolean {
	if (files.length === 0) return false;
	const uiFiles = files.filter((file) => isDesignUiPath(file.path.toLowerCase())).length;
	return uiFiles / files.length >= 0.6;
}

function isI18nPath(path: string): boolean {
	return /(next-intl|i18n|internationali[sz]ation|locale|locales|translations?|messages?\/|langs?\/|languages?\/|dictionaries?\/|\.po$|\.pot$|\.xliff?$|\.arb$|(^|\/)(en|fr|ar|de|es|it|pt|nl|tr|ru|zh|ja|ko)(-[a-z]{2})?\.json$)/u.test(path);
}

function isI18nHeavy(files: GitFile[]): boolean {
	if (files.length === 0) return false;
	const i18nFiles = files.filter((file) => isI18nPath(file.path.toLowerCase())).length;
	return i18nFiles / files.length >= 0.6;
}

function isCodePath(path: string): boolean {
	return /(\.tsx?$|\.jsx?$|\.vue$|\.svelte$|\.astro$|\.mjs$|\.cjs$|\.mts$|\.cts$|\.py$|\.go$|\.rs$|\.java$|\.kt$|\.kts$|\.cs$|\.php$|\.rb$|\.swift$|\.dart$|\.scala$|\.c$|\.cc$|\.cpp$|\.h$|\.hpp$|\.sql$|src\/|lib\/|app\/|pages\/|components?\/|hooks?\/|services?\/|api\/|server\/|client\/|modules?\/|features?\/)/u.test(path);
}

function hasCodeChange(files: GitFile[]): boolean {
	return hasAny(files, (path) => isCodePath(path));
}

function isWipDiff(diff: string): boolean {
	return /(\bWIP\b|work in progress|unfinished|not finished|partial implementation|placeholder|TODO|FIXME|HACK|not implemented|coming soon|temporary|stub|@todo|throw new Error\(["'`]not implemented)/iu.test(diff);
}

function chooseGitmoji(files: GitFile[], diff = ""): GitmojiChoice {
	if (hasAny(files, (_path, file) => file.status.startsWith("D"))) return GITMOJI.remove;
	if (diff && isWipDiff(diff)) return GITMOJI.wip;
	if (isI18nHeavy(files)) return GITMOJI.i18n;
	if (hasAny(files, (_path, file) => file.status.startsWith("R"))) return GITMOJI.move;
	if (isDesignUiHeavy(files)) return GITMOJI.style;
	if (hasAny(files, (path) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|requirements\.txt|poetry\.lock)$/u.test(path))) return GITMOJI.deps;
	if (allFiles(files, (path) => /(readme|changelog|license|docs?\/|\.md$|\.mdx$)/u.test(path))) return GITMOJI.docs;
	if (allFiles(files, (path) => /(test|spec|__tests__|\.test\.|\.spec\.|jest|vitest|playwright|cypress)/u.test(path))) return GITMOJI.test;
	if (allFiles(files, (path) => isDesignUiPath(path))) return GITMOJI.style;
	if (allFiles(files, (path) => /(\.json$|\.ya?ml$|\.toml$|\.ini$|\.env|config|eslint|prettier|tsconfig|vite|webpack|next\.config|dockerfile|compose\.ya?ml)/u.test(path))) return GITMOJI.config;
	if (hasAny(files, (path) => isI18nPath(path))) return GITMOJI.i18n;
	if (hasCodeChange(files)) return GITMOJI.refactor;
	if (hasAny(files, (path) => /(security|auth|permission|policy|token|jwt|csrf|xss|sanitize)/u.test(path))) return GITMOJI.security;
	if (hasAny(files, (path) => /(fix|bug|error|exception|crash|issue|hotfix)/u.test(path))) return GITMOJI.fix;
	if (hasAny(files, (path) => /(refactor|cleanup|clean-up)/u.test(path))) return GITMOJI.refactor;
	return GITMOJI.feature;
}

function humanizeSegment(value: string): string {
	return value
		.replace(/\.[^.]+$/u, "")
		.replace(/[-_]+/gu, " ")
		.replace(/([a-z])([A-Z])/gu, "$1 $2")
		.toLowerCase()
		.trim();
}

function inferArea(path: string): string {
	const lower = path.toLowerCase();
	if (/(readme|changelog|license|docs?\/|\.md$|\.mdx$)/u.test(lower)) return "documentation";
	if (/(test|spec|__tests__|\.test\.|\.spec\.|jest|vitest|playwright|cypress)/u.test(lower)) return "tests";
	if (/(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb)/u.test(lower)) return "dependencies";
	if (/(\.css$|\.scss$|\.sass$|\.less$|tailwind|theme|styles?\/)/u.test(lower)) return "styling";
	if (/(locale|locales|i18n|translations?|messages?\/)/u.test(lower)) return "translations";
	if (/(api|service|services|client|server)/u.test(lower)) return "services";
	if (/(component|components|ui|page|pages|app\/|screen|screens)/u.test(lower)) return "interface";
	if (/(hook|hooks)/u.test(lower)) return "hooks";
	if (/(schema|validation|validator)/u.test(lower)) return "validation";
	if (/(type|types|dto|model|models)/u.test(lower)) return "types";
	if (/(config|eslint|prettier|tsconfig|vite|webpack|next\.config|dockerfile|compose\.ya?ml|\.json$|\.ya?ml$)/u.test(lower)) return "configuration";

	const parts = path.split(/[\\/]/u).filter(Boolean);
	if (parts.length > 1) return humanizeSegment(parts[parts.length - 2] ?? "repository root") || "repository root";
	return humanizeSegment(parts[0] ?? "repository root") || "repository root";
}

function formatAreas(files: GitFile[]): string {
	const unique = Array.from(new Set(files.map((file) => inferArea(file.path))));
	const preferred = ["interface", "components", "services", "hooks", "validation", "types", "tests", "documentation", "styling", "translations", "dependencies", "configuration", "repository root"];
	unique.sort((a, b) => {
		const ai = preferred.indexOf(a);
		const bi = preferred.indexOf(b);
		return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b);
	});
	const top = unique.slice(0, 3);
	if (top.length === 1) return top[0] ?? "project files";
	if (top.length === 2) return `${top[0]} and ${top[1]}`;
	return `${top[0]}, ${top[1]}, and ${top[2]}`;
}

function summarizeTargets(files: GitFile[]): string {
	const names = Array.from(
		new Set(
			files.map((file) => {
				const parts = file.path.split(/[\\/]/u).filter(Boolean);
				const base = parts[parts.length - 1] ?? file.path;
				return humanizeSegment(base) || humanizeSegment(parts[parts.length - 2] ?? "changes");
			}),
		),
	).filter(Boolean);

	const top = names.slice(0, 2);
	if (top.length === 0) return formatAreas(files);
	if (top.length === 1) return top[0] ?? formatAreas(files);
	return `${top[0]} and ${top[1]}`;
}

function buildCommitMessage(files: GitFile[], diff = ""): string {
	const choice = chooseGitmoji(files, diff);
	const areas = formatAreas(files);
	const targets = summarizeTargets(files);

	if (choice === GITMOJI.remove) return `${choice.emoji} ${choice.verb} ${targets} from ${areas}.`;
	if (choice === GITMOJI.move) return `${choice.emoji} ${choice.verb} ${targets} within ${areas}.`;
	if (choice === GITMOJI.fix) return `${choice.emoji} ${choice.verb} ${targets} behavior in ${areas}.`;
	if (choice === GITMOJI.deps) return `${choice.emoji} ${choice.verb} ${targets} dependencies.`;
	if (choice === GITMOJI.wip) return `${choice.emoji} ${choice.verb} ${targets} in ${areas}.`;
	if (choice === GITMOJI.docs) return `${choice.emoji} ${choice.verb} ${targets} documentation.`;
	if (choice === GITMOJI.test) return `${choice.emoji} ${choice.verb} ${targets} tests.`;
	if (choice === GITMOJI.config) return `${choice.emoji} ${choice.verb} ${targets} configuration.`;
	if (choice === GITMOJI.security) return `${choice.emoji} ${choice.verb} ${targets} handling in ${areas}.`;
	if (choice === GITMOJI.i18n) return `${choice.emoji} ${choice.verb} ${targets} translations.`;
	if (choice === GITMOJI.style) return `${choice.emoji} ${choice.verb} ${targets} styling in ${areas}.`;
	if (choice === GITMOJI.refactor) return `${choice.emoji} ${choice.verb} ${targets} in ${areas}.`;
	return `${choice.emoji} ${choice.verb} ${targets} in ${areas}.`;
}

function truncateDiff(diff: string): { text: string; truncated: boolean } {
	if (diff.length <= MAX_DIFF_CHARS) return { text: diff, truncated: false };
	return {
		text: `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[Diff truncated after ${MAX_DIFF_CHARS.toLocaleString()} characters. Use the file/status/stat summaries above for the full changed-file list.]`,
		truncated: true,
	};
}

function sanitizeCommitMessage(message: string, fallback: string): string {
	const firstLine = message
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.find(Boolean);

	if (!firstLine) return fallback;

	return firstLine
		.replace(/^```(?:\w+)?\s*/u, "")
		.replace(/```$/u, "")
		.replace(/^[["'`]+|[\]"'`]+$/gu, "")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 180) || fallback;
}

async function generateSmartCommitMessage(
	ctx: ExtensionCommandContext,
	files: GitFile[],
	status: string,
	stat: string,
	diff: string,
): Promise<{ message: string; source: "model" | "fallback"; diffTruncated: boolean }> {
	const fallback = buildCommitMessage(files, diff);
	const { text: diffText, truncated } = truncateDiff(diff);

	if (!ctx.model) {
		return { message: fallback, source: "fallback", diffTruncated: truncated };
	}

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			return { message: fallback, source: "fallback", diffTruncated: truncated };
		}

		const userMessage: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Generate a commit subject for these staged changes.\n\nChanged files (${files.length}):\n${files.map((file) => `${file.status}\t${file.path}`).join("\n")}\n\nGit status:\n${status}\n\nDiff stat:\n${stat || "(no stat output)"}\n\nDiff${truncated ? " (truncated)" : ""}:\n${diffText}`,
				},
			],
			timestamp: Date.now(),
		};

		const response = await complete(
			ctx.model,
			{ systemPrompt: COMMIT_MESSAGE_PROMPT, messages: [userMessage] },
			{ apiKey: auth.apiKey, headers: auth.headers },
		);

		if (response.stopReason === "aborted") {
			return { message: fallback, source: "fallback", diffTruncated: truncated };
		}

		const text = response.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");

		return { message: sanitizeCommitMessage(text, fallback), source: "model", diffTruncated: truncated };
	} catch {
		return { message: fallback, source: "fallback", diffTruncated: truncated };
	}
}

export default function (pi: ExtensionAPI) {
	async function handler(_args: string, ctx: ExtensionCommandContext): Promise<void> {
		await ctx.waitForIdle();

		try {
			await git(ctx, ["rev-parse", "--is-inside-work-tree"]);
		} catch {
			notify(ctx, "Not inside a git repository.", "error");
			return;
		}

		try {
			await git(ctx, ["diff", "--cached", "--quiet"]);
			notify(ctx, "No staged changes to commit. Stage files first, then run /commit.", "info");
			return;
		} catch (error) {
			const maybeExitCode = typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
			if (maybeExitCode !== 1) {
				notify(ctx, `Failed to inspect staged changes: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}
		}

		const staged = await git(ctx, ["diff", "--cached", "--name-status"]);
		const files = parseNameStatus(staged);
		if (files.length === 0) {
			notify(ctx, "No staged changes to commit. Stage files first, then run /commit.", "warning");
			return;
		}

		const [status, stat, diff] = await Promise.all([
			git(ctx, ["status", "--porcelain=v1"]),
			git(ctx, ["diff", "--cached", "--stat"]),
			git(ctx, ["diff", "--cached", "--find-renames", "--find-copies", "--no-ext-diff", "--"]),
		]);

		notify(ctx, `Reviewing ${files.length} staged file(s) to generate a specific commit message...`, "info");
		const generated = await generateSmartCommitMessage(ctx, files, status, stat, diff);
		const message = generated.message;

		try {
			const output = await git(ctx, ["commit", "-m", message]);
			const summary = output ? `\n${output.split(/\r?\n/u).slice(-3).join("\n")}` : "";
			const source = generated.source === "model" ? "smart" : "fallback";
			const truncated = generated.diffTruncated ? " (large diff summarized)" : "";
			notify(ctx, `Committed ${files.length} file(s) with ${source} message${truncated}: ${message}${summary}`, "info");
		} catch (error) {
			notify(ctx, `Commit failed for staged changes. Message was: ${message}\n${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	pi.registerCommand("commit", {
		description: "Inspect staged git changes and commit them with a smart gitmoji message",
		handler,
	});

	pi.registerCommand("gcommit", {
		description: "Alias for /commit",
		handler,
	});

	pi.registerCommand("commit-all", {
		description: "Alias for /commit",
		handler,
	});
}
