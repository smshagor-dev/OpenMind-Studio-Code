# Unified Download Broker (Milestones 23 and 23.1)

On some networks (the reported case: a university PC) OpenMind's own Download Manager installs Python, Node.js, PHP,
Git and Composer without trouble, while `pip install`, `npm install`, `git clone` ... fail — in OpenMind's terminal and
in an ordinary PowerShell alike. The broker makes package tools download **the same way the Download Manager does**:
the same code (`openmind_runtime_manager::download`, `verify_sha256`, the retry/mirror policy), the same HTTP client
(`UreqClient`, built by `openmind_network::http::agent`), the same proxy route (No Proxy / System / Manual, with the saved
credentials) and the same TLS roots (rustls with the bundled Mozilla certificates).

It is **not** a VPN, a hidden tunnel for arbitrary programs, or a way around a firewall or an administrator's policy.
Certificate checks are never turned off, package hashes are always verified, and a program's own requests are never
routed. Nothing outside OpenMind's own processes changes: no global tool configuration, no PATH, no Windows/WinHTTP
proxy, no Registry.

## How a tool reaches the network

```text
pip / npm / pnpm / go / git / rustup      cargo / yarn / pnpm* / composer      openmind-fetch
        |  process-local settings                 | tunnel settings              | curl -> gateway
        v                                         v                              v
   package gateway (127.0.0.1, random ports, per-run token, Host header checked)
        |  metadata: passed through         |  CONNECT tunnel: the tool's own TLS
        |  artifacts: the broker            |  (HTTP or SOCKS5 proxy with OpenMind's credentials, or direct)
        v                                   v
   Download Manager route (UreqClient: proxy in force, rustls + Mozilla roots)  ->  the registry
```
`*` pnpm uses the tunnel only when you have your own `~/.npmrc`.

## Supported tool matrix

