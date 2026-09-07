/**
 * Reading and extracting the tar stream inside a .deb.
 *
 * The parsing is node-tar's. tar has enough dialects — v7, pre-POSIX ustar, GNU
 * long names, pax extended headers, base-256 numeric fields — that a second
 * parser would mostly be a source of new bugs. `debformat.test.ts` checks this
 * one against `dpkg-deb` on real packages.
 *
 * The *writing* is ours, because node-tar's extractor is deliberately safer
 * than a package installer is allowed to be. It drops setuid and setgid bits,
 * and it rewrites absolute symlink targets, so a package would install and then
 * quietly not work — `chrome-sandbox`, in every Electron .deb, is exactly that
 * file. It also refuses to create a symlink whose target passes through another
 * symlink, which is the ordinary shape of a versioned framework and costs you
 * three real symlinks in, say, GNUstep's libnetclasses0. So entries are parsed
 * by node-tar and placed by us: faithfully, and inside a directory they are not
 * allowed to leave.
 *
 * What that containment means here, concretely:
 *
 *   - absolute paths and `..` components are refused, not stripped. GNU tar
 *     strips them and carries on; for a program whose failures are fatal, a
 *     .deb containing one is a .deb to stop on.
 *   - nothing is written through a symlink. Every parent directory is one this
 *     code created, and an entry that would land on an existing symlink has it
 *     removed first — so a package cannot plant a link and write through it on
 *     a later entry.
 *   - hard links must resolve inside the tree.
 *   - device nodes and fifos are refused. Nothing belonging under <dest>/<pkg>
 *     needs one, and creating them needs privileges this program never takes.
 */

import {
	chmodSync,
	createWriteStream,
	linkSync,
	lstatSync,
	lutimesSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Parser } from "tar";

/** Place every entry of `src` under `into`. Throws on the first refusal. */
export async function extractTar(src: ReadableStream<Uint8Array>, into: string): Promise<void> {
	const root = resolve(into);
	mkdirSync(root, { recursive: true });

	/** Directories this code made, so ancestors aren't re-checked per entry. */
	const ours = new Set<string>([root]);
	/** File bodies stream while parsing continues; all must land before we finish. */
	const writes: Promise<void>[] = [];
	/** Applied at the end: writing a child bumps the mtime of its directory. */
	const dirTimes = new Map<string, Date>();
	/** Also deferred: a hard link's target is a body that is still streaming. */
	const hardLinks: { from: string; to: string }[] = [];
	let refusal: Error | undefined;

	const parser = new Parser({
		onReadEntry(entry: any) {
			if (refusal) {
				entry.resume();
				return;
			}
			try {
				const write = place(root, ours, dirTimes, hardLinks, entry);
				if (write) writes.push(write);
				else entry.resume();
			} catch (e) {
				refusal ??= e as Error;
				entry.resume();
			}
		},
	});

	await pipeline(Readable.fromWeb(src as any), parser);
	// A body still in flight can fail after the parser is done with it.
	const settled = await Promise.allSettled(writes);
	if (refusal) throw refusal;
	for (const s of settled) if (s.status === "rejected") throw s.reason;

	for (const { from, to } of hardLinks) linkSync(from, to);
	for (const [dir, mtime] of dirTimes) utimesSync(dir, mtime, mtime);
}

