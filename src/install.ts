/** Putting the unpacked tree in place, and remembering what was installed. */

import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STAMP = ".installed.json";

/** Provenance, written inside the installed tree so the next run can compare. */
export type Stamp = {
	package: string;
	version: string;
	architecture: string;
	subtree: string;
	/** where it came from: a repository base URL, or the .deb's path or URL */
	source: string;
	/** the digest of the .deb that was unpacked */
	sha256: string;
	/**
	 * What that digest rests on. "signed-index" is the whole chain — a pinned
	 * signature over the Release, which vouches for the index, which vouches
	 * for the .deb. "sha256" is a digest the caller supplied out of band, and
	 * "none" means a .deb was named directly and nothing vouched for it. It is
	 * recorded because "installed from a signed repository" and "installed from
	 * a file I found" are different things to have on disk.
	 */
	trust: "signed-index" | "sha256" | "none";
	/** repository suite, when it came from a repository */
	suite?: string;
};

export function readStamp(dest: string): Stamp | null {
	const path = join(dest, STAMP);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Stamp;
	} catch {
		return null;
	}
}

/** The installed version, or null if nothing this tool installed is there. */
export function installedVersion(dest: string): string | null {
	return readStamp(dest)?.version ?? null;
}

/** How to describe the destination when there is no stamp to read. */
export function describeInstalled(dest: string): string {
	return installedVersion(dest) ?? (existsSync(dest) ? "unknown (no version stamp)" : "not installed");
}

/**
 * Copy the staged subtree over <dest>, with sudo.
 *
 * The stamp is written into the staged tree rather than into <dest> so it
 * survives `rsync --delete`, which is there so files dropped between releases
 * don't linger. Note that --delete also removes anything hand-added to <dest>.
 */
export async function installTree(staged: string, dest: string, stamp: Stamp): Promise<void> {
	await Bun.write(join(staged, STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
	await $`sudo -v`; // prompt for the password before the slow part, not during
	await $`sudo mkdir -p ${dest}`;
	await $`sudo rsync -a --delete ${`${staged}/`} ${`${dest}/`}`;
}