| Tool | How it is routed | What stays with the tool | Verified (23.1) |
| --- | --- | --- | --- |
| pip (portable, system, venv) | `PIP_INDEX_URL` -> `/pypi/simple/`; file links point at the gateway; the index page's SHA-256 is checked by the broker | resolution, markers, wheel tags, `--require-hashes`, installing | release build: `pip install six requests` into a venv |
| npm | `NPM_CONFIG_GLOBALCONFIG` -> `<app>/temp/config/npmrc` (the gateway's npm port + its bearer token); packuments unchanged | dependency tree, `package-lock.json` (keeps `registry.npmjs.org`), `npm ci`, integrity | install + `npm ci`, lock clean |
| npm with a project `.npmrc` | the project's `registry=` wins (npm reads project > user > global) | everything | 0 requests through the gateway |
| pnpm | OpenMind's npmrc via `NPM_CONFIG_USERCONFIG` when you have no `~/.npmrc`, else `PNPM_CONFIG_HTTPS_PROXY` -> tunnel | lockfile, store | both paths; lock clean |
| Yarn 1 | `YARN_HTTPS_PROXY` -> tunnel (metadata *and* tarballs) | `yarn.lock` keeps `registry.yarnpkg.com` | `yarn add`, frozen reinstall |
| Go | `GOPROXY` -> `/go` (zips via the broker), `sum.golang.org` through `sumdb/`; the upstream proxy follows `network.goProxy` live | checksum database verification, `go.sum` | `go get` |
| Git over HTTPS | `url.<gateway>/git/https/.insteadOf=https://` (process-local `GIT_CONFIG_*`): clone, fetch, pull **and push** through the gateway, packs streamed | object verification, the real `.git`; `origin` stays `https://…` | clone/pull/fsck on GitHub; private clone/push/pull/non-ff against a real `git-http-backend` |
| Git over SSH | **not routed** — your own `ssh`, keys, agent, `known_hosts`; diagnostics report port 22 / 443 reachability and why SSH failed | everything | categories checked on this PC |
| Cargo | `CARGO_HTTP_PROXY` -> tunnel | TLS, `Cargo.lock`, checksums | `cargo fetch` |
| rustup | `RUSTUP_DIST_SERVER`/`RUSTUP_UPDATE_ROOT` -> `/rustup`; archives via the broker, `.sha256` checked by rustup too | toolchain install, signatures | toolchain + component + target into a throwaway `RUSTUP_HOME` |
| Composer (OpenMind's or **any other**) | the `composer` launcher in `<app>/shims` runs the real Composer (`OPENMIND_REAL_COMPOSER`) with `HTTPS_PROXY` = tunnel for that process only | TLS, `composer.lock`, autoload | system Composer `require`/`install`/`update`; no leak into the shell |
| `openmind-fetch <url> [file] [sha256]` | the broker downloads (resume, retries, SHA-256 when given), `curl` saves it | — | good hash, bad hash (refused, no file), cancel + resume |

A tool you configured yourself (environment variable, `pip.ini`, `~/.npmrc` registry, `%APPDATA%\go\env`,
`~/.cargo/config.toml` proxy, rustup variables) is left alone and listed under *Left on your own settings*.
Not routed: Yarn Berry, conda, NuGet, Maven/Gradle, Dart/Flutter, Docker, anything a program downloads by itself.

## Authentication matrix

| Case | What happens | Where the secret lives |
| --- | --- | --- |
| Public registry / repository | no credentials involved | — |
| Proxy with a password | OpenMind's route uses the saved proxy credentials; tools never see them (no password in any process environment) | DPAPI-encrypted in OpenMind's settings |
| Private Git over HTTPS | the remote answers 401 -> the gateway asks **your** credential helper (`git credential fill`) for the **real host** (`github.com`, not `127.0.0.1`), retries once, `approve`s on success and `reject`s on a refusal; reused in memory for 15 minutes for the same host and path | your helper (Git Credential Manager, the Windows credential store ...) |
| Git push over HTTPS | the same, streamed `git-receive-pack`; a remote that refuses the push (no permission) returns its own message | your helper |
| Wrong / expired / cancelled credentials | Git gets **403** with a message naming the real host — never a 401, so Git never prompts for `127.0.0.1` | nothing stored |
| Git over SSH | not involved: your `ssh` checks host keys itself; OpenMind never reads or copies a private key, never accepts an unknown host key | your `~/.ssh` / agent |
| Private npm registry (scoped or project `.npmrc`) | npm talks to it directly with your token; OpenMind's file doesn't override a project registry | your `.npmrc` |
| npm through the gateway | the gateway's npm port requires the per-run bearer token from OpenMind's npmrc; `Authorization` headers are never forwarded upstream | `<app>/temp/config/npmrc` (deleted at shutdown; the token is dead once the gateway stops) |
| Gateway itself | a random per-run token in every main-port path; `Host` must name the gateway | memory only |

Credentials never appear in logs, UI events, diagnostics or error details (log-capture tests check tokens, passwords,
`Authorization` values and signed-address queries).

## Staging, cache policy and recovery

Artifacts are staged in `<app>/temp/<provider>/<hash>/` with a `.lock` held while in use and a `meta.json` (address
without user info or query, state). The staging folder is **transient, not a cache**:

- a verified file is handed over and its folder removed as soon as the last reader is done;
- a download that stops (cancel, network loss, crash) keeps its `.part`; the next request for it resumes with a Range
  request; partials older than three days are removed at start-up;
- a checksum mismatch deletes the file;
- start-up recovery removes what an earlier run left, keeps young partials, skips folders another running OpenMind
  holds, never follows links or junctions, and touches nothing outside `<app>/temp`;
- *Clear Temporary Files* (Network > Downloads) removes every unused staged folder, partials included.

Tool caches (npm, pip, Composer, Go, Cargo) stay the tools' own; OpenMind does not add a second, ever-growing cache.

## Concurrency and failure recovery

At most six artifacts download at once; the rest are shown as **Queued** and can be cancelled while waiting. Two
requests for one artifact share one download; a client that disconnects doesn't affect the other. A download that
fails unexpectedly still releases its waiters with an error and its place in the queue. Retries with back-off apply to
connection problems; a hash mismatch, a 404 or a refusal is not retried. A tool download is retried by running the command
again (the Downloads list has no Retry button because the tool that asked owns the download); the kept part resumes.

## Large files

A file is passed on to the tool **while it downloads** (`gateway::live`): the answer starts as soon as the first bytes
land in the staging `.part` file (or after 8 s at the latest) and is sent chunked as they arrive. Before, the tool got
nothing until the broker had the whole file, and pip gave up on large wheels such as TensorFlow's
(`ReadTimeoutError ... read timeout=15`). The checksum is still enforced: the chunked answer ends properly only when
the download succeeded *and* the bytes already sent equal the verified file; otherwise the connection is cut before
the last chunk, so the tool sees a broken transfer and never a finished wrong file (pip checks the hash too and
retries). A file that is already staged, or arrives within the first wait, is answered with its length as before.
pip in OpenMind's terminals also gets `PIP_TIMEOUT=120` (seconds between two reads) unless the user set a timeout
(`PIP_TIMEOUT`, `PIP_DEFAULT_TIMEOUT` or `timeout` in a pip.ini).

## Security

- 127.0.0.1 only, random ports, per-run token, `Host` header checked (no DNS rebinding); the npm port serves registry
  paths only, requires the token, refuses writes (publish/unpublish).
- Upstream: https only (the agent refuses anything else, redirects included — at most 5; a Git redirect is rewritten to
  stay on the gateway or refused), header allow-lists both ways, size limits (request head 64 KiB / 100 headers, bodies
  64 MiB, index pages 256 MiB, npm packuments 128 MiB, 128 connections), the Download Manager's timeouts, and staged file
  names derived by `safe_file_name` (no traversal).
- `fetch` refuses non-https, `file:`, UNC, user info, localhost, loopback, unspecified and link-local targets (no SSRF
  into this computer or a cloud metadata address); Git refuses `localhost`/loopback remotes; the tunnel admits port 443
  and host names only (a proxy on 127.0.0.1, e.g. Px/CNTLM, is allowed; a target on this computer never).
- Never: `sslVerify=false`, `--trusted-host`, `strict-ssl=false`, `GOINSECURE`/`GONOSUMDB`, global `git config`,
  `npm config set`, `pip config`, `go env -w`, Registry writes, Windows/WinHTTP proxy changes (policy tests scan the source).

## Downloads list and diagnostics

*Network > Downloads* shows each operation's stage (queued, resolving, connecting, downloading, verifying, finalizing,
complete, failed, cancelled), bytes, percentage, speed and attempt, with **Cancel**, **Copy Error Details** (tool, item,
stage, category, redacted message), **Clear Finished** (the last 50 are kept), **Clear Temporary Files**, **Save Network
Diagnostics** and **Open Diagnostics**.

`logs/openmind-network-diagnostics.json` (schema version 2) holds: the proxy mode and source, the names of inherited proxy
variables, the gateway state, **per-tool readiness** (routed via which variable, skipped with the reason, off,
unavailable — never a value), the last failure category, the executables found with their source (OpenMind-managed,
user-installed, system-installed), certificate backends, Git over SSH capability, and per host DNS, direct TCP and the
Download Manager route; then pip, npm, pnpm, Yarn, Go, Cargo, rustup, Composer and Git through OpenMind and the same as a
plain PowerShell would run them. A final pass removes the token and any proxy password from the whole file.

## Limitations

- **Not verified on the university network.** Everything above was checked on a developer PC. Whether it fixes the
  university case depends on why the tools fail there; `docs/university-validation.md` is the checklist, and the
  diagnostics file is how to find out.
- Git over SSH is never routed; if port 22 is blocked, use the HTTPS address of the repository.
- The per-run gateway token is visible in some tool output inside OpenMind's terminals (pip's "Looking in indexes"). It
  works only on this computer while this OpenMind runs; diagnostics and logs never contain it.
- Inside an OpenMind terminal `git remote -v` prints the gateway address (Git applies `insteadOf` when it prints);
  `.git/config` keeps the real `https://` address.
- Cargo, Yarn, pnpm (with your own `.npmrc`) and Composer are tunnelled: they reach the network over OpenMind's route but
  do their own TLS — a network that intercepts TLS needs their own certificate settings.
- The *installing* stage is the tool's own and isn't shown in the Downloads list.
- Windows x64 is the only platform where this was run.
