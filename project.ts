import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface ProjectContext {
	primary: string;
	parent: string | null;
	isWorktree: boolean;
	allProjects: string[];
}

function expandTilde(value: string): string {
	if (value === "~" || value.startsWith("~/")) {
		return value.replace(/^~/, homedir());
	}
	return value;
}

function findGitRepoRoot(directory: string): string | undefined {
	try {
		const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
			cwd: directory,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return root || undefined;
	} catch {
		return undefined;
	}
}

function projectName(cwd: string | null | undefined): string {
	if (!cwd?.trim()) return "unknown-project";
	const expanded = expandTilde(cwd);
	const name = path.basename(findGitRepoRoot(expanded) ?? expanded);
	if (name) return name;
	if (process.platform === "win32") {
		const drive = /^([A-Z]):\\/i.exec(cwd)?.[1];
		if (drive) return `drive-${drive.toUpperCase()}`;
	}
	return "unknown-project";
}

function parentProjectForWorktree(cwd: string): string | undefined {
	const gitPath = path.join(cwd, ".git");
	try {
		if (!statSync(gitPath).isFile()) return undefined;
		const match = /^gitdir:\s*(.+)$/.exec(readFileSync(gitPath, "utf8").trim());
		if (!match) return undefined;
		const gitDirectory = path.resolve(path.dirname(gitPath), match[1]);
		const worktree = /^(.+)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.exec(
			gitDirectory,
		);
		return worktree ? path.basename(worktree[1]) : undefined;
	} catch {
		return undefined;
	}
}

/** Mirrors Claude-mem's project-name and worktree identity algorithm. */
export function getProjectContext(
	cwd: string | null | undefined,
): ProjectContext {
	const cwdProject = projectName(cwd);
	if (!cwd) {
		return {
			primary: cwdProject,
			parent: null,
			isWorktree: false,
			allProjects: [cwdProject],
		};
	}

	const parent = parentProjectForWorktree(expandTilde(cwd));
	if (parent) {
		const composite = `${parent}/${cwdProject}`;
		return {
			primary: composite,
			parent,
			isWorktree: true,
			allProjects: [parent, composite],
		};
	}

	return {
		primary: cwdProject,
		parent: null,
		isWorktree: false,
		allProjects: [cwdProject],
	};
}