/** The contents of one file in a tar, or null if it holds no such file. */
export async function readTarEntry(src: ReadableStream<Uint8Array>, want: string): Promise<string | null> {
	let found: string | null = null;
	const parser = new Parser({
		onReadEntry(entry: any) {
			const path = String(entry.path).replace(/^\.\//, "");
			if (found !== null || path !== want) {
				entry.resume();
				return;
			}
			const chunks: Buffer[] = [];
			entry.on("data", (c: Buffer) => chunks.push(c));
			entry.on("end", () => {
				found = Buffer.concat(chunks).toString("utf8");
			});
		},
	});
	await pipeline(Readable.fromWeb(src as any), parser);
	return found;
}

/**
 * Put one entry in place. Metadata operations are synchronous so that the tar's
 * own ordering is preserved — a directory exists before its children are
 * written — while a file body is returned as a promise to stream in the
 * background. Returns null when the entry needs no body.
 */
function place(
	root: string,
	ours: Set<string>,
	dirTimes: Map<string, Date>,
	hardLinks: { from: string; to: string }[],
	entry: any,
): Promise<void> | null {
	const rel = String(entry.path);
	const type = String(entry.type);
	const target = safeJoin(root, rel);
	const mtime = entry.mtime instanceof Date ? entry.mtime : undefined;

	if (type === "Directory") {
		if (target !== root) {
			makeDir(root, ours, target);
			chmodSync(target, typeof entry.mode === "number" ? entry.mode & 0o7777 : 0o755);
		}
		if (mtime) dirTimes.set(target, mtime);
		return null;
	}

	if (type === "CharacterDevice" || type === "BlockDevice" || type === "FIFO") {
		throw new Error(`refusing ${rel}: a .deb installed this way may not contain device nodes or fifos`);
	}

	makeDir(root, ours, dirname(target));
	// An earlier entry may have left a symlink exactly here; writing to it would
	// write through it. Remove whatever is there before creating anything.
	rmSync(target, { force: true });

	if (type === "SymbolicLink") {
		// The target is data, recorded as the package wrote it and never followed.
		symlinkSync(String(entry.linkpath), target);
		// lutimes, not utimes: the link's own mtime, not that of whatever it
		// points at — which at this moment may not have been written yet.
		if (mtime) lutimesSync(target, mtime, mtime);
		return null;
	}

	if (type === "Link") {
		// Deferred: the file this points at is very likely still streaming. The
		// path is checked now, while there is still an entry to name in the error.
		hardLinks.push({ from: safeJoin(root, String(entry.linkpath)), to: target });
		return null;
	}

	if (type !== "File" && type !== "ContiguousFile") {
		throw new Error(`refusing ${rel}: unsupported tar entry type ${type}`);
	}

	const mode = typeof entry.mode === "number" ? entry.mode & 0o7777 : 0o644;
	return pipeline(entry, createWriteStream(target)).then(() => {
		// chmod after the write: the open() mode is masked by the umask, and
		// setuid is exactly the bit a package needs kept.
		chmodSync(target, mode);
		if (mtime) utimesSync(target, mtime, mtime);
	});
}

/** Create a directory and any missing parent, refusing to walk through a symlink. */
function makeDir(root: string, ours: Set<string>, dir: string): void {
	if (ours.has(dir)) return;
	const parent = dirname(dir);
	if (parent !== dir && parent.startsWith(root)) makeDir(root, ours, parent);

	try {
		const st = lstatSync(dir);
		if (st.isSymbolicLink()) throw new Error(`refusing to write through the symlink ${dir.slice(root.length + 1)}`);
		if (!st.isDirectory()) rmSync(dir, { force: true, recursive: true });
		else {
			ours.add(dir);
			return;
		}
	} catch (e: any) {
		if (e?.code !== "ENOENT") throw e;
	}
	mkdirSync(dir, { recursive: false, mode: 0o755 });
	ours.add(dir);
}

/**
 * Resolve an archive path against the root, refusing anything that leaves it.
 * Rejecting beats stripping: `dpkg-deb -x` hands `../../etc/passwd` to GNU tar,
 * which quietly turns it into `etc/passwd` and installs it.
 */
function safeJoin(root: string, path: string): string {
	const norm = path.replace(/\/+$/, "");
	if (norm === "" || norm === ".") return root;
	if (norm.startsWith("/")) throw new Error(`refusing ${path}: absolute paths are not allowed in a .deb`);
	if (norm.split("/").some((s) => s === "..")) throw new Error(`refusing ${path}: it points outside the package`);

	const full = join(root, norm);
	if (full !== root && !full.startsWith(root + sep)) throw new Error(`refusing ${path}: it points outside the package`);
	return full;
}
