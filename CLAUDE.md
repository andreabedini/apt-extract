# Working on this repo

A single-purpose CLI that installs a package from a Debian apt repository onto a
non-Debian system by extracting it into `<dest>/<package>`. A single `.deb` — a
local path or a URL — can be named instead of a repository, in which case there
is no chain of trust and the tool says so. See `README.md` for the reasoning;
this file is the working agreement.

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
| `src/deb.ts`           | download, unpack, subtree detection, a `.deb` named directly   |
| `src/install.ts`       | version stamp and the `rsync` into place                       |
| `src/environment-d.ts` | the `systemd --user` environment drop-in                        |

The four below are shims for tools this program used to shell out to. Each one
replaces exactly one thing, so what was given up is visible in one file:

| file              | stands in for              |
| ----------------- | -------------------------- |
| `src/ar.ts`       | `dpkg-deb`'s ar container   |
| `src/compress.ts` | `gzip`/`xz`/`zstd`/`bzip2`  |
| `src/tar.ts`      | `dpkg-deb -x`               |
| `src/arch.ts`     | `dpkg --print-architecture` |

`scripts/build-release.ts` builds the cross-compiled binaries a GitHub release
carries; it is the only thing `.releaserc.json` runs at release time.

## Invariants — don't weaken these

1. **Nothing is used before it is verified.** Signature over `InRelease` →
   SHA256 of the package index from that verified `InRelease` → SHA256 of the
   `.deb` from that verified index. Every hop, every run.

   A `.deb` named directly has no index, and is never dressed up as if it had
   one: it prints its digest and says nothing vouched for it. `sha256 ok` is
   printed only when `--sha256` gave it something to fail against, and
   `Stamp.trust` records which of the two happened. Repository options are
   refused on that path rather than ignored — an accepted `--fingerprint` would
   read as a signature check that never ran.
2. **The tool never fetches signing keys.** A key fetched over the same channel
   as the thing it authenticates proves nothing. Keys come from a keyring.
3. **`--fingerprint` stays required** whenever a repository is the source. `gpg`
   exits 0 for a good signature from any key in the keyring, so the pin is what
   makes "signed" meaningful.
4. **Only `SHA256:` is read from `Release`.** Never fall back to `MD5Sum:` or
   `SHA1:`, even if a repository offers nothing else — fail instead.
5. **`src/version.ts` is a port, not an approximation.** Any change must keep
   `vercmp.test.ts` (differential against `dpkg --compare-versions`) green.
6. **Normal user, narrow sudo.** Refuse to run as root; shell out to `sudo` only
   for `mkdir -p` and `rsync` into `<dest>`.
7. **An unpacked `.deb` is what dpkg would have unpacked.** `debformat.test.ts`
   is the floor; the differential against `dpkg-deb -x` over a real corpus is the
   ceiling. In particular, do not "improve" on dpkg by dropping setuid bits or
   rewriting symlink targets: node-tar's extractor does both, which is why only
   its *parser* is used here. `chrome-sandbox` needs its setuid bit, and a
   framework's `Versions/Current` chain needs its links left alone.
8. **Nothing is written outside the staging directory.** Paths that are absolute
   or contain `..` are refused, not stripped — GNU tar strips them and carries
   on, which is not a thing a program with no partial installs should do — and
   nothing is ever written through a symlink the archive itself planted.
9. **`gpg` stays.** Dropping `dpkg` was worth it; dropping `gpg` is not. Moving
   signature checking into a bundled library trades an audited implementation for
   a supply-chain one, to remove a dependency apt-repository users already have.

## Conventions

- Bun, not Node: `bun <file>`, `bun test`, `bunx <pkg>`. No dotenv.
- `bun run build` compiles a standalone `dist/apt-extract`. Nothing may depend on
  a source tree at runtime: `import.meta.dir` is a read-only embedded path in that
  binary, so paths come from the environment (`cacheDir()`) or from arguments.
- `Bun.$` for subprocesses, with `.quiet().nothrow()` whenever the exit code is
  something to inspect rather than something to crash on.
- `Bun.file` / `Bun.write` for I/O; `node:fs` only for the sync directory checks.
- Failures are fatal and go through `die()` — no thrown strings, no partial installs.
  The format readers (`src/ar.ts`, `src/compress.ts`, `src/tar.ts`) are the one
  exception: they throw `Error`, so that what they refuse can be unit-tested
  without a subprocess. `src/deb.ts` is the seam that turns those into `die()`,
  and it is the only place that may catch them.
- Three runtime dependencies, all vendored into the compiled binary: `tar` for
  parsing only, `xz-decompress` (WebAssembly), `seek-bzip`. Adding a fourth needs
  a better reason than convenience — this is a program about trusting things.
- Tabs for indentation. Comments explain *why*; the code already says what.
- Conventional Commits, angular preset — the released version is derived from
  them (see Releasing). `feat:` / `fix:` for anything that ships; `ci:`,
  `docs:`, `chore:`, `test:`, `refactor:` for everything that doesn't.

## Releasing

Pushing to `main` runs `.github/workflows/release.yml`: semantic-release reads
the Conventional Commit messages since the last tag, works out the version,
runs `bun scripts/build-release.ts <version>` and attaches the binaries and
`SHA256SUMS` to a GitHub release. So commit messages are load-bearing — a change
that should ship needs a `fix:` or `feat:` subject. Nothing is committed back to
the branch: there is no version field anywhere to keep in step, and the tag is
the record.

## Testing

`bun test` runs everything.

- `vercmp.test.ts` — differential against `dpkg`, no network.
- `control.test.ts` — pure parser tests on fixtures, no network.
- `deb.test.ts` — argument classification (`.deb` vs. repository URL), no network.
- `debformat.test.ts` — what the `.deb` reader accepts and refuses, including the
  hostile shapes `tar` and `ar` will not build for you. Fixtures are assembled
  byte by byte in the test; the xz and bzip2 ones are embedded base64, because
  neither can be produced from JavaScript and a skipped test never runs. No
  network, no `dpkg`, no `tar`.
- `tamper.test.ts` — mirrors a real signed repository over `Bun.serve` and checks
  that tampering is rejected. A valid signature can't be fabricated, so it needs a
  repository named by `APT_TEST_REPO` / `APT_TEST_PACKAGE` /
  `APT_TEST_FINGERPRINT` (plus optional `APT_TEST_KEY_URL`, `APT_TEST_ARCH`) and
  skips cleanly when they are unset. Needs network and `gpg`.

`vercmp.test.ts` is the only test that needs `dpkg`, and it should stay that way:
the program no longer requires dpkg at runtime, so a test that does is a test
about the port, not about the program.

Never write a test that installs anything: use `--check`, and point the program
at a local `Bun.serve` mirror rather than at a real repository where you can.
Keep vendor-specific URLs, package names and fingerprints out of the repo — they
belong in the environment or in the caller's own wrapper script.
