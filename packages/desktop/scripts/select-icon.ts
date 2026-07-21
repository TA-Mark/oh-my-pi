import * as path from "node:path";

const requested = Bun.argv[2]?.replace(/\.(png|svg)$/i, "");
const optionsDir = path.join(import.meta.dir, "..", "resources", "icon-options");
const sourcePng = path.join(optionsDir, `${requested ?? ""}.png`);
const sourceSvg = path.join(optionsDir, `${requested ?? ""}.svg`);
const targetPng = path.join(import.meta.dir, "..", "resources", "icon.png");
const targetSvg = path.join(import.meta.dir, "..", "resources", "icon.svg");
const targetAppSvg = path.join(import.meta.dir, "..", "src", "assets", "omp-icon.svg");

if (!requested) {
	throw new Error("Usage: bun run icon:use -- <icon-name> (for example: 01-neural-orbit)");
}

try {
	await Bun.write(targetPng, await Bun.file(sourcePng).arrayBuffer());
	const svg = await Bun.file(sourceSvg).text();
	await Bun.write(targetSvg, svg);
	await Bun.write(targetAppSvg, svg);
	console.log(`Selected ${requested} as the default desktop icon.`);
} catch {
	throw new Error(`Unknown icon "${requested}". See resources/icon-options for available names.`);
}
