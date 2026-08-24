/** Fetching and unpacking the .deb itself. */

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Stanza } from "./control.ts";
import { die, get, humanMiB, sha256 } from "./util.ts";

/**
 * Download the .deb named by a verified index stanza, checking size and SHA256.
 * Hashing happens on the way to disk, so the payload is never held in memory.
 * A cached file is reused only if it matches the index exactly.
 */
export async function download(pkg: Stanza, repoUrl: string, cache: string): Promise<string> {
	const wantSha = pkg.get("SHA256");
	const wantSize = Number(pkg.get("Size"));
	const filename = pkg.get("Filename");
	if (!wantSha || !filename || !Number.isFinite(wantSize)) die("index stanza is missing Filename/Size/SHA256");

	mkdirSync(cache, { recursive: true });
	const path = join(cache, basename(filename));

	if (existsSync(path)) {
		const cached = Bun.file(path);
		if (cached.size === wantSize && sha256(new Uint8Array(await cached.arrayBuffer())) === wantSha) {
			console.log(`using cached ${path}`);
			return path;
		}
		console.log("cached file does not match the index, re-downloading");
	}

	const res = await get(`${repoUrl}/${filename}`);
	if (!res.body) die("empty response body for the .deb");

	const hasher = new Bun.CryptoHasher("sha256");
	const sink = Bun.file(path).writer();
	let done = 0;
	for await (const chunk of res.body) {
		hasher.update(chunk);
		sink.write(chunk);
		done += chunk.byteLength;
		process.stderr.write(`\r  ${humanMiB(done)} / ${humanMiB(wantSize)} (${((done / wantSize) * 100).toFixed(1)}%)`);
	}
	await sink.end();
	process.stderr.write("\n");

	if (done !== wantSize) die(`.deb: got ${done} bytes, index says ${wantSize}`);
	const got = hasher.digest("hex");
	if (got !== wantSha) {
		rmSync(path, { force: true }); // don't leave a bad file to be "cached" next time
		die(`.deb: sha256 mismatch\n  expected ${wantSha}\n  got      ${got}`);
	}
	console.log(`sha256 ok (${got})`);
	return path;
}

/** Unpack the data archive. Maintainer scripts are not run and cannot be run this way. */
export async function unpack(deb: string, into: string): Promise<string> {
	await $`dpkg-deb -x ${deb} ${into}`;
	return into;
}

/**
 * Which subtree of the unpacked .deb becomes <dest>/<package>.
 *
 * A self-contained app ships everything under usr/, so usr/bin and usr/share
 * become <dest>/<package>/{bin,share}. One that targets /opt already has the
 * final layout under opt/<package>. Anything else is ambiguous, so say so and
 * install the whole tree.
 */
export function chooseSubtree(root: string, pkgName: string): string {
	const top = readdirSync(root).filter((e) => statSync(join(root, e)).isDirectory());
	if (top.length === 1 && top[0] === "usr") return "usr";
	if (existsSync(join(root, "opt", pkgName))) return join("opt", pkgName);
	console.log(`note: unpacked tree has top-level ${top.join(", ")}; installing all of it (override with --from)`);
	return ".";
}
