# Deploy the public Terrarium distribution

Obtain the published static files, serve them at the root of your own origin,
and run a retained guest task. No application build, maintainer credential,
model provider or remote execution service is required. This procedure does not
qualify an autonomous agent or a resident model. The temporary HTTPS recipe below
passed the complete guest-task, retention and disk-export journey on the exact
public snapshot and environment recorded under **Observed qualification**.
The Caddy configuration is a separate, untested deployment example.

## Acquire and retain one exact snapshot

Use a clean operator directory with Git, Python 3.12 and 1 GiB of free disk space.
These commands use anonymous public Git access. They record the snapshot actually
received, check every exported file against its Git blob, and keep receipts and
Git metadata outside the served directory. Review `receipts/release.json` before
serving. Git consistency checks establish identity, not independent authorship.

```sh
set -eu
mkdir terrarium-copy
cd terrarium-copy
python3 - <<'PY'
import hashlib, os, pathlib, subprocess, tarfile
keep = "PATH LANG LC_ALL SSL_CERT_FILE SSL_CERT_DIR HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy TMPDIR".split()
env = {key: os.environ[key] for key in keep if key in os.environ}
env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL="/dev/null", GIT_TERMINAL_PROMPT="0")
subprocess.run(["git", "-c", "credential.helper=", "-c", "http.extraHeader=", "-c", "core.askPass=",
    "-c", "core.autocrlf=false", "clone", "--depth", "1", "--single-branch", "--branch", "main", "--no-tags",
    "https://github.com/niklas-olsson/niklas-olsson.github.io.git", "checkout"], env=env, check=True)
def git(*args):
    return subprocess.check_output(["git", "-C", "checkout", *args], env=env)
git("fsck", "--full", "--strict")
if git("status", "--porcelain=v1", "--untracked-files=all"):
    raise SystemExit("Checkout has modified or untracked files")
receipts = pathlib.Path("receipts")
receipts.mkdir()
commit = git("rev-parse", "HEAD").decode().strip()
(receipts / "public-commit.txt").write_text(commit + "\n")
(receipts / "public-tree.txt").write_bytes(git("rev-parse", commit + "^{tree}"))
(receipts / "git-files.txt").write_bytes(git("ls-tree", "-r", "--full-tree", "--long", commit))
(receipts / "release.json").write_bytes(git("show", commit + ":release.json"))
archive = receipts / "distribution.tar"
archive.write_bytes(git("archive", "--format=tar", commit))
expected = {}
for row in git("ls-tree", "-rz", commit).split(b"\0"):
    if not row: continue
    meta, name = row.split(b"\t", 1)
    mode, kind, digest = meta.split()
    if mode != b"100644" or kind != b"blob":
        raise SystemExit("Distribution contains a non-regular public file")
    expected[name.decode("utf-8")] = digest.decode("ascii")
site = pathlib.Path("site")
site.mkdir()
with tarfile.open(archive) as bundle:
    if any(not (member.isfile() or member.isdir()) for member in bundle.getmembers()):
        raise SystemExit("Export contains a link or special file")
    bundle.extractall(site, filter="data")
actual = {p.relative_to(site).as_posix(): p for p in site.rglob("*") if p.is_file()}
if set(actual) != set(expected):
    raise SystemExit("Export inventory differs from the recorded Git tree")
for name, path in actual.items():
    data = path.read_bytes()
    digest = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
    if path.is_symlink() or digest != expected[name]:
        raise SystemExit("Exported file differs: " + name)
with archive.open("rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
pathlib.Path("receipts/distribution.tar.sha256").write_text(digest + "  distribution.tar\n")
print("Verified", len(actual), "files; archive SHA-256:", digest)
PY
```

Keep `receipts/`, the archive and its matching `site/` together. `git-files.txt` is
the complete inventory; the commit and tree identify the public snapshot.
`git archive` retains that commit's timestamp and identity;
record `git --version` with the export digest if reproducing the archive bytes.
`release.json.artifact_sha256` identifies the publisher's release artifact,
**not** this tar or a GitHub-generated ZIP. Do not compare those different hashes.
Public refs move to one parentless snapshot. Later retrieval of a replaced commit
is not guaranteed; retain your verified copy. Serve only `site/`.

