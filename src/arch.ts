/**
 * The Debian architecture name for the machine we are on.
 *
 * This stands in for `dpkg --print-architecture`, and it is a table rather than
 * a guess: these are the names dpkg uses, for the ports a program like this
 * runs on. It is only the default — `--arch` overrides it, which is what you
 * want anyway when pulling an amd64 package onto an arm64 host.
 *
 * `process.arch` says `arm` for both armel and armhf. armhf is what every
 * current Debian port and every vendor repository ships, so that is the guess,
 * and it is one `--arch armel` corrects.
 */

import { die } from "./util.ts";

/** `process.arch` -> the name dpkg would print. Exported so the table is testable. */
export const DEBIAN_ARCH: Record<string, string> = {
	x64: "amd64",
	arm64: "arm64",
	arm: "armhf",
	ia32: "i386",
	ppc64: "ppc64el",
	s390x: "s390x",
	riscv64: "riscv64",
	loong64: "loong64",
	mips64el: "mips64el",
};

export function hostArch(): string {
	return DEBIAN_ARCH[process.arch] ?? die(`no Debian architecture name is known for ${process.arch}; pass --arch`);
}
