import * as fs from "node:fs/promises";
import * as path from "node:path";

const releaseRoot = path.resolve(process.argv[2] ?? "release");
const platform = process.platform;
const unpackedPrefixes = platform === "win32" ? ["win-unpacked"] : platform === "darwin" ? ["mac"] : ["linux-unpacked"];
const releaseEntries = await fs.readdir(releaseRoot, { withFileTypes: true });
const unpacked = releaseEntries
	.filter(
		entry =>
			entry.isDirectory() &&
			unpackedPrefixes.some(prefix => entry.name === prefix || entry.name.startsWith(`${prefix}-`)),
	)
	.map(entry => entry.name)
	.at(0);
if (!unpacked) {
	console.error(`Release validation failed: no unpacked application directory found in ${releaseRoot}`);
	process.exit(1);
}
const bundleRoot = platform === "darwin" ? path.join("OMP Desktop.app", "Contents") : "";
const resourcesDir = platform === "darwin" ? "Resources" : "resources";
const executable =
	platform === "win32" ? "OMP Desktop.exe" : platform === "darwin" ? path.join("MacOS", "OMP Desktop") : "omp-desktop";
const required = [path.join(bundleRoot, executable), path.join(bundleRoot, resourcesDir, "app.asar")];
if (platform === "win32") required.push(path.join(bundleRoot, resourcesDir, "omp.exe"));
else required.push(path.join(bundleRoot, resourcesDir, "omp"));

const missing: string[] = [];
for (const relative of required) {
	const file = Bun.file(path.join(releaseRoot, unpacked, relative));
	if (!(await file.exists()) || (await file.size) === 0) missing.push(relative);
}

if (missing.length > 0) {
	console.error(`Release validation failed in ${releaseRoot}:`);
	for (const item of missing) console.error(`- missing or empty: ${item}`);
	process.exit(1);
}

console.log(`Release validation passed: ${required.length} required artifacts present in ${releaseRoot}`);
