#!/usr/bin/env bun
/**
 * Build the binaries that get attached to a GitHub release.
 *
 * semantic-release runs this from `prepareCmd` with the version it is about to
 * tag; run by hand with no argument it builds `0.0.0-dev`, so the local path and
 * the CI path are the same command.
 *
 * Not minified, for the same reason `bun run build` isn't: a stack trace that
 * still names its own functions is worth more than the few KB.
 */

import { $ } from "bun";
import { join } from "node:path";

/** One entry per published asset. Adding a platform is adding a line. */
const TARGETS = ["linux-x64", "linux-arm64"] as const;

const version = process.argv[2] ?? "0.0.0-dev";
const outDir = "dist";

await $`rm -rf ${outDir}`;
await $`mkdir -p ${outDir}`;

const names: string[] = [];
for (const target of TARGETS) {
	const name = `apt-extract-${version}-${target}`;
	// Cross-compiling downloads the Bun runtime for the target the first time.
	await $`bun build --compile --sourcemap --target=bun-${target} index.ts --outfile ${join(outDir, name)}`;
	names.push(name);
}

// A checksum file, in `sha256sum -c` format, so a downloaded asset can be
// checked the same way this tool checks everything it downloads. sha256sum
// streams the file; nothing here needs 90 MiB of binary in memory.
const sums = await $`sha256sum ${names}`.cwd(outDir).text();
await Bun.write(join(outDir, "SHA256SUMS"), sums);

console.log(`built ${names.length} binaries for ${version}:\n${sums}`);
