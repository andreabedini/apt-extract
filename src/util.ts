/** Small shared helpers. */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Print a message and stop. Every failure in this tool is fatal by design. */
export function die(msg: string): never {
	console.error(`error: ${msg}`);
	process.exit(1);
}

/** fetch() that refuses to return a non-2xx response. */
export async function get(url: string): Promise<Response> {
	const res = await fetch(url);
	if (!res.ok) die(`GET ${url} -> ${res.status} ${res.statusText}`);
	return res;
}

export function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

export function humanMiB(bytes: number): string {
	return `${(bytes / 1048576).toFixed(1)} MiB`;
}

/**
 * Where downloaded .deb files are kept.
 *
 * Not beside the source: a compiled binary's import.meta.dir points into Bun's
 * read-only embedded filesystem, and a binary installed on $PATH has no source
 * tree to sit next to anyway.
 */
export function cacheDir(): string {
	const xdg = process.env.XDG_CACHE_HOME;
	return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".cache"), "apt-extract");
}

/** sha256 of a file, read in chunks — a .deb can be hundreds of MiB. */
export async function hashFile(path: string): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
	return hasher.digest("hex");
}
