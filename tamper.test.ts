// Negative tests: mirror a real signed apt repository locally and confirm the
// program refuses to proceed when the metadata has been tampered with, or when
// the signer is not the key that was pinned.
//
// These need a real repository, because a valid OpenPGP signature can't be
// fabricated. Point them at one with environment variables; without them the
// whole file skips:
//
//   APT_TEST_REPO=https://apt.example.com/some-app/stable \
//   APT_TEST_PACKAGE=some-app \
//   APT_TEST_FINGERPRINT=0123456789ABCDEF0123456789ABCDEF01234567 \
//   APT_TEST_KEY_URL=https://apt.example.com/key.asc \
//   bun test
//
// APT_TEST_KEY_URL is optional: without it the key is expected to already be in
// your default keyring. APT_TEST_ARCH defaults to amd64.
//
// Also needs gpg and dpkg on PATH.

import { $ } from "bun";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.env.APT_TEST_REPO;
const PKG = process.env.APT_TEST_PACKAGE;
const FPR = process.env.APT_TEST_FINGERPRINT;
const KEY_URL = process.env.APT_TEST_KEY_URL;
const ARCH = process.env.APT_TEST_ARCH ?? "amd64";

const configured = Boolean(REPO && PKG && FPR);
if (!configured) {
	console.log("tamper.test.ts: skipped (set APT_TEST_REPO, APT_TEST_PACKAGE, APT_TEST_FINGERPRINT to run)");
}

const work = mkdtempSync(join(tmpdir(), "tamper-"));
/** undefined means "use the default keyring" */
let keyring: string | undefined;
let inrelease: string;
let packages: Uint8Array;

beforeAll(async () => {
	if (!configured) return;

	// The program never fetches keys, so hand it one via --keyring if asked.
	if (KEY_URL) {
		const asc = join(work, "key.asc");
		keyring = join(work, "key.gpg");
		await Bun.write(asc, await (await fetch(KEY_URL)).text());
		await $`gpg --dearmor --output ${keyring} ${asc}`.quiet();
	}

	inrelease = await (await fetch(`${REPO}/dists/stable/InRelease`)).text();
	packages = new Uint8Array(
		await (await fetch(`${REPO}/dists/stable/main/binary-${ARCH}/Packages.gz`)).arrayBuffer(),
	);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Serve a mirror, run the program against it in --check mode, return its output. */
async function run(mirror: { inrelease: string; packages: Uint8Array }, fingerprint = FPR!, keys = keyring) {
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/dists/stable/InRelease")) return new Response(mirror.inrelease);
			if (path.endsWith(`/main/binary-${ARCH}/Packages.gz`)) return new Response(mirror.packages);
			return new Response("not found", { status: 404 });
		},
	});
	try {
		const proc = Bun.spawn(
			[
				"bun",
				join(import.meta.dir, "index.ts"),
				`http://127.0.0.1:${server.port}/mirror`,
				PKG!,
				"--fingerprint",
				fingerprint,
				"--arch",
				ARCH,
				"--check",
				...(keys ? ["--keyring", keys] : []),
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
		return { out, code: await proc.exited };
	} finally {
		await server.stop(true);
	}
}

test.skipIf(!configured)("a clean mirror is accepted", async () => {
	const { out, code } = await run({ inrelease, packages });
	expect(code).toBe(0);
	expect(out).toContain(`signed by ${FPR}`);
	expect(out).toMatch(/selected: {3}\S+/);
});

test.skipIf(!configured)("a modified InRelease body is rejected", async () => {
	// Same signature, different content: change a field inside the signed body.
	const bad = inrelease.replace(/^(Codename:.*)$/m, "$1x");
	expect(bad).not.toBe(inrelease);
	const { out, code } = await run({ inrelease: bad, packages });
	expect(code).not.toBe(0);
	expect(out).toContain("signature check failed");
});

test.skipIf(!configured)("a modified package index is rejected", async () => {
	// Valid signature, but the index it vouches for is not what we serve.
	const bad = new Uint8Array(packages);
	const last = bad.length - 1;
	bad[last] = (bad[last] ?? 0) ^ 0xff;
	const { out, code } = await run({ inrelease, packages: bad });
	expect(code).not.toBe(0);
	expect(out).toMatch(/sha256 mismatch|got \d+ bytes/);
});

test.skipIf(!configured)("a good signature from an unexpected key is rejected", async () => {
	// The pin is what gives the signature meaning: right signature, wrong key.
	const other = "0000000000000000000000000000000000000000";
	const { out, code } = await run({ inrelease, packages }, other);
	expect(code).not.toBe(0);
	expect(out).toContain(`not by the expected ${other}`);
});

test.skipIf(!configured)("a missing key is reported as something to import", async () => {
	const empty = join(work, "empty.gpg");
	await Bun.write(empty, "");
	const { out, code } = await run({ inrelease, packages }, FPR!, empty);
	expect(code).not.toBe(0);
	expect(out).toContain("not in");
	expect(out).toContain("gpg --import");
});