## Hosting contract and recipes

Use a dedicated, top-level HTTPS origin with ordinary certificate validation.
Keep every exported path unchanged beneath `/`, including same-origin workers,
`terrarium-isolation.js` and runtime files. Serve HTML as `text/html`, JavaScript
as `text/javascript` or `application/javascript`, CSS as `text/css`, and Wasm as
`application/wasm`. Missing assets must return an error, not an HTML app fallback.
Do not inject an audience/login wrapper into workers or binary responses.

**HTTPS example: [Caddy 2.11.9](https://github.com/caddyserver/caddy/releases/tag/v2.11.9).**
Install that release using its official instructions and verify `caddy version`.
Use a DNS name you control, pointing to the server. Caddy needs reachable ports
80/443, permission to bind them, and a persistent writable certificate directory.
Replace the domain and absolute export path in a `Caddyfile` outside `site/`:

```caddyfile
terrarium.example.org {
    root * /absolute/path/terrarium-copy/site
    header /terrarium-isolation.js Cache-Control "no-cache"
    file_server
}
```

```sh
caddy validate --config Caddyfile --adapter caddyfile
caddy run --config Caddyfile --adapter caddyfile
```

See Caddy's [static file contract](https://caddyserver.com/docs/caddyfile/directives/file_server)
and [HTTPS prerequisites](https://caddyserver.com/docs/automatic-https).
Verify your deployed file bytes and browser journey separately. A successful
trial on another hosting service does not test this Caddy TLS configuration.

**Local development: Python 3.12 standard-library server.** From
`terrarium-copy`, check `python3 --version`, then run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory site
```

Open `http://127.0.0.1:8000/` in its own tab. This route does not qualify remote hosting.

### Temporary HTTPS for a bounded trial

[Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
can expose that loopback server at a temporary HTTPS root origin without an
account, domain or provider key. This is a testing service with no uptime promise,
a limit of 200 concurrent requests and no Server-Sent Events. It is not a lasting
home for browser data: a restarted tunnel receives a different hostname and
therefore different browser storage. Keep the tunnel running through stop,
reload, retained read and disk export. Keep the downloaded disk outside the
browser before ending the trial. Current Terrarium cannot import that raw disk
back into a workspace.

For the qualified Linux x86_64 trial, the pinned tool was
[`cloudflared` 2026.11.0](https://github.com/cloudflare/cloudflared/releases/tag/2026.11.0),
40,283,099 bytes, SHA-256
`51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd`.
The commands below use `curl`, `sha256sum`, and Python. Keep the tool and its
configuration outside `site/`. From a separate terminal in `terrarium-copy`,
with the Python server still running:

```sh
set -eu
curl --fail --show-error --location --proto '=https' --proto-redir '=https' --output cloudflared https://github.com/cloudflare/cloudflared/releases/download/2026.11.0/cloudflared-linux-amd64
printf '51f7c68b57ed7269164075d7e789efce5b59355982f06392deeb037d982a51fd  cloudflared\n' | sha256sum --check -
test "$(wc -c < cloudflared)" -eq 40283099
chmod 700 cloudflared
mkdir tunnel-config
printf '{}\n' > tunnel-config/config.yml
python3 - <<'PY'
import os, pathlib, subprocess
root = pathlib.Path.cwd()
config = root / "tunnel-config"
keep = "PATH LANG LC_ALL SSL_CERT_FILE SSL_CERT_DIR HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy TMPDIR".split()
env = {key: os.environ[key] for key in keep if key in os.environ}
env.update(HOME=str(config), XDG_CONFIG_HOME=str(config))
subprocess.run([str(root / "cloudflared"), "tunnel", "--config", str(config / "config.yml"),
    "--no-autoupdate", "--url", "http://127.0.0.1:8000"], env=env, check=True)
PY
```

The child process uses the empty configuration directory and receives no inherited
tunnel credentials. Cloudflare connectivity needs outbound access to its tunnel
service, including port 7844. Open the printed `https://…trycloudflare.com/` URL with normal
certificate validation. Anyone with that URL can fetch the approved public files;
serve only `site/`. Cloudflare is an explicit hosting dependency, not a guest
execution or model provider. Guest networking remains off. Stop the tunnel and
server when the trial finishes. Record their actual versions, the temporary
origin and the browser journey independently. This recipe does not validate the
Caddy TLS configuration or create permanent hosting.

## Browser and resource prerequisites

Use a desktop browser with WebAssembly shared memory, Web Workers, service
workers, IndexedDB, localStorage and Web Locks. In **Workspace & storage**, use
**Enable x86_64 & reload**, then **Enable, stop & reload**. Verify page isolation and
shared memory are ready. The helper adds isolation headers to same-origin
documents/workers; it is not an offline cache. It refuses overlapping unrelated
service workers. Use a dedicated origin instead of replacing another app's worker.

Storage belongs to this origin and browser profile. Inspect the storage estimate
and request persistence if offered; refusal leaves best-effort storage. Clearing
site data, changing origin or losing the device can remove results. Missing
isolation, IndexedDB or Web Locks must leave a clear unsupported/error state.
Do not proceed by switching execution mode. Embedded pages, subpath deployment,
offline use and untested browsers/devices are outside this procedure's scope.

For the bounded trial below, allow one guest, one 16 MiB disk, at most 1 GiB of
origin storage, 512 MiB of application acquisition/browser downloads and 20 minutes
total, with a four-minute observation limit for each boot. These are trial limits,
not promised runtime completion times. Installed tools are separate downloads.
Where process monitoring is available, also enforce
a 4 GiB aggregate browser/worker RSS cap. Otherwise record RSS as unmeasured and
do not claim that cap was enforced. Reservations and JavaScript heap are not RSS.
The **Worker** preset uses 1,024 MiB guest RAM, one vCPU, a 2,300 MiB Wasm
reservation and a 500 MiB translation-cache ceiling. Browser, JavaScript and
storage buffers need additional memory. The automated trial required more than
4.5 GiB free host memory before starting. That preflight and the observed host
capacity below are not a proven minimum device requirement. Check available quota
before creating disks.

## Complete and retain a small guest task

Use a fresh browser profile for this trial. In **Machines**, remove its unused,
stopped **local-01** starter with **Delete machine**, then follow the steps below.

1. Create an **Alpine x86_64** machine. While stopped, select the **Worker**
   hardware preset and **Built-in pinned Linux image**. Keep networking **Off**.
2. Create a **16 MiB** data volume, attach it to slot 0, then boot. The mount is
   `/mnt/volumes/disk0`. Use the Commands UI to run this one command:

```sh
printf 'category,value\nalpha,2\nbeta,3\nalpha,5\nbeta,7\n' > /tmp/input.csv && awk -F, 'NR > 1 { total[$1] += $2 } END { for (key in total) printf "%s,%d\n", key, total[key] }' /tmp/input.csv | LC_ALL=C sort > /mnt/volumes/disk0/summary.txt && sync && cat /mnt/volumes/disk0/summary.txt
```

The input is exactly 45 bytes, SHA-256
`20febf4c346eb199cac452260c31bcd02f01c633ed1e365d4c57936b4bf3716d`.
Expected output is exactly `alpha,7\nbeta,10\n`: 16 bytes, SHA-256
`e9bc35b57bedcfcea0e07194ede9719028a9a55d5ef2e9fb5dd3420ba379cbdb`.
Check with `wc -c` and `sha256sum` on both files. Wait for command and resource
operations to finish before confirming **Stop**; opening the terminal can briefly
use the command channel to update its dimensions. Wait for completed disk
teardown, reload, boot the same machine and read/hash `summary.txt` again.
Do not rerun the producing command. Temporary root files, including `/tmp/input.csv`,
are not retained by a fresh boot. Then **Stop** again and export the data disk.

Keep both the raw `.img` and its JSON metadata. Verify the downloaded image is
16,777,216 bytes and its SHA-256 matches the metadata. Export does not provide a
supported raw-disk import or workspace restore path. Configuration export also
does not contain disk contents. Record actual download bytes/digest, app commit,
tree and release, browser/OS/device, origin, runtime/image identity, elapsed times,
storage before/after and observed memory separately from reservations.

The Worker uses `qemu@8.2.0-terrarium-0ef7b4e-s1-candidate-v3`, Alpine 3.21.4 and
Linux 6.12.38-0-virt. Its six pinned runtime/guest payloads total 48,798,962 bytes
from your origin; worker scripts, manifests and application assets add bytes.
The default **Small** preset instead fetches legacy assets from
`raw.githubusercontent.com`; it is a different dependency path. Acquisition needs
GitHub, and your HTTPS host needs its DNS/certificate services. Optional model,
network and connected-execution services are unused in this trial.
Keep the [runtime notices](../runtime/THIRD_PARTY_NOTICES.md) and [source companion guide](runtime-sources.md).
Source archives are separate inspection/reconstruction downloads, not needed to serve these files.

## Observed qualification

On 2026-11-13, one complete automated trial passed against the approved public
**v0.10.1** snapshot: commit `421b8a7248c54f487dd7e38c182171e01eeedbd5`,
tree `d463958183c32a6e99218fc1e98df9338b576898`. Its complete verified export
contained 256 files and 106,094,645 uncompressed payload bytes. This identifies
the tested snapshot; it does not qualify every future release automatically.

The trial acquired public files anonymously and served only that verified export
through Python 3.12.3 and the pinned Quick Tunnel above. Headless Chrome
157.0.8103.50 used its sandbox and ordinary certificate validation. Browser and
server ran on one Ubuntu 24.04.5 x64 hosted VM, with two logical CPUs and
8,317,935,616 bytes of RAM. Automation used Playwright 1.62.1 and Node 24.22.2;
those two tools are not required to follow the manual browser instructions.

| Observed boundary | Result |
| --- | --- |
| Isolation before enablement | Visible x86_64 refusal, zero guest workers, no execution fallback |
| First Worker boot | 49.597 seconds; pinned runtime and guest identity verified |
| CSV task | Exact 45-byte input and 16-byte result matched the digests above |
| First clean-stop phase | 7.541 seconds; successful stop, closed disk, idle runtime and zero guest workers |
| Page reload | 0.552 seconds; same stopped definition and disk attachment retained |
| Fresh boot and retained read | 41.418 seconds; original result read without regenerating it, temporary input absent |
| Second clean-stop phase | 6.559 seconds; successful stop, closed disk, idle runtime and zero guest workers |
| Actual disk download | 16,777,216 bytes; its SHA-256 and volume identity matched the downloaded JSON metadata |
| Complete trial | 165.934 seconds, followed by 0.141 seconds of orderly browser/server/tunnel cleanup |
| Sampled aggregate browser RSS | Peak 3,692,896,256 bytes, about 3.44 GiB, under the predeclared 4 GiB cap |
| Origin storage estimate | Maximum 149,038 bytes reported; persistent storage was not enabled (`persisted()` returned false) |
| Application acquisition/request accounting | 154,657,321 bytes under the 512 MiB cap; 130 original responses verified |

The RSS observer sampled the Chrome process and its observed descendants every
250 ms, retaining 389 samples. Shared pages can be counted in more than one
process. This is not an instantaneous maximum, JavaScript heap measurement or
whole-host memory figure; the separate Node observer is outside that RSS sum.
The application byte account conservatively counts repeated requests and
service-worker/frame duplicates. It is not literal network traffic. The
40,283,099-byte tunnel tool and other installed tools are separate downloads.
The disk's logical size is distinct from the browser's origin-usage estimate.

Both boots observed 2,411,724,800 bytes of Wasm linear memory. The guest stayed
inside the visitor's browser runtime, with guest networking off and no model
provider or connected execution service. The same browser process, context and
temporary HTTPS origin remained throughout the stop/reload/fresh-boot journey.

This qualifies that bounded sequence on the named environment. It does not
establish browser restart, host reboot, crash or power-loss recovery, resistance
to storage eviction, offline use, separate physical devices, mobile browsers,
other browser/OS versions, subpath deployment or embedding. A new tunnel hostname
has different origin storage. Retain the downloaded disk and metadata before
ending a temporary host. Raw-disk import and whole-workspace restore remain
unsupported, and the Caddy TLS recipe still needs its own deployed trial.
