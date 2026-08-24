import { $ } from "bun";
import { expect, test } from "bun:test";
import { compareVersions } from "./src/version.ts";

// dpkg is the authority on version ordering, so check our port against it
// rather than against hand-written expectations.
const cases = [
	["1.24012.9", "1.24012.11"], // multi-digit numeric segments
	["1.34493.0", "1.34493.1"],
	["1.9.0", "1.10.0"],
	["1.0~rc1", "1.0"], // ~ sorts before the release
	["1.0~~", "1.0~"],
	["1.0", "1.0~1"],
	["1.0", "1.0.1"],
	["1.0-1", "1.0-2"], // debian revision
	["1:1.0", "2:0.1"], // epoch wins
	["1.34493.1", "1.34493.1"], // equal
	["1.017", "1.17"], // leading zeros are insignificant
	["1.0a", "1.0b"],
	["1.0+deb1", "1.0+deb2"],
	["2.0", "10.0"],
] as const;

async function dpkgSign(a: string, b: string): Promise<number> {
	if ((await $`dpkg --compare-versions ${a} eq ${b}`.quiet().nothrow()).exitCode === 0) return 0;
	return (await $`dpkg --compare-versions ${a} lt ${b}`.quiet().nothrow()).exitCode === 0 ? -1 : 1;
}

for (const [a, b] of cases) {
	test(`compareVersions(${a}, ${b}) agrees with dpkg`, async () => {
		const sign = await dpkgSign(a, b);
		expect(Math.sign(compareVersions(a, b))).toBe(sign);
		// and the comparator is antisymmetric (0 rather than -0 when equal)
		expect(Math.sign(compareVersions(b, a))).toBe(sign === 0 ? 0 : -sign);
	});
}
