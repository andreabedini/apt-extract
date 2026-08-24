/**
 * Debian version ordering, ported from dpkg so that `1.24012.11` sorts above
 * `1.24012.9` and `1.0~rc1` below `1.0`. Naive string or semver comparison
 * gets both of those wrong.
 *
 * Cross-checked against `dpkg --compare-versions` in vercmp.test.ts.
 */

/** dpkg's character ordering: `~` sorts before everything, even the empty string. */
function order(c: string | undefined): number {
	if (c === undefined) return 0;
	if (c >= "0" && c <= "9") return 0;
	if (/[a-zA-Z]/.test(c)) return c.charCodeAt(0);
	if (c === "~") return -1;
	return c.charCodeAt(0) + 256;
}

/** Port of dpkg's verrevcmp(): alternating runs of non-digits and digits. */
export function verrevcmp(a: string, b: string): number {
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		let diff = 0;
		while ((i < a.length && !/[0-9]/.test(a[i]!)) || (j < b.length && !/[0-9]/.test(b[j]!))) {
			diff = order(a[i]) - order(b[j]);
			if (diff !== 0) return diff;
			i++;
			j++;
		}
		while (a[i] === "0") i++;
		while (b[j] === "0") j++;
		while (/[0-9]/.test(a[i] ?? "") && /[0-9]/.test(b[j] ?? "")) {
			if (diff === 0) diff = a.charCodeAt(i) - b.charCodeAt(j);
			i++;
			j++;
		}
		if (/[0-9]/.test(a[i] ?? "")) return 1;
		if (/[0-9]/.test(b[j] ?? "")) return -1;
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Compare full versions: epoch first, then upstream, then debian revision. */
export function compareVersions(a: string, b: string): number {
	const x = split(a);
	const y = split(b);
	return x.epoch - y.epoch || verrevcmp(x.upstream, y.upstream) || verrevcmp(x.revision, y.revision);
}

function split(v: string): { epoch: number; upstream: string; revision: string } {
	const colon = v.indexOf(":");
	const epoch = colon === -1 ? 0 : Number(v.slice(0, colon));
	const rest = colon === -1 ? v : v.slice(colon + 1);
	const dash = rest.lastIndexOf("-");
	return dash === -1
		? { epoch, upstream: rest, revision: "" }
		: { epoch, upstream: rest.slice(0, dash), revision: rest.slice(dash + 1) };
}
