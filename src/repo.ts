/**
 * Reading an apt repository, with the chain of trust intact at every hop:
 * the signature vouches for the Release, the Release vouches for the package
 * index, and the index vouches for the .deb.
 */

import { $ } from "bun";
import { join } from "node:path";
import { parseControl, parseRelease, type Release, type Stanza } from "./control.ts";
import { verifyClearsigned } from "./gpg.ts";
import { die, get, sha256 } from "./util.ts";
import { compareVersions } from "./version.ts";

/** Where a package lives: the coordinates from a sources.list "deb" line, plus arch. */
export type RepoRef = {
	/** base URL, no trailing slash */
	url: string;
	suite: string;
	component: string;
	arch: string;
};

export type Trust = { fingerprint: string; keyring?: string };

/** Fetch dists/<suite>/InRelease, verify it, and reject an expired index. */
export async function fetchRelease(ref: RepoRef, trust: Trust, work: string): Promise<Release> {
	const path = join(work, "InRelease");
	await Bun.write(path, await (await get(`${ref.url}/dists/${ref.suite}/InRelease`)).text());
	const rel = parseRelease(await verifyClearsigned(path, trust.fingerprint, trust.keyring));

	const validUntil = rel.fields.get("Valid-Until");
	if (validUntil && new Date(validUntil) < new Date()) {
		die(`the repository index expired on ${validUntil} — refusing to trust a stale index`);
	}
	return rel;
}

/**
 * Fetch the package index the signed Release vouches for, preferring the
 * compressed one, and check it against the hash from that Release.
 */
export async function fetchPackages(rel: Release, ref: RepoRef): Promise<Stanza[]> {
	const name = [`${ref.component}/binary-${ref.arch}/Packages.gz`, `${ref.component}/binary-${ref.arch}/Packages`].find(
		(c) => rel.hashes.has(c),
	);
	if (!name) {
		const present = [...rel.hashes.keys()].filter((k) => k.includes("binary-"));
		die(
			`the signed Release lists no index for ${ref.component}/${ref.arch}.\n` +
				`  it has: ${present.join(", ") || "(nothing)"}`,
		);
	}
	const want = rel.hashes.get(name)!;

	const raw = new Uint8Array(await (await get(`${ref.url}/dists/${ref.suite}/${name}`)).arrayBuffer());
	if (raw.byteLength !== want.size) die(`${name}: got ${raw.byteLength} bytes, Release says ${want.size}`);
	const got = sha256(raw);
	if (got !== want.sha256) die(`${name}: sha256 mismatch\n  expected ${want.sha256}\n  got      ${got}`);

	const bytes = name.endsWith(".gz") ? Bun.gunzipSync(raw) : raw;
	return parseControl(new TextDecoder().decode(bytes));
}

/** The stanzas for one binary package on one architecture, oldest version first. */
export async function versionsOf(index: Stanza[], pkg: string, arch: string): Promise<Stanza[]> {
	const sorted = index
		.filter((p) => p.get("Package") === pkg && p.get("Architecture") === arch)
		.sort((a, b) => compareVersions(a.get("Version") ?? "", b.get("Version") ?? ""));

	// dpkg is the authority on version ordering; make sure our port agrees.
	for (let i = 1; i < sorted.length; i++) {
		const lo = sorted[i - 1]!.get("Version")!;
		const hi = sorted[i]!.get("Version")!;
		if ((await $`dpkg --compare-versions ${lo} le ${hi}`.quiet().nothrow()).exitCode !== 0) {
			die(`version ordering disagrees with dpkg: put ${lo} before ${hi}`);
		}
	}
	return sorted;
}
