#!/usr/bin/env bun
//
// Install a package from a Debian apt repository onto a non-Debian system by
// extracting it into <dest>/<package>, doing by hand what apt would do:
// verify the signed index, verify the package against it, then unpack.
//
// See README.md for the why, and --help for the how.

import { $ } from "bun";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chooseSubtree, download, unpack } from "./src/deb.ts";
import { writeEnvironmentD } from "./src/environment-d.ts";
import { normalizeFingerprint } from "./src/gpg.ts";
import { describeInstalled, installedVersion, installTree, type Stamp } from "./src/install.ts";
import { fetchPackages, fetchRelease, versionsOf, type RepoRef } from "./src/repo.ts";
import { choose, listVersions } from "./src/select.ts";
import { die, humanMiB } from "./src/util.ts";

const USAGE = `usage: index.ts <repo-url> <package> --fingerprint <FPR> [options]

  <repo-url>            base of the apt repository — the URL from a sources.list
                        "deb" line, e.g. https://apt.example.com/some-app/stable
  <package>             binary package name, as it appears in the index

required
  --fingerprint <FPR>   fingerprint of the key that must have signed the index.
                        The key comes from your keyring; this tool never
                        fetches keys. Import it once, out of band:
                          curl -fsSL <key-url> | gpg --import

selecting a version
  --list                list the available versions and exit
  --version <v>         install this exact version (default: the newest)
  --pick                choose interactively (needs a terminal)

where things go
  --dest <dir>          parent directory (default: /opt), so <dest>/<package>
  --from <subdir>       subtree of the .deb to install (default: auto-detected)
  --no-environment-d    don't write ~/.config/environment.d/50-<package>.conf

repository layout
  --suite <s>           default: stable
  --component <c>       default: main
  --arch <a>            default: dpkg --print-architecture
  --keyring <file>      verify against this keyring instead of your default one

other
  --check               report installed vs. selected version, then exit
  --force               reinstall even if the installed version is current
  -h, --help            this text
`;

const { values: opt, positionals } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: {
		fingerprint: { type: "string" },
		keyring: { type: "string" },
		suite: { type: "string", default: "stable" },
		component: { type: "string", default: "main" },
		arch: { type: "string" },
		version: { type: "string" },
		from: { type: "string" },
		dest: { type: "string", default: "/opt" },
		list: { type: "boolean", default: false },
		pick: { type: "boolean", default: false },
		check: { type: "boolean", default: false },
		force: { type: "boolean", default: false },
		"no-environment-d": { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (opt.help) {
	console.log(USAGE);
	process.exit(0);
}
if (process.getuid?.() === 0) {
	die("run this as your normal user, not with sudo (it calls sudo itself where needed)");
}

const [repoArg, pkgName] = positionals;
if (!repoArg || !pkgName) die(`missing <repo-url> and/or <package>\n\n${USAGE}`);
if (!opt.fingerprint) die(`--fingerprint is required: it is what makes the signature mean anything\n\n${USAGE}`);

const dest = join(opt.dest, pkgName);
const trust = { fingerprint: normalizeFingerprint(opt.fingerprint), keyring: opt.keyring };
const work = mkdtempSync(join(tmpdir(), `apt-extract-${pkgName}-`));

try {
	const ref: RepoRef = {
		url: repoArg.replace(/\/+$/, ""),
		suite: opt.suite,
		component: opt.component,
		arch: opt.arch ?? (await $`dpkg --print-architecture`.quiet().text()).trim(),
	};

	const release = await fetchRelease(ref, trust, work);
	console.log(
		`repository: ${release.fields.get("Origin") ?? ref.url} ${release.fields.get("Suite") ?? ref.suite}, ` +
			`signed by ${trust.fingerprint}`,
	);

	const versions = await versionsOf(await fetchPackages(release, ref), pkgName, ref.arch);
	if (versions.length === 0) die(`no ${pkgName} package for ${ref.arch} in ${ref.component}`);

	const installed = installedVersion(dest);

	if (opt.list) {
		console.log(`${pkgName} ${ref.arch}, ${versions.length} version(s); installed: ${describeInstalled(dest)}`);
		listVersions(versions, installed);
		process.exit(0);
	}

	const chosen = choose(versions, { version: opt.version, pick: opt.pick }, installed);
	const version = chosen.get("Version")!;
	console.log(`installed:  ${describeInstalled(dest)}`);
	console.log(`selected:   ${version} (${humanMiB(Number(chosen.get("Size")))} of ${versions.length} version(s))`);

	if (opt.check) process.exit(0);
	if (installed === version && !opt.force) {
		console.log("already current; pass --force to reinstall");
		process.exit(0);
	}

	const deb = await download(chosen, ref.url, join(import.meta.dir, "cache"));

	console.log("unpacking...");
	const root = await unpack(deb, join(work, "root"));
	const subtree = opt.from ?? chooseSubtree(root, pkgName);
	const staged = join(root, subtree);
	if (!existsSync(staged)) die(`the .deb has no ${subtree}/ to install`);

	console.log(`installing ${subtree}/ to ${dest} (sudo)...`);
	const stamp: Stamp = { package: pkgName, version, repo: ref.url, suite: ref.suite, architecture: ref.arch, subtree };
	await installTree(staged, dest, stamp);

	const conf = opt["no-environment-d"] ? null : await writeEnvironmentD(dest, pkgName);

	console.log(`\ninstalled ${pkgName} ${version} to ${dest}`);
	if (conf) {
		console.log(`wrote ${conf}`);
		console.log("log out and back in for desktop entries and scheme handlers to be picked up");
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
