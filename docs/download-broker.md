# Unified Download Broker (Milestone 23)

On some networks (the reported case: a university PC) OpenMind's own Download Manager installs Python, Node.js, PHP,
Git and Composer without trouble, while `pip install`, `npm install`, `git clone` ... fail — in OpenMind's terminal and
in an ordinary PowerShell alike. The broker makes package tools download **the same way the Download Manager does**:
the same code (`openmind_runtime_manager::download`, `verify_sha256`, the retry/mirror policy), the same HTTP client
(`UreqClient`, built by `openmind_network::http::agent`), the same proxy route (No Proxy / System / Manual, with the saved
credentials) and the same TLS roots (rustls with the bundled Mozilla certificates).

It is **not** a VPN, a hidden tunnel for arbitrary programs, or a way around a firewall. Certificate checks are never
turned off, package hashes are always verified, and a program's own requests are never routed.

## How a tool reaches the network

```text
pip / npm / pnpm / go / git            cargo / OpenMind's composer         openmind-fetch
        |  process-local settings              | CARGO_HTTP_PROXY / launcher          | curl -> gateway
        v                                      v                                      v
   package gateway (127.0.0.1, random ports, per-run token, Host header checked)
        |  metadata: passed through         |  CONNECT tunnel: the tool's own TLS
        |  artifacts: the broker            |  (HTTP or SOCKS5 proxy with OpenMind's credentials, or direct)
        v                                   v
   Download Manager route (UreqClient: proxy in force, rustls + Mozilla roots)  ->  the registry
```

| Tool | How | What stays with the tool |
| --- | --- | --- |
| pip | `PIP_INDEX_URL` -> `/pypi/simple/`; file links point at the gateway; the page's SHA-256 is checked by the broker | resolution, markers, wheels tags, `--require-hashes`, installing |
| npm | `NPM_CONFIG_REGISTRY` -> its own port (npm keeps only a registry's origin); packuments unchanged, so `package-lock.json` keeps `https://registry.npmjs.org/`; npm's default `replace-registry-host` sends tarballs to the gateway | dependency tree, lockfile, `npm ci`, integrity |
| pnpm | `PNPM_CONFIG_REGISTRY` (pnpm 10+ ignores `npm_config_*`); tarball links point at the gateway (pnpm's lockfile keeps only integrity) | same |
| Yarn 1 | metadata through the gateway; tarballs from the addresses in `yarn.lock` (not routed) | — |
| Go | `GOPROXY` -> `/go`; module zips via the broker; `sum.golang.org` through the documented `sumdb/` paths | checksum database verification, `go.sum` |
| Git | `url.<gateway>/git/https/.insteadOf=https://` (process-local `GIT_CONFIG_*`): discovery + `git-upload-pack` through the gateway, the pack streamed back; `origin` stays `https://...` | object verification, the real `.git` (history, refs, remotes); **push** uses Git's own connection |
| Cargo | `CARGO_HTTP_PROXY` -> the gateway's CONNECT tunnel (source replacement can't be set from the environment — tested) | TLS, `Cargo.lock`, checksums |
| Composer | OpenMind's portable `composer` launcher sets `HTTPS_PROXY` to the tunnel for Composer's own process (`setlocal`) | TLS, `composer.lock`, autoload |
| `openmind-fetch <url> [file] [sha256]` | the broker downloads (resume, retries, SHA-256 when given), `curl` saves it | — |

## Staging and cleanup

Artifacts are staged in `<app>/temp/<provider>/<hash>/` (`downloads`, `pypi`, `npm`, `go`, `git`, `composer`, `cargo`)
with a `.lock` held while in use and a `meta.json` (address, state). A download that stops keeps its `.part` (the next
request resumes it with a Range request); a verified file is handed over and its folder removed as soon as the last
reader is done; a checksum mismatch deletes the file. At start-up, recovery removes what an earlier run left behind,
keeps partial downloads younger than three days and skips folders another running OpenMind holds. Links and junctions
are never followed, and nothing outside `<app>/temp` is touched. Git needs no staging (the pack is streamed; Git's own
temporary packs are Git's). Two requests for the same artifact share one download.

## Security

- Listens on 127.0.0.1 only, on random ports. Every main-port path carries a random per-run token; the `Host` header must
  name the gateway (a web page can't reach it through DNS rebinding); the npm port serves registry paths only and refuses
  writes (publish/unpublish). The tunnel admits only a client with the token, only port 443, only host names (never this
  computer).
- Upstream requests are https only, with header allow-lists both ways; credentials never leave OpenMind (the proxy
  password is not in any process environment any more).
- Never: `sslVerify=false`, `--trusted-host`, `strict-ssl=false`, `GOINSECURE`/`GONOSUMDB`, global `git config`, `npm
  config set`, `pip config`, `go env -w`, Registry writes, Windows/WinHTTP proxy changes (policy tests scan the source).

## Diagnostics

*Network > Downloads > Save Network Diagnostics* (or *Terminal > Network > Save Network Diagnostics*) writes
`logs/openmind-network-diagnostics.json`: the proxy mode and source, the names of proxy variables Windows gave the app,
the gateway state and the tools left on their own settings, the executables found, the certificate backends, and per
host (PyPI, files.pythonhosted.org, npm, GitHub, proxy.golang.org, sum.golang.org, crates.io, Packagist, nodejs.org):
DNS, a direct TCP connect to 443 and **A** the Download Manager's route; then **B-E** pip, npm, Composer and Git through
OpenMind (the environment an OpenMind terminal gets — **G**) and **F** the same tools as an ordinary PowerShell would run
them. No password, token or credential is written.

## Limitations

- **Not verified on the university network yet.** Everything above was checked on a developer PC (real pip, npm, npm ci,
  pnpm, git clone/fetch/pull, go mod download, cargo fetch through the gateway). Whether it fixes the university case
  depends on why the tools fail there; the diagnostics file is how to find out.
- Git over the gateway: a private repository asks for credentials for `127.0.0.1` (a saved Git credential for the real
  host doesn't match); SSH remotes and pushes are not routed.
- Cargo and Composer are tunnelled: they reach the network over OpenMind's route but do their own TLS. A system Composer
  (not OpenMind's) isn't routed. rustup's own toolchain downloads aren't routed.
- Yarn 1 tarballs, Yarn Berry, conda, NuGet, Maven/Gradle, Dart/Flutter, Docker are not routed.
- A project `.npmrc` with its own default registry is overridden by `NPM_CONFIG_REGISTRY` in OpenMind terminals (turn the
  gateway off for such projects); scoped registries are not affected.
- The Go module proxy is read at start-up (`network.goProxy`: restart OpenMind after changing it).
