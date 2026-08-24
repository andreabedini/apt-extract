/**
 * OpenPGP verification of a repository index.
 *
 * This program never fetches keys: a key retrieved over the same channel as the
 * thing it authenticates proves very little. The key must already be in a
 * keyring, and the caller must say which fingerprint it expects.
 */

import { $ } from "bun";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { die } from "./util.ts";

/** Accept fingerprints as gpg prints them, with spaces and any case. */
export function normalizeFingerprint(fpr: string): string {
	return fpr.replace(/\s+/g, "").toUpperCase();
}

/**
 * Verify a clearsigned document and return its body.
 *
 * gpg exits 0 for a good signature from a key you hold but have never
 * certified, so the exit code alone is not a decision — the VALIDSIG
 * fingerprint is. Comparing it to a pinned value is what makes "signed"
 * mean "signed by the party we meant".
 */
export async function verifyClearsigned(path: string, fingerprint: string, keyring?: string): Promise<string> {
	const args = keyring ? ["--no-default-keyring", "--keyring", keyring] : [];
	const res = await $`gpg ${args} --status-fd 1 --verify ${path}`.quiet().nothrow();
	const status = res.stdout.toString();

	if (status.includes("[GNUPG:] NO_PUBKEY")) {
		const id = status.split("NO_PUBKEY ")[1]?.split("\n")[0]?.trim() ?? "?";
		die(
			`the index is signed by key ${id}, which is not in ${keyring ?? "your keyring"}.\n` +
				`  import it out of band first, e.g.:  curl -fsSL <key-url> | gpg --import`,
		);
	}
	if (res.exitCode !== 0) die(`signature check failed for ${basename(path)}:\n${res.stderr.toString().trim()}`);

	const validsig = status.split("\n").find((l) => l.startsWith("[GNUPG:] VALIDSIG "));
	const signer = validsig?.split(/\s+/)[2];
	if (!signer) die(`gpg reported no VALIDSIG for ${basename(path)}:\n${status.trim()}`);
	if (normalizeFingerprint(signer) !== fingerprint) {
		die(`${basename(path)} is signed by ${signer}, not by the expected ${fingerprint}`);
	}

	return clearsignedBody(readFileSync(path, "utf8"), basename(path));
}

/** The signed payload of a clearsigned document: between the armor headers and the signature. */
export function clearsignedBody(text: string, label = "document"): string {
	const start = text.indexOf("\n\n");
	const end = text.indexOf("-----BEGIN PGP SIGNATURE-----");
	if (start === -1 || end === -1) die(`${label} is not a clearsigned document`);
	return text
		.slice(start + 2, end)
		.split("\n")
		.map((l) => (l.startsWith("- ") ? l.slice(2) : l)) // undo dash-escaping
		.join("\n");
}
