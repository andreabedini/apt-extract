# Working on this repo

A single-purpose CLI that installs a package from a Debian apt repository onto a
non-Debian system by extracting it into `<dest>/<package>`. See `README.md` for
the reasoning; this file is the working agreement.

## Layout

`index.ts` is the CLI: argument parsing, ordering of steps, and the messages the
user sees. Logic belongs in `src/`, one concern per file:

| file                   | concern                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `src/util.ts`          | `die`, checked `get`, `sha256`, `humanMiB`                     |
| `src/version.ts`       | Debian version ordering (a port of dpkg's `verrevcmp`)         |
| `src/control.ts`       | control-file parsers: `Packages`, `Release`                    |
| `src/gpg.ts`           | signature verification and fingerprint pinning                 |
| `src/repo.ts`          | repository access, with the hash chain enforced at each hop     |
| `src/select.ts`        | listing versions and choosing one                              |
| `src/deb.ts`           | download, unpack, subtree detection                            |
| `src/install.ts`       | version stamp and the `rsync` into place                       |
| `src/environment-d.ts` | the `systemd --user` environment drop-in                        |

## Invariants — don't weaken these

1. **Nothing is used before it is verified.** Signature over `InRelease` →
   SHA256 of the package index from that verified `InRelease` → SHA256 of the
   `.deb` from that verified index. Every hop, every run.
2. **The tool never fetches signing keys.** A key fetched over the same channel
   as the thing it authenticates proves nothing. Keys come from a keyring.
3. **`--fingerprint` stays required.** `gpg` exits 0 for a good signature from
   any key in the keyring, so the pin is what makes "signed" meaningful.
4. **Only `SHA256:` is read from `Release`.** Never fall back to `MD5Sum:` or
   `SHA1:`, even if a repository offers nothing else — fail instead.
5. **`src/version.ts` is a port, not an approximation.** Any change must keep
   `vercmp.test.ts` (differential against `dpkg --compare-versions`) green.
6. **Normal user, narrow sudo.** Refuse to run as root; shell out to `sudo` only
   for `mkdir -p` and `rsync` into `<dest>`.

## Conventions

- Bun, not Node: `bun <file>`, `bun test`, `bunx <pkg>`. No dotenv.
- `Bun.$` for subprocesses, with `.quiet().nothrow()` whenever the exit code is
  something to inspect rather than something to crash on.
- `Bun.file` / `Bun.write` for I/O; `node:fs` only for the sync directory checks.
- Failures are fatal and go through `die()` — no thrown strings, no partial installs.
- Tabs for indentation. Comments explain *why*; the code already says what.

## Testing

`bun test` runs everything.

- `vercmp.test.ts` — differential against `dpkg`, no network.
- `control.test.ts` — pure parser tests on fixtures, no network.
- `tamper.test.ts` — mirrors a real signed repository over `Bun.serve` and checks
  that tampering is rejected. A valid signature can't be fabricated, so it needs a
  repository named by `APT_TEST_REPO` / `APT_TEST_PACKAGE` /
  `APT_TEST_FINGERPRINT` (plus optional `APT_TEST_KEY_URL`, `APT_TEST_ARCH`) and
  skips cleanly when they are unset. Needs network, `gpg` and `dpkg`.

Never write a test that installs anything: use `--check`, and point the program
at a local `Bun.serve` mirror rather than at a real repository where you can.
Keep vendor-specific URLs, package names and fingerprints out of the repo — they
belong in the environment or in the caller's own wrapper script.
