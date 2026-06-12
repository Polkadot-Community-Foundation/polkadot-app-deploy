#!/usr/bin/env node
/**
 * rescope-pack.mjs — stage a PCF-scoped tarball of @parity/polkadot-app-deploy without renaming
 * it in-tree.
 *
 * Why: this repo is the PCF fork of paritytech/polkadot-app-deploy. The package is named
 * `@parity/polkadot-app-deploy` in-tree so the tree stays merge-clean with `git merge
 * upstream/main`. But PCF publishes its own build (carrying PCF fixes — e.g. the manifest
 * direct-signer fix) under its own scope as `@polkadot-community-foundation/polkadot-app-deploy`.
 *
 * Assumes the package is already built (`npm test` / `npm run build` ran in CI before this).
 * Runs `npm pack`, rewrites only the `name` (version unchanged), and repacks into pack-output/
 * for the npm-publish-automation to publish. Mirrors browse-sdk + cdm-env rescope-pack.mjs.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISHED_NAME = "@polkadot-community-foundation/polkadot-app-deploy";
const OUT_DIR = join(PKG_DIR, "pack-output");

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString().trim();

const stage = mkdtempSync(join(tmpdir(), "pcf-pad-"));
run(`npm pack --pack-destination ${stage}`, PKG_DIR);
const srcTgz = readdirSync(stage).find((f) => f.endsWith(".tgz"));
if (!srcTgz) throw new Error("npm pack produced no .tgz (build first: npm run build)");
run(`tar -xzf ${join(stage, srcTgz)} -C ${stage}`, stage); // -> ${stage}/package/

const pkgJsonPath = join(stage, "package", "package.json");
const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
const upstreamName = pkg.name;
pkg.name = PUBLISHED_NAME;
writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + "\n");

if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
run(`npm pack --pack-destination ${OUT_DIR}`, join(stage, "package"));
rmSync(stage, { recursive: true, force: true });

const outTgz = readdirSync(OUT_DIR).find((f) => f.endsWith(".tgz"));
console.log(`[rescope-pack] ${upstreamName}@${pkg.version} -> ${PUBLISHED_NAME}@${pkg.version}`);
console.log(`[rescope-pack] staged tarball: ${join(OUT_DIR, outTgz)}`);
