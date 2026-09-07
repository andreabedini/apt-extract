/** Fetching and unpacking the .deb itself, whether an index named it or you did. */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { debMembers, memberStream } from "./ar.ts";
import { decompressStream } from "./compress.ts";
import { parseControl, type Stanza } from "./control.ts";
import { extractTar, readTarEntry } from "./tar.ts";
import { die, get, hashFile, humanMiB } from "./util.ts";

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
		if (statSync(path).size === wantSize && (await hashFile(path)) === wantSha) {
			console.log(`using cached ${path}`);
			return path;
		}
		console.log("cached file does not match the index, re-downloading");
	}

	const got = await streamToFile(await get(`${repoUrl}/${filename}`), path, wantSize);

	if (got.bytes !== wantSize) die(`.deb: got ${got.bytes} bytes, index says ${wantSize}`);
	if (got.sha256 !== wantSha) {
		rmSync(path, { force: true }); // don't leave a bad file to be "cached" next time
		die(`.deb: sha256 mismatch\n  expected ${wantSha}\n  got      ${got.sha256}`);
	}
	console.log(`sha256 ok (${got.sha256})`);
	return path;
}

/**
 * Does this argument name a .deb directly rather than a repository?
 *
 * A repository base URL needs a package name beside it, so a lone argument
 * that looks like a file — a .deb suffix, or a path that exists — is one.
 */
export function isDebArgument(arg: string): boolean {
	if (isUrl(arg)) {
		try {
			return new URL(arg).pathname.toLowerCase().endsWith(".deb");
		} catch {
			return false;
		}
	}
	return arg.toLowerCase().endsWith(".deb") || (existsSync(arg) && statSync(arg).isFile());
}

export function isUrl(arg: string): boolean {
	return /^https?:\/\//i.test(arg);
}

/**
 * Get hold of a .deb named directly, by path or by URL.
 *
 * Nothing vouches for such a file: there is no signed index to check it
 * against, so the digest is reported and only *checked* when the caller
 * supplies one. That is the honest position — saying "sha256 ok" about a hash
 * of whatever arrived would mean nothing at all.
 */
export async function obtainDeb(
	arg: string,
	cache: string,
	expected?: string,
): Promise<{ path: string; sha256: string }> {
	if (!isUrl(arg)) {
		const path = resolve(arg);
		if (!existsSync(path) || !statSync(path).isFile()) die(`no such file: ${arg}`);
		return { path, sha256: reportDigest(await hashFile(path), expected, null) };
	}

	mkdirSync(cache, { recursive: true });
	const path = join(cache, basename(new URL(arg).pathname) || "download.deb");

	// Without an expected digest there is nothing a cached file could be
	// checked against, so it is fetched again rather than trusted by name.
	if (expected && existsSync(path) && (await hashFile(path)) === expected) {
		console.log(`using cached ${path}`);
		return { path, sha256: expected };
	}

	const res = await get(arg);
	const total = Number(res.headers.get("content-length")) || undefined;
	const got = await streamToFile(res, path, total);
	return { path, sha256: reportDigest(got.sha256, expected, path) };
}

/** The .deb's own control stanza — where the package name and version come from. */
export async function debControl(path: string): Promise<Stanza> {
	const text = await reading(path, async () => {
		const members = await debMembers(path);
		const control = decompressStream(members.control.name, memberStream(path, members.control));
		return readTarEntry(control, "control");
	});
	if (text === null) die(`${basename(path)} has no control file inside its control member`);

	const stanza = parseControl(text)[0];
	if (!stanza?.get("Package")) die(`${basename(path)} has no Package field in its control data`);
	return stanza;
}

/** Unpack the data archive. Maintainer scripts are not run and cannot be run this way. */
export async function unpack(deb: string, into: string): Promise<string> {
	await reading(deb, async () => {
		const members = await debMembers(deb);
		await extractTar(decompressStream(members.data.name, memberStream(deb, members.data)), into);
	});
	return into;
}

/**
 * The seam between the format readers and this program.
 *
 * `src/ar.ts` and `src/tar.ts` throw, so that what they refuse can be tested
 * directly rather than through a subprocess; here that becomes the fatal error
 * every other failure in this tool already is.
 */
async function reading<T>(path: string, read: () => Promise<T>): Promise<T> {
	try {
		return await read();
	} catch (e) {
		return die(`${basename(path)}: ${e instanceof Error ? e.message : String(e)}`);
	}
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

/** Stream a response to disk, hashing as it goes so the payload is never held in memory. */
async function streamToFile(res: Response, path: string, total?: number): Promise<{ bytes: number; sha256: string }> {
	if (!res.body) die("empty response body for the .deb");

	const hasher = new Bun.CryptoHasher("sha256");
	const sink = Bun.file(path).writer();
	let done = 0;
	for await (const chunk of res.body) {
		hasher.update(chunk);
		sink.write(chunk);
		done += chunk.byteLength;
		const of = total ? ` / ${humanMiB(total)} (${((done / total) * 100).toFixed(1)}%)` : "";
		process.stderr.write(`\r  ${humanMiB(done)}${of}`);
	}
	await sink.end();
	process.stderr.write("\n");

	return { bytes: done, sha256: hasher.digest("hex") };
}

/**
 * Report the digest of a directly-named .deb, and check it if we were told
 * what to expect. `discard` is the file to remove on a mismatch, so a bad
 * download can't linger in the cache; null for a file we did not fetch.
 */
function reportDigest(got: string, expected: string | undefined, discard: string | null): string {
	if (!expected) {
		console.log(`sha256 ${got}`);
		console.log("warning: no signed index and no --sha256 — nothing vouches for this file");
		return got;
	}
	if (got !== expected) {
		if (discard) rmSync(discard, { force: true });
		die(`.deb: sha256 mismatch\n  expected ${expected}\n  got      ${got}`);
	}
	console.log(`sha256 ok (${got})`);
	return got;
}
