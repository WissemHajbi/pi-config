import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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
	remove: { emoji: "🔥", verb: "Remove" },
	move: { emoji: "🚚", verb: "Move" },
	refactor: { emoji: "♻️", verb: "Refactor" },
	security: { emoji: "🔒", verb: "Secure" },
	i18n: { emoji: "🌐", verb: "Update" },
} as const satisfies Record<string, GitmojiChoice>;

async function git(ctx: ExtensionCommandContext, args: string[]): Promise<string> {
	const { stdout, stderr } = await execFileAsync("git", args, {
		cwd: ctx.cwd,
		encoding: "utf8",
		maxBuffer: 10 * 1024 * 1024,
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

function chooseGitmoji(files: GitFile[]): GitmojiChoice {
	if (allFiles(files, (_path, file) => file.status.startsWith("D"))) return GITMOJI.remove;
	if (hasAny(files, (_path, file) => file.status.startsWith("R"))) return GITMOJI.move;
	if (hasAny(files, (path) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|composer\.lock|requirements\.txt|poetry\.lock)$/u.test(path))) return GITMOJI.deps;
	if (hasAny(files, (path) => /(security|auth|permission|policy|token|jwt|csrf|xss|sanitize)/u.test(path))) return GITMOJI.security;
	if (allFiles(files, (path) => /(readme|changelog|license|docs?\/|\.md$|\.mdx$)/u.test(path))) return GITMOJI.docs;
	if (allFiles(files, (path) => /(test|spec|__tests__|\.test\.|\.spec\.|jest|vitest|playwright|cypress)/u.test(path))) return GITMOJI.test;
	if (allFiles(files, (path) => /(\.css$|\.scss$|\.sass$|\.less$|tailwind|theme|styles?\/|ui\/)/u.test(path))) return GITMOJI.style;
	if (allFiles(files, (path) => /(\.json$|\.ya?ml$|\.toml$|\.ini$|\.env|config|eslint|prettier|tsconfig|vite|webpack|next\.config|dockerfile|compose\.ya?ml)/u.test(path))) return GITMOJI.config;
	if (hasAny(files, (path) => /(locale|locales|i18n|translations?|messages?\/|\.po$|\.pot$)/u.test(path))) return GITMOJI.i18n;
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
	if (parts.length > 1) return humanizeSegment(parts[parts.length - 2] ?? "project files") || "project files";
	return humanizeSegment(parts[0] ?? "project files") || "project files";
}

function formatAreas(files: GitFile[]): string {
	const unique = Array.from(new Set(files.map((file) => inferArea(file.path))));
	const preferred = ["interface", "components", "services", "hooks", "validation", "types", "tests", "documentation", "styling", "translations", "dependencies", "configuration", "project files"];
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

function buildCommitMessage(files: GitFile[]): string {
	const choice = chooseGitmoji(files);
	const areas = formatAreas(files);
	const plural = files.length === 1 ? "change" : "changes";

	if (choice === GITMOJI.remove) return `${choice.emoji} ${choice.verb} unused ${areas} from the project.`;
	if (choice === GITMOJI.move) return `${choice.emoji} ${choice.verb} ${areas} into the updated project structure.`;
	if (choice === GITMOJI.fix) return `${choice.emoji} ${choice.verb} ${areas} behavior for the latest project changes.`;
	if (choice === GITMOJI.deps) return `${choice.emoji} ${choice.verb} dependencies and lockfiles for the current project state.`;
	if (choice === GITMOJI.docs) return `${choice.emoji} ${choice.verb} documentation for the latest project changes.`;
	if (choice === GITMOJI.test) return `${choice.emoji} ${choice.verb} tests to cover the latest project behavior.`;
	if (choice === GITMOJI.config) return `${choice.emoji} ${choice.verb} project settings for the latest development workflow.`;
	if (choice === GITMOJI.security) return `${choice.emoji} ${choice.verb} ${areas} handling for safer project behavior.`;
	if (choice === GITMOJI.i18n) return `${choice.emoji} ${choice.verb} translations for the latest interface changes.`;
	if (choice === GITMOJI.style) return `${choice.emoji} ${choice.verb} ${areas} for a cleaner user interface.`;
	if (choice === GITMOJI.refactor) return `${choice.emoji} ${choice.verb} ${areas} to keep the implementation maintainable.`;
	return `${choice.emoji} ${choice.verb} ${areas} with ${plural} from the latest implementation work.`;
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

		const beforeStatus = await git(ctx, ["status", "--porcelain"]);
		if (!beforeStatus) {
			notify(ctx, "No staged or unstaged changes to commit.", "info");
			return;
		}

		try {
			await git(ctx, ["add", "-A"]);
		} catch (error) {
			notify(ctx, `Failed to stage changes: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}

		const staged = await git(ctx, ["diff", "--cached", "--name-status"]);
		const files = parseNameStatus(staged);
		if (files.length === 0) {
			notify(ctx, "No staged changes remained after git add -A.", "warning");
			return;
		}

		const message = buildCommitMessage(files);

		try {
			const output = await git(ctx, ["commit", "-m", message]);
			const summary = output ? `\n${output.split(/\r?\n/u).slice(-3).join("\n")}` : "";
			notify(ctx, `Committed ${files.length} file(s) with: ${message}${summary}`, "info");
		} catch (error) {
			notify(ctx, `Commit failed after staging all changes. Message was: ${message}\n${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	pi.registerCommand("commit", {
		description: "Stage every git change and commit with a guaranteed gitmoji one-sentence message",
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
