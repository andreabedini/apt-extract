/** Parsers for Debian control-file metadata (Packages, Release). */

/** One control stanza, flattened to simple fields (folded continuations dropped). */
export type Stanza = Map<string, string>;

/** Split a control file into stanzas. Blank-line separated, `Key: value` fields. */
export function parseControl(text: string): Stanza[] {
	return text
		.split(/\n\n+/)
		.filter((s) => s.trim() !== "")
		.map((stanza) => {
			const fields: Stanza = new Map();
			for (const line of stanza.split("\n")) {
				if (line.startsWith(" ") || line.startsWith("\t")) continue; // folded continuation
				const colon = line.indexOf(":");
				if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
			}
			return fields;
		});
}

export type Release = {
	fields: Map<string, string>;
	/** path relative to dists/<suite>/ -> the hash and size the Release vouches for */
	hashes: Map<string, { sha256: string; size: number }>;
};

/**
 * Parse a Release body: simple fields, plus the indented file list under
 * `SHA256:`. The weaker MD5Sum/SHA1 lists are deliberately ignored.
 */
export function parseRelease(body: string): Release {
	const fields = new Map<string, string>();
	const hashes = new Map<string, { sha256: string; size: number }>();
	let inSha256 = false;
	for (const line of body.split("\n")) {
		if (line.startsWith(" ")) {
			if (!inSha256) continue;
			const [hash, size, name] = line.trim().split(/\s+/);
			if (hash && size && name) hashes.set(name, { sha256: hash, size: Number(size) });
			continue;
		}
		inSha256 = line.startsWith("SHA256:");
		const colon = line.indexOf(":");
		if (colon > 0) fields.set(line.slice(0, colon), line.slice(colon + 1).trim());
	}
	return { fields, hashes };
}
