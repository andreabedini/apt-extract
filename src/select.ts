/** Choosing which version to install, and showing the options. */

import type { Stanza } from "./control.ts";
import { die, humanMiB } from "./util.ts";

export function listVersions(sorted: Stanza[], installed: string | null): void {
	sorted.forEach((p, i) => {
		const version = p.get("Version") ?? "?";
		const tags = [version === installed ? "installed" : "", i === sorted.length - 1 ? "newest" : ""].filter(Boolean);
		console.log(
			`  ${String(i + 1).padStart(3)}. ${version.padEnd(16)} ${humanMiB(Number(p.get("Size"))).padStart(10)}` +
				(tags.length ? `  <- ${tags.join(", ")}` : ""),
		);
	});
}

export type Choice = { version?: string | undefined; pick: boolean };

/**
 * Newest by default; an exact `--version` if asked; otherwise a numbered
 * prompt. The prompt accepts either the list number or the version string,
 * and an empty answer keeps the default.
 */
export function choose(sorted: Stanza[], choice: Choice, installed: string | null): Stanza {
	const newest = sorted.at(-1)!;

	if (choice.version) {
		const found = sorted.find((p) => p.get("Version") === choice.version);
		if (found) return found;
		die(`version ${choice.version} is not in the index; available: ${sorted.map((p) => p.get("Version")).join(", ")}`);
	}

	if (!choice.pick) return newest;
	if (!process.stdin.isTTY) die("--pick needs a terminal; use --version instead");

	listVersions(sorted, installed);
	const answer = prompt(`version to install [${newest.get("Version")}]:`)?.trim();
	if (!answer) return newest;

	const n = Number(answer);
	if (Number.isInteger(n) && n >= 1 && n <= sorted.length) return sorted[n - 1]!;
	const byName = sorted.find((p) => p.get("Version") === answer);
	if (byName) return byName;
	die(`not a listed version or number: ${answer}`);
}
