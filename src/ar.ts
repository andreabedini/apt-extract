/**
 * The `ar` archive that a .deb is, read to deb(5).
 *
 * deb(5) restricts ar rather than extending it: no long-name extensions, member
 * names of at most fifteen characters, and three members in a fixed order.
 * Reading it strictly is the point. A file needing a GNU name table, or holding
 * a second control member, is not a .deb — and resolving such a thing helpfully,
 * by name with the last one winning, is how a reader ends up disagreeing with
 * dpkg about what a package contains. A signature cannot help with that kind of
 * disagreement, because both readers verified the same bytes.
 *
 * Members are located, not read. A .deb's data member is routinely larger than
 * memory, so callers stream it.
 */

const MAGIC = "!<arch>\n";
const HEADER = 60;

/** Where a member's bytes are, so they can be read or streamed on demand. */
export type MemberRef = { name: string; offset: number; size: number };

export type DebMembers = {
	/** the format version from debian-binary, e.g. "2.0" */
	version: string;
	control: MemberRef;
	data: MemberRef;
	/** members past data.tar, which deb(5) says to ignore */
	extra: MemberRef[];
};

/** Walk the member headers. Only headers are read; bodies are left on disk. */
export async function readMembers(path: string): Promise<MemberRef[]> {
	const file = Bun.file(path);
	const total = file.size;
	if (total < MAGIC.length) throw new Error("too small to be a .deb");

	const magic = await file.slice(0, MAGIC.length).text();
	if (magic !== MAGIC) {
		// deb-old(5): two ASCII lines then two gzipped tars. Nothing has produced
		// one since Debian 0.93, but saying so beats "bad magic".
		if (magic.startsWith("0.939000")) throw new Error("this is a pre-0.93 .deb (deb-old format), which is not supported");
		throw new Error("not a .deb: missing the ar magic");
	}

	const members: MemberRef[] = [];
	let off = MAGIC.length;
	while (off < total) {
		if (off + HEADER > total) throw new Error("truncated ar header");
		const h = await file.slice(off, off + HEADER).text();
		if (h.slice(58, 60) !== "`\n") throw new Error("malformed ar header");

		const raw = h.slice(0, 16);
		// GNU keeps long names in a `//` member and refers to them as `/N`; BSD
		// writes `#1/N` and prepends the name to the body. deb(5) permits neither,
		// so a .deb using one is malformed rather than merely exotic.
		if (raw.startsWith("/") || raw.startsWith("#1/")) {
			throw new Error(`ar long-name extension is not allowed in a .deb: ${raw.trim()}`);
		}
		const name = raw.replace(/\s+$/, "").replace(/\/$/, "");

		const sizeField = h.slice(48, 58).trim();
		if (!/^\d{1,10}$/.test(sizeField)) throw new Error(`malformed size in the header for ${name || "an unnamed member"}`);
		const size = Number(sizeField);
		if (off + HEADER + size > total) throw new Error(`member ${name} runs past the end of the file`);

		members.push({ name, offset: off + HEADER, size });
		off += HEADER + size + (size % 2); // bodies are padded to an even offset
	}
	return members;
}

/**
 * The three members deb(5) requires, in the order it requires them.
 *
 * Position is what identifies them, not name: that is the difference between
 * "the control member" and "a member called control.tar", and only the first
 * is something a package can't equivocate about.
 */
export async function debMembers(path: string): Promise<DebMembers> {
	const members = await readMembers(path);
	const [first, control, data] = members;

	if (!first || first.name !== "debian-binary") throw new Error("not a .deb: the first member is not debian-binary");
	const version = (await memberText(path, first)).trim();
	const major = Number(version.split(".")[0]);
	if (!Number.isFinite(major)) throw new Error(`unreadable .deb format version ${JSON.stringify(version)}`);
	if (major !== 2) throw new Error(`.deb format version ${version} is not supported (this reads 2.x)`);

	if (!control?.name.startsWith("control.tar")) throw new Error("not a .deb: the second member is not control.tar");
	if (!data?.name.startsWith("data.tar")) throw new Error("not a .deb: the third member is not data.tar");

	return { version, control, data, extra: members.slice(3) };
}

export async function memberBytes(path: string, m: MemberRef): Promise<Uint8Array> {
	return new Uint8Array(await Bun.file(path).slice(m.offset, m.offset + m.size).arrayBuffer());
}

export async function memberText(path: string, m: MemberRef): Promise<string> {
	return Bun.file(path).slice(m.offset, m.offset + m.size).text();
}

export function memberStream(path: string, m: MemberRef): ReadableStream<Uint8Array> {
	return Bun.file(path).slice(m.offset, m.offset + m.size).stream();
}
