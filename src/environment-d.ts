/**
 * Exposing an /opt install to the desktop session.
 *
 * A GNOME (or any systemd-managed) session is started by `systemd --user`,
 * which never reads shell startup files. So .desktop entries, icons and
 * scheme handlers under <dest>/share are invisible to the app grid unless the
 * *session* environment carries XDG_DATA_DIRS — and a .desktop file whose
 * Exec= is a bare command name needs <dest>/bin on the session PATH too.
 *
 * environment.d is the supported place for that. It cannot glob or test for
 * existence, which is why this is generated per install rather than written
 * once by hand.
 */

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function configDir(): string {
	return join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "environment.d");
}

export function confPathFor(pkgName: string): string {
	return join(configDir(), `50-${pkgName}.conf`);
}

/**
 * Write the drop-in for an installed tree. Returns the path written, or null if
 * the tree has neither bin/ nor share/ and there is nothing worth exporting.
 */
export async function writeEnvironmentD(dest: string, pkgName: string): Promise<string | null> {
	const lines = [`# Managed by ${pkgName} install; regenerated on upgrade`];
	if (existsSync(join(dest, "bin"))) lines.push(`PATH=${dest}/bin:\${PATH}`);
	if (existsSync(join(dest, "share"))) {
		// Fall back to the spec default so an unset value can't leave a leading colon.
		lines.push(`XDG_DATA_DIRS=\${XDG_DATA_DIRS:-/usr/local/share:/usr/share}:${dest}/share`);
	}
	if (lines.length === 1) return null;

	const conf = confPathFor(pkgName);
	mkdirSync(configDir(), { recursive: true });
	await Bun.write(conf, `${lines.join("\n")}\n`);

	// Re-runs the environment generators for units started from now on. The
	// running graphical session keeps its old environment until the next login.
	if ((await $`systemctl --user daemon-reload`.quiet().nothrow()).exitCode !== 0) {
		console.log("note: systemctl --user daemon-reload failed; log out and back in instead");
	}
	return conf;
}
