#!/usr/bin/env node
/**
 * Builds the self-contained extension that `vsce package` turns into a VSIX:
 *
 *   dist/extension.cjs                   extension host code
 *   dist/webview/                        chat panel
 *   dist/pi-extension/review-changes.js  review extension, loaded by pi
 *   dist/pi/                             pi runtime, laid out like pi's npm package
 *   dist/THIRD_PARTY_NOTICES.txt         licenses of everything bundled
 *
 * pi is bundled from this repository's TypeScript source (including this fork's pi changes), so the
 * VSIX needs neither the monorepo nor a global pi. The installed extension runs it with VS Code's Node.
 * Development builds (`npm run build`) are unaffected and keep running pi from source.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const extensionDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(extensionDir, "../..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const aiSrc = join(repoRoot, "packages", "ai", "src");
const distDir = join(extensionDir, "dist");
const piDir = join(distDir, "pi");
const bundleDir = join(piDir, "dist", "bundle");
const rootTsconfig = join(repoRoot, "tsconfig.json");

/** Packages the pi bundle loads at runtime instead of bundling; copied into dist/pi/node_modules. */
const RUNTIME_PACKAGES = ["jiti", "@silvia-odwyer/photon-node"];
/** Optional native accelerators whose callers fall back when they are missing. */
const OPTIONAL_EXTERNALS = ["bufferutil", "utf-8-validate", "kerberos", "supports-color"];

// Mirrors scripts/build-coding-agent-bundle.mjs: jiti loads only when pi imports an extension.
const lazyJitiPlugin = {
	name: "lazy-jiti",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({ namespace: "lazy-jiti", path: "jiti/static" }));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let createJitiImpl;
export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

const httpsProxyAgentPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) =>
			args.kind === "dynamic-import" ? { namespace: "https-proxy-agent-named-export", path: args.path } : undefined,
		);
		build.onLoad({ filter: /^https-proxy-agent$/, namespace: "https-proxy-agent-named-export" }, () => ({
			contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
			loader: "js",
			resolveDir: repoRoot,
		}));
	},
};

/**
 * Workspace packages declare side-effect files by their dist paths (pi-ai: `./dist/images.js`). Bundling
 * from source, mark the matching `src/*.ts` files instead, or esbuild would drop their imports.
 */
const sourceSideEffectsPlugin = {
	name: "source-side-effects",
	setup(build) {
		const files = new Set();
		for (const dir of readdirSync(join(repoRoot, "packages"))) {
			const manifest = join(repoRoot, "packages", dir, "package.json");
			if (!existsSync(manifest)) continue;
			const sideEffects = JSON.parse(readFileSync(manifest, "utf8")).sideEffects;
			if (!Array.isArray(sideEffects)) continue;
			for (const file of sideEffects) {
				files.add(resolve(repoRoot, "packages", dir, file.replace(/^\.\/dist\//, "src/").replace(/\.js$/, ".ts")));
			}
		}
		build.onResolve({ filter: /^\.\.?\/.*\.ts$/ }, (args) => {
			const path = resolve(args.resolveDir, args.path);
			return files.has(path) ? { path, sideEffects: true } : undefined;
		});
	},
};

function piBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner: {
			js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
		},
		bundle: true,
		// Extensions loaded by this pi resolve @earendil-works/* to the modules embedded in the bundle.
		define: { PI_BUNDLED_NODE: "true" },
		external: [...RUNTIME_PACKAGES.filter((name) => name !== "jiti"), ...OPTIONAL_EXTERNALS],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minify: true,
		platform: "node",
		plugins: [lazyJitiPlugin, httpsProxyAgentPlugin, sourceSideEffectsPlugin],
		target: "node22",
		// The root tsconfig maps @earendil-works/* to the workspace sources.
		tsconfig: rootTsconfig,
	};
}

function findOutputContaining(metafile, inputSuffix) {
	for (const [outputPath, output] of Object.entries(metafile.outputs)) {
		if (Object.keys(output.inputs).some((input) => input.replaceAll("\\", "/").endsWith(inputSuffix))) {
			return resolve(repoRoot, outputPath);
		}
	}
	throw new Error(`No bundled output contains ${inputSuffix}`);
}

function checkExternals(metafiles) {
	const allowed = new Set([...RUNTIME_PACKAGES, ...OPTIONAL_EXTERNALS]);
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (imported.external && !isBuiltin(imported.path) && !allowed.has(imported.path)) unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) throw new Error(`pi bundle left unexpected external imports: ${[...unexpected].join(", ")}`);
}

async function buildExtension() {
	await build({
		entryPoints: [join(extensionDir, "src", "extension.ts")],
		bundle: true,
		platform: "node",
		format: "cjs",
		target: "node20",
		external: ["vscode"],
		minify: true,
		outfile: join(distDir, "extension.cjs"),
		logLevel: "warning",
	});
	await build({
		entryPoints: [join(extensionDir, "src", "webview", "main.ts"), join(extensionDir, "src", "webview", "style.css")],
		bundle: true,
		platform: "browser",
		format: "iife",
		target: "es2022",
		minify: true,
		outdir: join(distDir, "webview"),
		logLevel: "warning",
	});
	// pi loads this with jiti; its @earendil-works/* imports resolve to the modules embedded in pi.
	await build({
		entryPoints: [join(extensionDir, "src", "pi-extension", "review-changes.ts")],
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: ["@earendil-works/*"],
		outfile: join(distDir, "pi-extension", "review-changes.js"),
		logLevel: "warning",
	});
}

