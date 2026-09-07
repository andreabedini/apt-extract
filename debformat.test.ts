// What the .deb reader accepts and — mostly — what it refuses.
//
// The interesting cases here cannot be produced by `tar` and `ar`: an archive
// with `../..` in a path, or one that plants a symlink and then writes through
// it, is exactly what those tools decline to create. So the fixtures are built
// byte by byte, which is also how a hostile .deb would be built.
//
// No network, no dpkg, no tar. The xz and bzip2 fixtures are embedded because
// neither can be produced from JavaScript, and skipping them when the compressor
// is missing would mean never running them.

import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { debMembers, memberStream, readMembers } from "./src/ar.ts";
import { compressionOf, decompressBytes, decompressStream } from "./src/compress.ts";
import { DEBIAN_ARCH } from "./src/arch.ts";
import { extractTar, readTarEntry } from "./src/tar.ts";

const enc = new TextEncoder();

// ---------------------------------------------------------------- fixtures

type Entry = { path: string; type?: string; link?: string; body?: string; mode?: number };

/** A GNU-format tar, the dialect dpkg writes. */
function tar(entries: Entry[]): Uint8Array<ArrayBuffer> {
	const blocks: Uint8Array[] = [];
	for (const e of entries) {
		const long = enc.encode(e.path).length > 100;
		if (long) {
			// GNU long name: an 'L' entry whose body is the real path.
			blocks.push(...block({ path: "././@LongLink", type: "L", body: e.path }));
		}
		blocks.push(...block(long ? { ...e, path: e.path.slice(0, 100) } : e));
	}
	blocks.push(new Uint8Array(1024)); // end of archive
	return concat(blocks);
}

function block(e: Entry): Uint8Array[] {
	const h = new Uint8Array(512);
	const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
	put(e.path, 0, 100);
	put((e.mode ?? 0o644).toString(8).padStart(7, "0"), 100, 8);
	put("0000000", 108, 8);
	put("0000000", 116, 8);
	const body = enc.encode(e.body ?? "");
	put(body.length.toString(8).padStart(11, "0"), 124, 12);
	put("14000000000", 136, 12); // a fixed mtime, so the fixtures are reproducible
	h.set(enc.encode("        "), 148); // checksum is summed with this field as spaces
	h[156] = (e.type ?? "0").charCodeAt(0);
	put(e.link ?? "", 157, 100);
	put("ustar  ", 257, 8);
	let sum = 0;
	for (const b of h) sum += b;
	put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);

	const out = [h];
	if (body.length) {
		const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
		padded.set(body);
		out.push(padded);
	}
	return out;
}

/** An ar archive, so member order and names can be made wrong on purpose. */
function ar(members: [string, Uint8Array][]): Uint8Array {
	const parts: Uint8Array[] = [enc.encode("!<arch>\n")];
	for (const [name, body] of members) {
		parts.push(
			enc.encode(
				name.padEnd(16) + "0".padEnd(12) + "0".padEnd(6) + "0".padEnd(6) + "100644".padEnd(8) + String(body.length).padEnd(10) + "`\n",
			),
			body,
		);
		if (body.length % 2) parts.push(new Uint8Array(1));
	}
	return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const p of parts) {
		out.set(p, at);
		at += p.length;
	}
	return out;
}

const CONTROL = tar([{ path: "./control", body: "Package: fixture\nVersion: 1.0\nArchitecture: all\n" }]);

/** Write a .deb to disk and hand back its path. */
function deb(dir: string, name: string, data: Uint8Array, control = CONTROL, dataName = "data.tar"): string {
	const path = join(dir, name);
	writeFileSync(
		path,
		ar([
			["debian-binary", enc.encode("2.0\n")],
			["control.tar", control],
			[dataName, data],
		]),
	);
	return path;
}

function work(): string {
	return mkdtempSync(join(tmpdir(), "debformat-"));
}

function bytes(data: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(c) {
			c.enqueue(data);
			c.close();
		},
	});
}

// ------------------------------------------------------------------- ar

