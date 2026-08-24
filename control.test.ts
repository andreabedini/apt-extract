import { expect, test } from "bun:test";
import { parseControl, parseRelease } from "./src/control.ts";
import { clearsignedBody } from "./src/gpg.ts";

const PACKAGES = `Package: some-app
Version: 1.34493.1
Architecture: amd64
Depends: libgtk-3-0, libnotify4
Filename: pool/main/s/some-app/some-app_1.34493.1_amd64.deb
Size: 158823068
SHA256: 19829779633a277fcd72a6583426c68a4ecff7aa43a26718d6645c2e954747ca
Description: An example application
 A longer description, folded across
 several indented continuation lines.

Package: some-app
Version: 1.32885.1
Architecture: arm64
Size: 12
SHA256: abc
`;

test("parseControl splits stanzas and ignores folded continuations", () => {
	const stanzas = parseControl(PACKAGES);
	expect(stanzas).toHaveLength(2);
	expect(stanzas[0]!.get("Version")).toBe("1.34493.1");
	expect(stanzas[0]!.get("Size")).toBe("158823068");
	// the indented continuation lines must not become fields of their own
	expect(stanzas[0]!.get("Description")).toBe("An example application");
	expect([...stanzas[0]!.keys()]).toEqual([
		"Package",
		"Version",
		"Architecture",
		"Depends",
		"Filename",
		"Size",
		"SHA256",
		"Description",
	]);
	expect(stanzas[1]!.get("Architecture")).toBe("arm64");
});

test("parseControl tolerates trailing and repeated blank lines", () => {
	expect(parseControl(`${PACKAGES}\n\n\n`)).toHaveLength(2);
	expect(parseControl("")).toHaveLength(0);
});

const RELEASE = `Acquire-By-Hash: yes
Architectures: amd64 arm64
Codename: stable
Components: main
Valid-Until: Fri, 28 Aug 2026 18:57:50 UTC
MD5Sum:
 a0790c3e3dce7ceabf46ffdb63270753            31060 main/binary-amd64/Packages
SHA256:
 ac2ac834521c14b4a728171c4db716536c5b169deb998b9d1531784acc3bd14c            31060 main/binary-amd64/Packages
 3409a91b9166e52ab266124036113069cee6836d0fbdd4a41c6df88dc4af9148             3874 main/binary-amd64/Packages.gz
SHA512:
 f90e96206fa40af9044bb0f34777af398a9d32d5f39e8734b50ecd5e881d78b8            31060 main/binary-amd64/Packages`;

test("parseRelease reads fields and only the SHA256 file list", () => {
	const rel = parseRelease(RELEASE);
	expect(rel.fields.get("Codename")).toBe("stable");
	expect(rel.fields.get("Valid-Until")).toBe("Fri, 28 Aug 2026 18:57:50 UTC");

	expect(rel.hashes.get("main/binary-amd64/Packages.gz")).toEqual({
		sha256: "3409a91b9166e52ab266124036113069cee6836d0fbdd4a41c6df88dc4af9148",
		size: 3874,
	});
	// the MD5Sum and SHA512 lists name the same path; the SHA256 one must win
	expect(rel.hashes.get("main/binary-amd64/Packages")?.sha256).toBe(
		"ac2ac834521c14b4a728171c4db716536c5b169deb998b9d1531784acc3bd14c",
	);
	expect(rel.hashes.size).toBe(2);
});

test("clearsignedBody returns the signed payload and undoes dash-escaping", () => {
	const doc = [
		"-----BEGIN PGP SIGNED MESSAGE-----",
		"Hash: SHA512",
		"",
		"Origin: Example",
		"- Dash-escaped line",
		"-----BEGIN PGP SIGNATURE-----",
		"iQIzBAEBCgAd",
		"-----END PGP SIGNATURE-----",
	].join("\n");

	const body = clearsignedBody(doc);
	expect(body).toContain("Origin: Example");
	expect(body).toContain("Dash-escaped line");
	expect(body).not.toContain("- Dash-escaped");
	expect(body).not.toContain("BEGIN PGP");
});