async function buildPi() {
	const main = await build({
		...piBuildOptions(),
		entryPoints: { "rpc-entry": join(codingAgentDir, "src", "rpc-entry.ts") },
		entryNames: "[name]",
		chunkNames: "chunks/[name]-[hash]",
		outdir: bundleDir,
		splitting: true,
	});
	// OAuth flows, Bedrock and the image worker are loaded through variable specifiers or a worker URL,
	// so each gets a self-contained file next to the code that resolves it.
	const loaderDir = dirname(findOutputContaining(main.metafile, "packages/ai/src/auth/oauth/load.ts"));
	const oauth = ["anthropic", "github-copilot", "kimi-coding", "meta", "openai-codex", "openrouter", "radius", "xai"];
	const lazy = await build({
		...piBuildOptions(),
		entryPoints: {
			...Object.fromEntries(oauth.map((name) => [name, join(aiSrc, "auth", "oauth", `${name}.ts`)])),
			"bedrock-converse-stream": join(aiSrc, "api", "bedrock-converse-stream.ts"),
			"image-resize-worker": join(codingAgentDir, "src", "utils", "image-resize-worker.ts"),
		},
		entryNames: "[name]",
		outdir: loaderDir,
		splitting: false,
	});
	for (const [input, name] of [
		["packages/ai/src/api/bedrock-converse-stream.lazy.ts", "bedrock-converse-stream.js"],
		["packages/coding-agent/src/utils/image-resize.ts", "image-resize-worker.js"],
	]) {
		const expected = join(dirname(findOutputContaining(main.metafile, input)), name);
		if (!existsSync(expected)) throw new Error(`${relative(repoRoot, expected)} is missing next to its loader`);
	}
	checkExternals([main.metafile, lazy.metafile]);

	// Package metadata and assets that pi finds relative to PI_PACKAGE_DIR.
	const piPackage = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	writeFileSync(
		join(piDir, "package.json"),
		`${JSON.stringify({ name: piPackage.name, version: piPackage.version, type: "module", piConfig: piPackage.piConfig }, null, "\t")}\n`,
	);
	const copy = (from, to, filter) => cpSync(join(codingAgentDir, from), join(piDir, to), { recursive: true, filter });
	copy("src/modes/interactive/theme", "dist/modes/interactive/theme", (path) => !path.endsWith(".ts"));
	copy("src/modes/interactive/assets", "dist/modes/interactive/assets");
	copy("src/core/export-html", "dist/core/export-html", (path) => !path.endsWith(".ts"));
	copy("docs", "docs");
	copy("examples", "examples", (path) => !path.includes("node_modules"));
	copy("README.md", "README.md");
	copy("CHANGELOG.md", "CHANGELOG.md");
	for (const name of RUNTIME_PACKAGES) {
		cpSync(join(repoRoot, "node_modules", name), join(piDir, "node_modules", name), { recursive: true, dereference: true });
	}
	return [main.metafile, lazy.metafile];
}

/** One notice per third-party package that ends up in the VSIX, with its license text. */
function writeNotices(metafiles) {
	const packages = new Set(RUNTIME_PACKAGES);
	for (const metafile of metafiles) {
		for (const input of Object.keys(metafile.inputs)) {
			const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replaceAll("\\", "/"));
			if (match) packages.add(match[1]);
		}
	}
	const sections = [
		"pi-vscode-plugin bundles the following software.",
		`pi (@earendil-works packages) - MIT\n\n${readFileSync(join(repoRoot, "LICENSE"), "utf8").trim()}`,
	];
	for (const name of [...packages].sort()) {
		const dir = join(repoRoot, "node_modules", name);
		if (!existsSync(dir)) continue;
		const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
		const licenseFile = readdirSync(dir).find((file) => /^(licen[cs]e|copying)/i.test(file));
		const text = licenseFile ? readFileSync(join(dir, licenseFile), "utf8").trim() : `License: ${pkg.license ?? "unknown"}`;
		sections.push(`${name}@${pkg.version} - ${pkg.license ?? "unknown"}\n\n${text}`);
	}
	writeFileSync(join(distDir, "THIRD_PARTY_NOTICES.txt"), `${sections.join(`\n\n${"-".repeat(72)}\n\n`)}\n`);
	return packages.size;
}

function sizeOf(path) {
	const stats = statSync(path);
	if (!stats.isDirectory()) return stats.size;
	return readdirSync(path).reduce((total, entry) => total + sizeOf(join(path, entry)), 0);
}

rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });
await buildExtension();
const metafiles = await buildPi();
const noticeCount = writeNotices(metafiles);
console.log(
	`Built ${relative(extensionDir, distDir)}: pi runtime ${(sizeOf(piDir) / 1024 / 1024).toFixed(1)} MiB, ` +
		`total ${(sizeOf(distDir) / 1024 / 1024).toFixed(1)} MiB, ${noticeCount} third-party packages in the notices`,
);
