// Which argument shape is a .deb and which is a repository — the one thing
// about the direct-.deb path that can be decided without a file or a network.

import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDebArgument, isUrl } from "./src/deb.ts";

test("a .deb suffix names a file, by path or by URL", () => {
	expect(isDebArgument("./some-app_1.2.3_amd64.deb")).toBe(true);
	expect(isDebArgument("/var/tmp/some-app.DEB")).toBe(true);
	expect(isDebArgument("https://example.com/pool/some-app_1.2.3_amd64.deb")).toBe(true);
	// a query string is not part of the name
	expect(isDebArgument("https://example.com/dl/some-app.deb?token=abc")).toBe(true);
});

test("a repository URL is not a .deb", () => {
	expect(isDebArgument("https://apt.example.com/some-app/stable")).toBe(false);
	expect(isDebArgument("https://apt.example.com/some-app/stable/")).toBe(false);
	// the package name of a two-argument invocation, on its own
	expect(isDebArgument("some-app")).toBe(false);
});

test("an existing file is one even without the suffix", async () => {
	const dir = mkdtempSync(join(tmpdir(), "apt-extract-test-"));
	const path = join(dir, "downloaded");
	await Bun.write(path, "not really a .deb, but it is a file");
	expect(isDebArgument(path)).toBe(true);
	// a directory is not
	expect(isDebArgument(dir)).toBe(false);
});

test("only http(s) counts as a URL to fetch", () => {
	expect(isUrl("https://example.com/x.deb")).toBe(true);
	expect(isUrl("HTTP://example.com/x.deb")).toBe(true);
	expect(isUrl("file:///tmp/x.deb")).toBe(false);
	expect(isUrl("/tmp/x.deb")).toBe(false);
});