test("reads the three members deb(5) requires", async () => {
	const dir = work();
	try {
		const m = await debMembers(deb(dir, "ok.deb", tar([{ path: "./usr/", type: "5", mode: 0o755 }])));
		expect(m.version).toBe("2.0");
		expect(m.control.name).toBe("control.tar");
		expect(m.data.name).toBe("data.tar");
		expect(m.extra).toEqual([]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("members past data.tar are ignored, as deb(5) says to", async () => {
	const dir = work();
	try {
		const path = join(dir, "extra.deb");
		writeFileSync(
			path,
			ar([
				["debian-binary", enc.encode("2.0\n")],
				["control.tar", CONTROL],
				["data.tar", tar([])],
				["_gpgorigin", enc.encode("signature")],
			]),
		);
		const m = await debMembers(path);
		expect(m.extra.map((e) => e.name)).toEqual(["_gpgorigin"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the members are identified by position, not by name", async () => {
	const dir = work();
	try {
		// data before control: a name-keyed reader would accept this happily.
		const path = join(dir, "swapped.deb");
		writeFileSync(
			path,
			ar([
				["debian-binary", enc.encode("2.0\n")],
				["data.tar", tar([])],
				["control.tar", CONTROL],
			]),
		);
		expect(debMembers(path)).rejects.toThrow(/second member is not control.tar/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a non-.deb, an old-format .deb and a future version are each refused", async () => {
	const dir = work();
	try {
		const notAr = join(dir, "plain");
		writeFileSync(notAr, "just a file\n");
		expect(readMembers(notAr)).rejects.toThrow(/missing the ar magic/);

		const old = join(dir, "old.deb");
		writeFileSync(old, "0.939000\n1234\n");
		expect(readMembers(old)).rejects.toThrow(/deb-old/);

		const future = join(dir, "future.deb");
		writeFileSync(
			future,
			ar([
				["debian-binary", enc.encode("3.0\n")],
				["control.tar", CONTROL],
				["data.tar", tar([])],
			]),
		);
		expect(debMembers(future)).rejects.toThrow(/format version 3.0 is not supported/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("ar long-name extensions are refused rather than resolved", async () => {
	const dir = work();
	try {
		const path = join(dir, "gnu.deb");
		// A GNU name table, which deb(5) does not permit.
		writeFileSync(path, ar([["//", enc.encode("a-very-long-member-name/\n")]]));
		expect(readMembers(path)).rejects.toThrow(/long-name extension/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a member that runs past the end of the file is refused", async () => {
	const dir = work();
	try {
		const path = join(dir, "short.deb");
		const good = ar([["debian-binary", enc.encode("2.0\n")]]);
		writeFileSync(path, good.subarray(0, good.length - 2)); // lose the body
		expect(readMembers(path)).rejects.toThrow(/past the end|truncated/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ------------------------------------------------------------ compression

test("every compression deb(5) allows is read, and lzma says why it is not", async () => {
	const plain = tar([{ path: "./greeting.txt", body: "hello from a .deb\n" }]);
	const want = await readTarEntry(bytes(plain), "greeting.txt");
	expect(want).toBe("hello from a .deb\n");

	expect(compressionOf("data.tar.zst")).toBe(".zst");
	expect(compressionOf("data.tar")).toBe("");

	for (const [name, body] of [
		["data.tar", plain],
		["data.tar.gz", Bun.gzipSync(plain)],
		["data.tar.zst", Bun.zstdCompressSync(plain)],
		["data.tar.xz", Buffer.from(XZ_FIXTURE, "base64")],
		["data.tar.bz2", Buffer.from(BZ2_FIXTURE, "base64")],
	] as const) {
		const out = await decompressBytes(name, new Uint8Array(body));
		expect(await readTarEntry(bytes(out), "greeting.txt")).toBe("hello from a .deb\n");
	}

	expect(() => decompressStream("data.tar.lzma", bytes(plain))).toThrow(/lzma/);
	expect(() => decompressStream("data.tar.brotli", bytes(plain))).toThrow(/unknown compression/);
});

// -------------------------------------------------------------- extraction

test("a path that climbs out of the package is refused, not stripped", async () => {
	const dir = work();
	try {
		const into = join(dir, "into");
		await expect(
			extractTar(bytes(tar([{ path: "../../escaped", body: "no\n" }])), into),
		).rejects.toThrow(/points outside the package/);
		expect(existsSync(join(dir, "escaped"))).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an absolute path is refused", async () => {
	const dir = work();
	try {
		await expect(
			extractTar(bytes(tar([{ path: `${dir}/absolute`, body: "no\n" }])), join(dir, "into")),
		).rejects.toThrow(/absolute paths are not allowed/);
		expect(existsSync(join(dir, "absolute"))).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a package cannot plant a symlink and then write through it", async () => {
	const dir = work();
	try {
		const outside = join(dir, "outside");
		const into = join(dir, "into");
		await expect(
			extractTar(
				bytes(
					tar([
						{ path: "./usr/", type: "5", mode: 0o755 },
						{ path: "./usr/escape", type: "2", link: outside },
						{ path: "./usr/escape/planted", body: "no\n" },
					]),
				),
				into,
			),
		).rejects.toThrow(/write through the symlink/);
		expect(existsSync(join(outside, "planted"))).toBe(false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a file landing on an existing symlink replaces it instead of writing through it", async () => {
	const dir = work();
	try {
		const into = join(dir, "into");
		const target = join(dir, "target.txt");
		writeFileSync(target, "original\n");
		// A symlink is already there, as a previous install might have left one.
		mkdirSync(into, { recursive: true });
		symlinkSync(target, join(into, "file"));

		await extractTar(bytes(tar([{ path: "./file", body: "replaced\n" }])), into);
		expect(readFileSync(join(into, "file"), "utf8")).toBe("replaced\n");
		expect(readFileSync(target, "utf8")).toBe("original\n"); // untouched
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("device nodes and fifos are refused", async () => {
	const dir = work();
	try {
		await expect(
			extractTar(bytes(tar([{ path: "./dev/null", type: "3" }])), join(dir, "into")),
		).rejects.toThrow(/device nodes or fifos/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("setuid and setgid bits survive, because the package needs them", async () => {
	const dir = work();
	try {
		const into = join(dir, "into");
		await extractTar(
			bytes(
				tar([
					{ path: "./sandbox", mode: 0o4755, body: "#!/bin/sh\n" },
					{ path: "./shared", mode: 0o2755, body: "x\n" },
				]),
			),
			into,
		);
		expect(statSync(join(into, "sandbox")).mode & 0o7777).toBe(0o4755);
		expect(statSync(join(into, "shared")).mode & 0o7777).toBe(0o2755);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("symlink targets are recorded exactly as the package wrote them", async () => {
	const dir = work();
	try {
		const into = join(dir, "into");
		await extractTar(
			bytes(
				tar([
					{ path: "./usr/", type: "5", mode: 0o755 },
					// An absolute target is data, not a path we follow; it must not be rewritten.
					{ path: "./usr/alt", type: "2", link: "/etc/alternatives/thing" },
					{ path: "./usr/rel", type: "2", link: "../elsewhere" },
				]),
			),
			into,
		);
		expect(readlinkSync(join(into, "usr/alt"))).toBe("/etc/alternatives/thing");
		expect(readlinkSync(join(into, "usr/rel"))).toBe("../elsewhere");
		expect(lstatSync(join(into, "usr/alt")).isSymbolicLink()).toBe(true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mtimes are restored on files, directories and symlinks alike", async () => {
	const dir = work();
	try {
		const into = join(dir, "into");
		await extractTar(
			bytes(
				tar([
					{ path: "./usr/", type: "5", mode: 0o755 },
					{ path: "./usr/file", body: "x" },
					// A symlink needs lutimes, not utimes: utimes follows the link,
					// which here points at a file that does not exist yet.
					{ path: "./usr/link", type: "2", link: "missing" },
				]),
			),
			into,
		);
		// The fixed mtime `tar()` writes into every header.
		const want = 0o14000000000 * 1000;
		expect(lstatSync(join(into, "usr")).mtime.getTime()).toBe(want);
		expect(lstatSync(join(into, "usr/file")).mtime.getTime()).toBe(want);
		expect(lstatSync(join(into, "usr/link")).mtime.getTime()).toBe(want);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a versioned-framework symlink chain comes out whole", async () => {
	// The shape node-tar's own extractor refuses: a "Current" link, and then a
	// link whose target reaches through it. libnetclasses0 in squeeze is real.
	const dir = work();
	try {
		const into = join(dir, "into");
		await extractTar(
			bytes(
				tar([
					{ path: "./fw/", type: "5", mode: 0o755 },
					{ path: "./fw/Versions/", type: "5", mode: 0o755 },
					{ path: "./fw/Versions/1.0/", type: "5", mode: 0o755 },
					{ path: "./fw/Versions/1.0/lib.so", body: "x\n" },
					{ path: "./fw/Versions/Current", type: "2", link: "1.0" },
					{ path: "./fw/lib.so", type: "2", link: "Versions/Current/lib.so" },
				]),
			),
			into,
		);
		expect(readlinkSync(join(into, "fw/lib.so"))).toBe("Versions/Current/lib.so");
		expect(readFileSync(join(into, "fw/lib.so"), "utf8")).toBe("x\n"); // resolves
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a hard link inside the package works, one pointing out does not", async () => {
	const dir = work();
	try {
		const into = join(dir, "into");
		await extractTar(
			bytes(
				tar([
					{ path: "./real", body: "shared\n" },
					{ path: "./same", type: "1", link: "./real" },
				]),
			),
			into,
		);
		expect(readFileSync(join(into, "same"), "utf8")).toBe("shared\n");

		const other = join(dir, "into2");
		await expect(
			extractTar(bytes(tar([{ path: "./out", type: "1", link: "../../etc/passwd" }])), other),
		).rejects.toThrow(/points outside the package/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a GNU long path is read back whole", async () => {
	const dir = work();
	try {
		const into = join(dir, "into");
		const deep = `./usr/share/${Array.from({ length: 12 }, (_, i) => `directory${String(i).padStart(2, "0")}`).join("/")}/file.txt`;
		expect(deep.length).toBeGreaterThan(100);
		await extractTar(bytes(tar([{ path: deep, body: "deep\n" }])), into);
		expect(readFileSync(join(into, deep.slice(2)), "utf8")).toBe("deep\n");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the control member is read through the same path as the data member", async () => {
	const dir = work();
	try {
		const path = deb(dir, "ctl.deb", tar([]));
		const m = await debMembers(path);
		const text = await readTarEntry(decompressStream(m.control.name, memberStream(path, m.control)), "control");
		expect(text).toContain("Package: fixture");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ----------------------------------------------------------------- arch

test("the architecture table gives the names dpkg prints", () => {
	expect(DEBIAN_ARCH.x64).toBe("amd64");
	expect(DEBIAN_ARCH.arm64).toBe("arm64");
	expect(DEBIAN_ARCH.ia32).toBe("i386");
	expect(DEBIAN_ARCH.arm).toBe("armhf");
	expect(DEBIAN_ARCH.ppc64).toBe("ppc64el");
});

// A tar holding one file, "./greeting.txt", compressed two ways JavaScript
// cannot produce. Generated with `xz -9` and `bzip2 -9`.
const XZ_FIXTURE =
	"/Td6WFoAAATm1rRGBMCbAYBQIQEcAAAAAAAAAP9XEE/gJ/8Ak10AFwu8HH0BlcAdSj55FcLMJqNeGSv9bvYPTNFLb8QbU6Ut8GHs" +
	"VJt/NY8M8k1Dcmjvys7ocpXSnGcaKSCc2+niMExGinTiLAwcvLCMVhbCpcq/vYjKwDiIlAtDe6ASfElYZduEIkYICTfNKAzd4UmU" +
	"yScxCdrr3JMdt879i6dNlOepNjHEigvC5PseJk4ESE6A6YoAAAD3yb7je9T83QABtwGAUAAAK0YfeLHEZ/sCAAAAAARZWg==";
const BZ2_FIXTURE =
	"QlpoOTFBWSZTWf2toukAAGz7hMqRAEBAAf+AEAF3555AAACACCAAkglRqanoanoTIZHoNEek9QSU0UyaeiNqaMCDCGm/xRlU8gkB" +
	"RMAKA5CRY3WegOBGUw8Og4SBhXsnmxg802s3nzuGihScILzLxSBDIcxKFKYi1q0yGD0YPqciOWDYEbo5cMbKONfSXuSOUUBoQl2P" +
	"p+Gk1kx/iZdWKUH8XckU4UJD9raLpA==";
