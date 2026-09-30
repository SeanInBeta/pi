#!/usr/bin/env node
// Runs the monorepo-local pi CLI from TypeScript source, so extension development needs no build of pi.
// Node strips the TypeScript; pi's source resolver maps the @earendil-works/* imports to their sources.
const repoRoot = new URL("../../../", import.meta.url);
await import(new URL("packages/coding-agent/src/experimental/source-resolver.ts", repoRoot).href);
await import(new URL("packages/coding-agent/src/cli.ts", repoRoot).href);
