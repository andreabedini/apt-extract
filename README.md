# apt-extract

Install a package from a Debian apt repository onto a system that isn't Debian,
by unpacking it into `/opt/<package>` — doing by hand the parts of `apt` that
matter, and none of the parts that would lie to you.

```
bun index.ts <repo-url> <package> --fingerprint <FPR> [options]
```

or, from a compiled binary (see [Building](#building)):

```
apt-extract <repo-url> <package> --fingerprint <FPR> [options]
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
6. `dpkg-deb -x`, then `sudo rsync -a --delete` the right subtree into
   `<dest>/<package>`, leaving a `.installed.json` stamp behind.
7. Writes `~/.config/environment.d/50-<package>.conf` so the desktop session can
   see `bin/` and `share/`.

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

The binary still shells out to `gpg`, `dpkg-deb`, `rsync` and `sudo` — see
Requirements below. Only `bun` stops being needed.

## Requirements

`bun`, `gpg`, `dpkg` and `dpkg-deb` (Fedora: `dnf install dpkg`), `rsync`, and
`sudo`. Run it as your normal user — it refuses to run as root and calls `sudo`
only for the two commands that need it.

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
required
  --fingerprint <FPR>   fingerprint of the key that must have signed the index

selecting a version
  --list                list available versions and exit
  --version <v>         install this exact version (default: newest)
  --pick                choose interactively (needs a terminal)

where things go
  --dest <dir>          parent directory (default: /opt) -> <dest>/<package>
  --from <subdir>       subtree of the .deb to install (default: auto-detected)
  --no-environment-d    don't write the environment.d drop-in

repository layout
  --suite <s>           default: stable
  --component <c>       default: main
  --arch <a>            default: dpkg --print-architecture
  --keyring <file>      verify against this keyring instead of your default one

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
