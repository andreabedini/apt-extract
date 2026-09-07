#!/usr/bin/env bun
//
// Install a package onto a system that isn't Debian by extracting it into
// <dest>/<package>, doing by hand what apt would do: verify the signed index,
// verify the package against it, then unpack.
//
// A single .deb — a local file or a URL — can be named instead of a repository.
// There is then no index to check it against, so the digest is all there is,
// and the tool says so rather than implying more.
//
// See README.md for the why, and --help for the how.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import { hostArch } from "./src/arch.ts";
import { chooseSubtree, debControl, download, isDebArgument, isUrl, obtainDeb, unpack } from "./src/deb.ts";
import { writeEnvironmentD } from "./src/environment-d.ts";
import { normalizeFingerprint } from "./src/gpg.ts";
import { describeInstalled, installedVersion, installTree, type Stamp } from "./src/install.ts";
import { fetchPackages, fetchRelease, versionsOf, type RepoRef } from "./src/repo.ts";
import { choose, listVersions } from "./src/select.ts";
import { cacheDir, die, humanMiB } from "./src/util.ts";

// "index.ts" when run from source, "apt-extract" from the compiled binary.
const invoked = basename(Bun.argv[1] ?? "index.ts");

const USAGE = `usage: ${invoked} <repo-url> <package> --fingerprint <FPR> [options]
       ${invoked} <deb> [options]

  <repo-url>            base of the apt repository — the URL from a sources.list
                        "deb" line, e.g. https://apt.example.com/some-app/stable
  <package>             binary package name, as it appears in the index
  <deb>                 or, instead of the two above, one .deb: a local path or
                        an http(s) URL. The package name and version come from
                        the file's own control data. Nothing signs a lone .deb,
                        so nothing vouches for it — see --sha256.

from a repository
  --fingerprint <FPR>   required: fingerprint of the key that must have signed
                        the index. The key comes from your keyring; this tool
                        never fetches keys. Import it once, out of band:
                          curl -fsSL <key-url> | gpg --import
  --keyring <file>      verify against this keyring instead of your default one
  --suite <s>           default: stable
  --component <c>       default: main
  --arch <a>            default: this machine's architecture
  --list                list the available versions and exit
  --version <v>         install this exact version (default: the newest)
  --pick                choose interactively (needs a terminal)

from a single .deb
  --sha256 <hex>        the digest the .deb must have. Without it the digest is
                        printed but there is nothing to check it against.

where things go
  --dest <dir>          parent directory (default: /opt), so <dest>/<package>
  --from <subdir>       subtree of the .deb to install (default: auto-detected)
  --no-environment-d    don't write ~/.config/environment.d/50-<package>.conf

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
		suite: { type: "string" },
		component: { type: "string" },
		arch: { type: "string" },
		version: { type: "string" },
		sha256: { type: "string" },
		from: { type: "string" },
		dest: { type: "string", default: "/opt" },
		list: { type: "boolean" },
		pick: { type: "boolean" },
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

const [first, second] = positionals;
if (!first) die(`missing arguments\n\n${USAGE}`);

// One argument that names a file is a .deb; two are a repository and a package.
const debOnly = !second && isDebArgument(first);
if (!second && !debOnly) die(`missing <package> — or pass one .deb instead of a repository URL\n\n${USAGE}`);

// Options that only mean something on one of the two paths. Silently ignoring
// --fingerprint for a lone .deb would be the worst of both worlds: it reads as
// a signature check that never happened.
const repoOnly = (["fingerprint", "keyring", "suite", "component", "arch", "version", "list", "pick"] as const).filter(
	(k) => opt[k] !== undefined,
);
if (debOnly) {
	if (repoOnly.length) {
		die(
			`${repoOnly.map((k) => `--${k}`).join(", ")} ${repoOnly.length > 1 ? "need" : "needs"} a repository; ` +
				`a lone .deb carries no index to select from and no signature to check`,
		);
	}
} else {
	if (opt.sha256) die("--sha256 is for a lone .deb; from a repository the verified index carries the digest");
	if (!opt.fingerprint) die(`--fingerprint is required: it is what makes the signature mean anything\n\n${USAGE}`);
}

const expectSha = opt.sha256?.trim().toLowerCase();
if (expectSha !== undefined && !/^[0-9a-f]{64}$/.test(expectSha)) die("--sha256 takes a 64-character hex digest");

/** What was chosen, and how to get the .deb — called only once we mean to install. */
type Selection = { stamp: Omit<Stamp, "subtree">; deb: () => Promise<string> };

const destFor = (pkgName: string) => join(opt.dest, pkgName);
const work = mkdtempSync(join(tmpdir(), "apt-extract-"));

try {
	const selected = debOnly ? await fromDeb(first) : await fromRepository(first, second!);
	const { package: pkgName, version } = selected.stamp;
	const dest = destFor(pkgName);

	if (opt.check) process.exit(0);
	if (installedVersion(dest) === version && !opt.force) {
		console.log("already current; pass --force to reinstall");
		process.exit(0);
	}

	const deb = await selected.deb();

	console.log("unpacking...");
	const root = await unpack(deb, join(work, "root"));
	const subtree = opt.from ?? chooseSubtree(root, pkgName);
	const staged = join(root, subtree);
	if (!existsSync(staged)) die(`the .deb has no ${subtree}/ to install`);

	console.log(`installing ${subtree}/ to ${dest} (sudo)...`);
	await installTree(staged, dest, { ...selected.stamp, subtree });

	const conf = opt["no-environment-d"] ? null : await writeEnvironmentD(dest, pkgName);

	console.log(`\ninstalled ${pkgName} ${version} to ${dest}`);
	if (conf) {
		console.log(`wrote ${conf}`);
		console.log("log out and back in for desktop entries and scheme handlers to be picked up");
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

/**
 * The verified path: a signature over the index, the index over the .deb.
 * Nothing is downloaded here — the caller decides whether to, so `--check` and
 * an up-to-date install never pull down a few hundred megabytes to no purpose.
 */
async function fromRepository(repoArg: string, pkgName: string): Promise<Selection> {
	const ref: RepoRef = {
		url: repoArg.replace(/\/+$/, ""),
		suite: opt.suite ?? "stable",
		component: opt.component ?? "main",
		arch: opt.arch ?? hostArch(),
	};
	const trust = { fingerprint: normalizeFingerprint(opt.fingerprint!), keyring: opt.keyring };
	const dest = destFor(pkgName);

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

	const chosen = choose(versions, { version: opt.version, pick: opt.pick ?? false }, installed);
	const version = chosen.get("Version")!;
	console.log(`installed:  ${describeInstalled(dest)}`);
	console.log(`selected:   ${version} (${humanMiB(Number(chosen.get("Size")))} of ${versions.length} version(s))`);

	return {
		stamp: {
			package: pkgName,
			version,
			architecture: ref.arch,
			source: ref.url,
			suite: ref.suite,
			sha256: chosen.get("SHA256")!,
			trust: "signed-index",
		},
		deb: () => download(chosen, ref.url, cacheDir()),
	};
}

/**
 * The unverified path: one .deb, named by path or URL.
 *
 * The file has to be in hand before anything can be said about it — the
 * version lives in its control data, not in an index — so a URL is fetched
 * even for --check. There is nothing else to ask.
 */
async function fromDeb(arg: string): Promise<Selection> {
	if (isUrl(arg) && opt.check) console.log("no index to ask: fetching the .deb to read its version");

	const { path, sha256 } = await obtainDeb(arg, cacheDir(), expectSha);
	const control = await debControl(path);
	const pkgName = control.get("Package")!;
	const version = control.get("Version") ?? die(`${basename(path)} has no Version field in its control data`);
	const arch = control.get("Architecture") ?? "";

	console.log(`.deb:       ${pkgName} ${version}${arch ? ` (${arch})` : ""}`);
	console.log(`installed:  ${describeInstalled(destFor(pkgName))}`);

	return {
		stamp: {
			package: pkgName,
			version,
			architecture: arch,
			source: isUrl(arg) ? arg : path,
			sha256,
			trust: expectSha ? "sha256" : "none",
		},
		deb: async () => path,
	};
}
