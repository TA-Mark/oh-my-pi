import * as path from "node:path";

interface PackageManifest {
	version?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

interface DependencyIssue {
	name: string;
	expected: string;
	actual?: string;
}

const desktopDir = path.join(import.meta.dir, "..");
const repoRoot = path.join(desktopDir, "..", "..");
const manifest = (await Bun.file(path.join(desktopDir, "package.json")).json()) as PackageManifest;
const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };

function packageManifestCandidates(name: string): string[] {
	const segments = name.split("/");
	return [
		path.join(desktopDir, "node_modules", ...segments, "package.json"),
		path.join(repoRoot, "node_modules", ...segments, "package.json"),
	];
}

function exactVersion(specifier: string): string | null {
	return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(specifier) ? specifier : null;
}

async function dependencyIssues(): Promise<DependencyIssue[]> {
	const issues: DependencyIssue[] = [];
	for (const [name, expected] of Object.entries(dependencies)) {
		let installed: PackageManifest | null = null;
		for (const candidate of packageManifestCandidates(name)) {
			try {
				installed = (await Bun.file(candidate).json()) as PackageManifest;
				break;
			} catch {
				// Bun's hoisted linker may place the package at either candidate.
			}
		}
		const actual = installed?.version;
		const pinned = exactVersion(expected);
		if (!installed || (pinned && actual !== pinned)) issues.push({ name, expected, actual });
	}
	return issues;
}

function describeIssues(issues: DependencyIssue[]): string {
	return issues
		.map(issue =>
			issue.actual
				? `${issue.name} (expected ${issue.expected}, found ${issue.actual})`
				: `${issue.name} (missing, expected ${issue.expected})`,
		)
		.join(", ");
}

let issues = await dependencyIssues();
if (issues.length === 0) {
	console.log("Desktop dependencies are ready.");
	process.exit(0);
}

console.log(`Repairing desktop dependencies: ${describeIssues(issues)}`);
const install = Bun.spawn(["bun", "install", "--frozen-lockfile"], {
	cwd: repoRoot,
	stdout: "inherit",
	stderr: "inherit",
});
if ((await install.exited) !== 0) throw new Error("bun install --frozen-lockfile failed");

issues = await dependencyIssues();
if (issues.length > 0) {
	throw new Error(`Desktop dependencies are still invalid after install: ${describeIssues(issues)}`);
}
console.log("Desktop dependencies repaired.");
