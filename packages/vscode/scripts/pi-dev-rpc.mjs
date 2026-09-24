#!/usr/bin/env node
// Runs the monorepo-local pi CLI from TypeScript source, so extension development needs no build of pi.
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const repoRoot = new URL("../../../", import.meta.url);
register({ tsconfig: fileURLToPath(new URL("tsconfig.json", repoRoot)) });
await import(new URL("packages/coding-agent/src/cli.ts", repoRoot).href);
