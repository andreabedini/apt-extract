/** Putting the unpacked tree in place, and remembering what was installed. */

import { $ } from "bun";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const STAMP = ".installed.json";

/** Provenance, written inside the installed tree so the next run can compare. */
export type Stamp = {
	package: string;
	version: string;
	repo: string;
	suite: string;
	architecture: string;
	subtree: string;
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
