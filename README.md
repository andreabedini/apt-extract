# apt-extract

Install a package from a Debian apt repository onto a system that isn't Debian,
by unpacking it into `/opt/<package>` — doing by hand the parts of `apt` that
matter, and none of the parts that would lie to you.

```
bun index.ts <repo-url> <package> --fingerprint <FPR> [options]
bun index.ts <deb> [options]                 # one .deb: a local path or a URL
```

or, from a compiled binary (see [Building](#building)):

```
apt-extract <repo-url> <package> --fingerprint <FPR> [options]
apt-extract <deb> [options]
```

## Why this exists

Some vendors ship a Linux desktop app as a `.deb` and an apt repository, and
nothing else. On Fedora there is no supported path to that: no rpm repository, so
no `dnf`. When the app is a self-contained tree, unpacking the `.deb` into `/opt`
works fine — but the naive version of that (`curl` a URL, `dpkg-deb -x`,
`sudo cp`) throws away everything the repository was offering:

- **integrity.** The repository index is signed and lists a SHA256 for every
  package. Downloading a few hundred megabytes of proprietary binary and copying
  it into `/opt` as root without checking either is the whole risk of using apt,
  with none of the protection.
- **knowing what you have.** Extracting a `.deb` leaves no record, so nothing can
  answer "am I current?" and every run re-downloads.
- **being visible to the desktop.** A `systemd`-managed session never reads shell
  startup files, so `.desktop` entries and icons under `/opt` stay invisible to
  the app grid.

This tool keeps all three.

## What it does

1. Fetches `dists/<suite>/InRelease` and verifies the clearsignature with `gpg`,
   then **asserts the signer is the fingerprint you named**. `gpg` exits 0 for a
   good signature from any key in your keyring, so the exit code alone decides
   nothing; the pin does.
2. Rejects an index whose `Valid-Until` has passed, so a stale or replayed index
   can't be served back to you indefinitely.
3. Fetches `Packages.gz` (or `Packages`) and checks it against the SHA256 from
   that verified `InRelease`. Only the `SHA256:` list is read — never `MD5Sum:`
   or `SHA1:`.
4. Picks a version: newest by default, `--version` for an exact one, `--pick` for
   a prompt, `--list` to just look.
5. Downloads the `.deb` and checks its size and SHA256 against that verified
   index, hashing on the way to disk so nothing large is held in memory. Downloads
   are kept in `${XDG_CACHE_HOME:-~/.cache}/apt-extract`, and a cached file is
   reused only if it still matches.
6. Unpacks the `.deb` itself — no `dpkg-deb` — then `sudo rsync -a --delete` the
   right subtree into `<dest>/<package>`, leaving a `.installed.json` stamp behind.
7. Writes `~/.config/environment.d/50-<package>.conf` so the desktop session can
   see `bin/` and `share/`.

Steps 4-7 also work on their own, for a `.deb` you already have or a URL that
points straight at one — see [A single .deb](#a-single-deb).

## A single .deb

Sometimes there is no repository: a vendor links one `.deb` from a download
page, or you already have the file. Naming it as the only argument does the rest
of the work — unpack, subtree, `/opt`, `environment.d` — without a repository:

```sh
apt-extract ./some-app_1.2.3_amd64.deb
apt-extract https://example.com/downloads/some-app_1.2.3_amd64.deb
```

One argument is read as a `.deb` when it ends in `.deb` or names a file that
exists; otherwise it is a repository URL missing its package name, and that is
what the error says. The package name, version and architecture come from the
file's own control data — the same fields `dpkg-deb -f` prints — so there is
nothing to pass and nothing to get wrong.

**Nothing vouches for a file named this way.** There is no signed index in this
mode, which is the whole of what steps 1-3 above were for, so the tool prints
the SHA256 it computed and says plainly that it checked it against nothing:

```
sha256 3f9a...
warning: no signed index and no --sha256 — nothing vouches for this file
```

If the vendor publishes a digest, pass it as `--sha256 <hex>` and it becomes a
check that can fail — and a downloaded file is only reused from the cache when
it still matches one. The install stamp records which of the two happened
(`"trust": "signed-index"`, `"sha256"` or `"none"`), because "installed from a
signed repository" and "installed from a file I found" are different things to
have in `/opt`.

The repository options are refused here rather than ignored: `--fingerprint` on
a lone `.deb` would read as a signature check that never happened, and
`--version` or `--list` have no index to work from.

## Building

`bun run build` links everything — the entry point, `src/`, and a Bun runtime —
into one executable at `dist/apt-extract`, which runs on a machine with no `bun`
installed:

```sh
bun run build
./dist/apt-extract --help
sudo install -m 0755 dist/apt-extract /usr/local/bin/   # optional
```

It is a Bun standalone binary, so it is large (~90 MiB) and built for the host
platform. It is not minified — 13 KB saved is worth less than a stack trace that
still names its own functions. To build for another platform, add a target:

```sh
bun build --compile --sourcemap --target=bun-linux-arm64 index.ts \
  --outfile dist/apt-extract-arm64
```

The binary still shells out to `gpg`, `rsync` and `sudo` — see Requirements
below. `bun` and `dpkg` stop being needed.

## Releases

Pushing to `main` runs `.github/workflows/release.yml`, which hands the work to
[semantic-release](https://semantic-release.org): it reads the commit messages
since the last tag, decides whether that is a patch, a minor or a major, builds
the binaries for that version and publishes them as a GitHub release. Nothing is
committed back to the branch — the tag and the release are the record, and there
is no version field to keep in step.

So the commit messages decide the version. Conventional Commits, angular preset:

| commit                                   | effect        |
| ---------------------------------------- | ------------- |
| `fix: reject an expired Valid-Until`     | patch release |
| `feat: add --pick`                       | minor release |
| a `BREAKING CHANGE:` footer, or `feat!:` | major release |
| `docs:`, `chore:`, `test:`, `refactor:`  | no release    |

Each release carries one binary per target in `scripts/build-release.ts`
(currently `linux-x64` and `linux-arm64`) and a `SHA256SUMS` file:

```sh
sha256sum -c SHA256SUMS --ignore-missing
sudo install -m 0755 apt-extract-1.2.3-linux-x64 /usr/local/bin/apt-extract
```

The same build runs locally, which is the way to check a release build without
tagging one:

```sh
bun run build:release 1.2.3   # dist/apt-extract-1.2.3-linux-{x64,arm64} + SHA256SUMS
```

The workflow needs no secrets beyond the `GITHUB_TOKEN` Actions provides.

## Requirements

`bun` (not needed for a released binary), `gpg`, `rsync`, and `sudo`. Run it as
your normal user — it refuses to run as root and calls `sudo` only for the two
commands that need it.

`dpkg` is **not** required. The `.deb` is read here — the `ar` container, the
tar inside it, and gzip, xz, zstd or bzip2 around that — so a machine with no
Debian tooling at all can install from a Debian repository. Where `dpkg` does
happen to be installed, it is still asked to confirm version ordering, because
it is the authority on that and the check is free.

`gpg` stays a dependency on purpose. Verifying a signature is the one thing this
program exists to get right, and moving that into a bundled library would trade
an audited implementation for a supply-chain one to save a dependency that
anyone using an apt repository already has.

Two encodings `deb(5)` permits are not read: `lzma` (deprecated by dpkg, which
has never written it) and a bzip2 member over 64 MiB, which cannot be streamed.
Both say so and name `dpkg-deb` as the way out.

## Keys

This tool **never fetches signing keys**. A key downloaded over the same channel
as the thing it authenticates proves very little, so importing it is a separate,
deliberate act. Do it once, per repository:

```sh
curl -fsSL <key-url> | gpg --import
gpg --list-keys                     # read the fingerprint back
```

Confirm that fingerprint against the value the vendor publishes in their own
documentation before you trust it, then pass it with `--fingerprint`. Fingerprints
are accepted in the spaced form `gpg` prints, so you can paste it straight out.

To verify against a specific keyring file instead of your default one, use
`--keyring <file>`. It must be a dearmored (binary) keyring — `gpg --dearmor`.

## Example

For a repository whose `sources.list` line would be

```
deb https://apt.example.com/some-app/stable stable main
```

the four values this tool needs are the URL, the suite, the component, and the
package name — so, with the suite and component at their defaults:

```sh
# once: import and check the key
curl -fsSL https://apt.example.com/key.asc | gpg --import

# what's installed vs. what's available
bun index.ts https://apt.example.com/some-app/stable some-app \
  --fingerprint 0123456789ABCDEF0123456789ABCDEF01234567 --check

# every version in the repository
bun index.ts https://apt.example.com/some-app/stable some-app \
  --fingerprint 0123456789ABCDEF0123456789ABCDEF01234567 --list

# install or upgrade to the newest
bun index.ts https://apt.example.com/some-app/stable some-app \
  --fingerprint 0123456789ABCDEF0123456789ABCDEF01234567
```

For a repository you use regularly, wrap that in a `package.json` script or a
shell alias so the URL and fingerprint live in one place.

## Options

```
from a repository
  --fingerprint <FPR>   required: fingerprint of the key that must have signed
                        the index
  --keyring <file>      verify against this keyring instead of your default one
  --suite <s>           default: stable
  --component <c>       default: main
  --arch <a>            default: this machine's architecture
  --list                list available versions and exit
  --version <v>         install this exact version (default: newest)
  --pick                choose interactively (needs a terminal)

from a single .deb
  --sha256 <hex>        the digest the .deb must have. Without it the digest is
                        printed but there is nothing to check it against.

where things go
  --dest <dir>          parent directory (default: /opt) -> <dest>/<package>
  --from <subdir>       subtree of the .deb to install (default: auto-detected)
  --no-environment-d    don't write the environment.d drop-in

other
  --check               report installed vs. selected version, then exit
  --force               reinstall even if the installed version is current
```

## Which subtree gets installed

A `.deb` targeting a normal prefix puts everything under `usr/`, so `usr/bin` and
`usr/share` become `<dest>/<package>/{bin,share}` — that is the default when
`usr/` is the only top-level directory. A `.deb` that already targets `/opt` has
its final layout at `opt/<package>/`, which is used when present. Anything else
is ambiguous: the whole tree is installed and a note says so. `--from` overrides.

## Desktop integration, and why it's a generated file

`~/.config/environment.d/50-<package>.conf` is written with the lines the tree
actually needs:

```
PATH=/opt/some-app/bin:${PATH}
XDG_DATA_DIRS=${XDG_DATA_DIRS:-/usr/local/share:/usr/share}:/opt/some-app/share
```

A GNOME session is started by `systemd --user`, which never reads `.zshenv`,
`.profile` or any other shell file — so putting these in your shell config makes
them invisible to anything launched from the app grid, which is exactly where a
`.desktop` entry needs them. `environment.d` is the supported place, but its
format has no globbing and no existence tests, which is why this is generated per
install rather than written once by hand.

`systemctl --user daemon-reload` runs afterwards, which covers units started from
then on. **The running graphical session keeps its old environment until you log
out and back in.**

## What this is not

- **Not a package manager.** Maintainer scripts are never run and dependencies
  are never resolved — a `Depends` line names Debian packages that don't exist on
  Fedora anyway. A missing shared library shows up as a runtime crash, not an
  install error. This is for self-contained trees (Electron apps and the like),
  not for system packages.
- **Not an uninstaller.** `sudo rm -rf <dest>/<package>` and delete the
  `environment.d` file.
- **Not a mirror client.** Flat repositories (`deb <url> ./`) and
  `Release`+`Release.gpg` (detached, as opposed to clearsigned `InRelease`) are
  not supported.
- **`rsync --delete`** means anything you added by hand under
  `<dest>/<package>` is removed on upgrade.

## Tests

```sh
bun test
```

- `vercmp.test.ts` — Debian version ordering is a port of dpkg's `verrevcmp`
  (`1.24012.11` > `1.24012.9`, `1.0~rc1` < `1.0`); each case is checked
  differentially against `dpkg --compare-versions`. No network.
- `control.test.ts` — parser tests on `Packages` and `Release` fixtures. No network.
- `deb.test.ts` — which single argument is a `.deb` and which is a repository URL.
  No network.
- `debformat.test.ts` — what the `.deb` reader accepts and what it refuses: member
  order, `ar` long-name extensions, every compression `deb(5)` allows, and the
  hostile shapes — a path that climbs out of the package, an absolute path, a
  planted symlink written through, a hard link pointing outside. The fixtures are
  built byte by byte, because `tar` and `ar` decline to produce them. No network,
  no `dpkg`, no `tar`.
- `tamper.test.ts` — serves a local mirror of a real signed repository and asserts
  that a modified `InRelease`, a modified package index, a good signature from an
  unexpected key, and a missing key are each refused. A valid signature can't be
  fabricated, so this one needs a real repository to mirror and skips unless you
  name one:

  ```sh
  APT_TEST_REPO=https://apt.example.com/some-app/stable \
  APT_TEST_PACKAGE=some-app \
  APT_TEST_FINGERPRINT=0123456789ABCDEF0123456789ABCDEF01234567 \
  APT_TEST_KEY_URL=https://apt.example.com/key.asc \
  bun test
  ```

  `APT_TEST_KEY_URL` is optional — without it the key is expected to be in your
  default keyring already. `APT_TEST_ARCH` defaults to `amd64`. Nothing is
  installed: the tests run the CLI in `--check` mode.
