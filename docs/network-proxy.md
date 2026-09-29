# Network, proxy and offline packages

OpenMind Studio can work on university, lab and company networks that only allow traffic through a proxy, and on
computers with no network at all. It does this by **using the proxy you configure or the one Windows already uses**,
and by **importing packages you bring on a USB drive**. It never bypasses anything.

## Policy (what OpenMind will not do)

- No firewall, captive-portal, admin or network-policy bypass, and no hidden tunnel. Traffic goes where your proxy
  settings (or Windows') send it.
- No change to Windows' proxy settings, the Registry, the User/Machine `PATH`, or any tool's global configuration
  (`.npmrc`, `pip.ini`, `git config --global`, Cargo's or Go's config). Proxy variables are given **only to processes
  OpenMind starts**, for that process only.
- No network request at launch, no background connectivity check, no telemetry, no OpenMind server. The only requests
  are the ones you start: **Test Connection**, a runtime/Language Tools/extension download, or a tool you run.
- No administrator rights.

`crates/network/tests/policy.rs` fails if the network crate's source ever writes the environment, the Registry or the
Windows proxy, starts a program, names a tool's global config file, or uses automatic proxy discovery (WPAD).

## Modes

Settings > **Network** (or *Terminal > Network > Proxy Settings...*, or *Network: Open Proxy Settings* in the F1 palette).
All Network settings are **user scope**: a project's `.openmind/settings.json` can't redirect your traffic.

| Mode | What happens |
| --- | --- |
| **No Proxy** (default) | OpenMind adds nothing. Processes and OpenMind's own requests behave exactly as without this feature. |
| **Use System Proxy** | OpenMind reads the proxy that is already configured and uses it. Sources, in order: the environment (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, upper or lower case), Windows Internet Settings for your user (WinHTTP's `WinHttpGetIEProxyConfigForCurrentUser`), the machine's WinHTTP proxy (`netsh winhttp`). The window says which one was found, or "No proxy detected". |
| **Manual Proxy** | HTTP proxy, HTTPS proxy (empty = the HTTP one), optional SOCKS5 proxy, and the no-proxy list. |

Addresses are `host:port` or `http://host:port` (`socks5://host:port` for SOCKS). A user name or password inside an
address is refused (it would be stored in plain text in `settings.json`); use the credentials fields.

**No proxy for**: comma-separated hosts reached directly. `localhost`, `127.0.0.1` and `::1` are always direct (so local
AI providers, language servers and debug adapters are never sent to a proxy). `.corp` / `*.corp` / `corp` match the
domain and its sub-domains; `<local>` (from Windows) matches names without a dot.

**PAC scripts** (automatic configuration, `AutoConfigURL`) are **not evaluated**: the window shows the script's address and
asks you to enter the proxy manually. Evaluating one would mean downloading and running a script.

### Credentials

Only if the proxy asks for them (HTTP 407). User name and password/token are **encrypted with Windows DPAPI** for your
Windows user (`editor_settings` row `network.proxy.credentials`, `dpapi1:...`), never returned to the UI (it only learns the
user name), never logged. *Network: Clear Proxy Credentials* deletes them. In System mode, saved credentials win over ones
written into an environment variable. Special characters are percent-encoded in the proxy URL given to tools.

## What gets the proxy

Every process OpenMind starts goes through one place (`commands::run::environment`), so all of these get the same
variables: **terminals, Run Code, tasks, the debugger, language servers, the extension host, notebooks' kernels, the PHP
server, MariaDB/phpMyAdmin/Composer, the PHP panel's shell** — plus **Git** (its own runner) and OpenMind's own HTTP
requests: **Runtime Manager downloads, Open VSX (marketplace), AI providers** and **Test Connection**.

Variables (only when a proxy is in force):

| Variable | Value | Used by |
| --- | --- | --- |
| `HTTP_PROXY`, `http_proxy` | the HTTP proxy URL (with credentials) | curl, wget, git, pip, npm, composer, go, most tools |
| `HTTPS_PROXY`, `https_proxy` | the HTTPS proxy URL | same |
| `ALL_PROXY`, `all_proxy` | the SOCKS proxy, if set | curl, git |
| `NO_PROXY`, `no_proxy` | the no-proxy list | same |
| `NPM_CONFIG_PROXY`, `NPM_CONFIG_HTTPS_PROXY`, `NPM_CONFIG_NOPROXY` | same values | npm, pnpm, yarn (classic) |
| `PIP_PROXY` | the HTTPS proxy | pip |
| `CARGO_HTTP_PROXY` | the HTTPS proxy | cargo |
| `GOPROXY` | only if you set *Go Module Proxy* | go |
| `PIP_FIND_LINKS` | the offline wheels folder as a `file:///` URL (pip splits this variable on spaces, and the app folder usually has one), only with *Use Offline Python Packages* on | pip |

Per tool:

- **git** — the variables (git's curl honours them). No `git config` is written. A proxy 407 is reported as a network
  problem, not as "the remote wants a password".
- **pip** — `PIP_PROXY` + the variables. OpenMind never writes `pip.ini`.
- **npm / pnpm / yarn** — `NPM_CONFIG_*` + the variables. `.npmrc` is never written. Yarn Berry (2+) reads only its own
  `httpProxy` setting: configure it in the project if you use it.
- **Composer** — the variables (Composer reads `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`).
- **cargo** — `CARGO_HTTP_PROXY`. SOCKS isn't supported by Cargo through this variable.
- **go** — the variables; `GOPROXY` only if you configure it (a module mirror, not a network proxy).
- **curl / wget** — the variables.

*Network: Show Current Terminal Proxy Environment* lists what a new terminal gets, with the password as `****`.
The terminal panel's header shows **Network: No Proxy / Manual Proxy / System Proxy / Offline Cache**; when a proxy is in
force the first terminal of the session shows "Proxy environment applied to this terminal session." once.
**A terminal that is already open keeps the environment it started with** — open a new one after changing the proxy.

## Diagnostics

The Proxy tab starts with a **Diagnostics** list whenever the backend ignores or can't do something with the settings, so
nothing is dropped silently:

- an address that is ignored, and why: credentials in the URL (for example an `https` value hand-edited into `settings.json` as
  `http://user:pass@host:port` — *"HTTPS proxy is ignored because it contains credentials in the URL. Store credentials in the
  secure username/password fields instead."*), an unsupported scheme, a bad port, not a `host:port`;
- a PAC script or "Automatically detect settings" (WPAD) in Windows: reported, never evaluated;
- only a SOCKS proxy set (pip, npm, pnpm, Yarn and Cargo read `HTTP_PROXY`/`HTTPS_PROXY` and won't use it);
- saved credentials that can't be read (another Windows user, damaged), and — as information — no credentials saved;
- open terminals that still have the old proxy settings.

A diagnostic never contains the ignored address itself.

## Test Connection

One GET to the address you type (or the *Connection Test Address* setting, `https://pypi.org/` by default), through the
proxy in force, no redirects, 10 s to connect / 15 s to answer, no retries. The result leads with an actionable label, then
the route (through which proxy, or directly), the HTTP status and the time, a hint, and the raw error under **Details**:

| Label | Typical cause |
| --- | --- |
| DNS lookup failed | the name can't be resolved (a network that resolves names only through its proxy) |
| Connection timed out / Connection refused | nothing answers; a firewall drops the traffic |
| Network unreachable | no network, or no route to the address |
| Proxy server unavailable | wrong proxy address or port (through a proxy, a refused connection or an unknown name means the proxy itself), or the proxy refused the tunnel |
| Proxy authentication required | HTTP 407: enter the credentials |
| TLS certificate verification failed | a network that inspects HTTPS, an expired certificate, a wrong clock |
| TLS handshake failed | the server doesn't speak HTTPS on that port, or the network cuts HTTPS |
| Blocked by the network or server | HTTP 403/451 |
| Checksum mismatch | (downloads) the file isn't the expected one |

Name lookups and TLS handshakes fail as I/O errors in the HTTP client; since Milestone 22.2 they are classified by the Windows
error code (11001-11004 = DNS) and the error text, so they no longer show as "reading from the network failed".

## Downloads (Runtime Manager, Language Tools, extensions)

- Proxy-aware (the route above; loopback is always direct).
- **Retry with backoff**: a timeout, dropped connection or server error is retried up to 3 times per address with a
  1 s, then 2 s pause. Every retry is logged. Proxy authentication and cancellation stop at once (no hidden loops).
- **Resume**: a partial file (`.part`) is resumed with an HTTP range request when the server supports it.
- **Mirrors**: a runtime manifest artifact may list `"mirrors": ["https://..."]`; after the main address fails they are tried
  in order. The checksum is the same, so a mirror can't hand over a different file.
- **Checksum first**: nothing is extracted or run before its SHA-256 matches the manifest. A mismatching file is deleted and
  the next address is tried. A verified file is kept in `cache/downloads/` and reused.
- Nothing is downloaded at launch.

Language Tools' npm installs (`npm ci`) and extension-host processes get the proxy through the process environment.

## Offline packages

*Terminal > Network > Import Offline Package...* (or the Network window's **Offline Packages** tab). Choose a file (USB
drive, shared folder); OpenMind shows what it is before anything is copied:

| File | Recognized by | After import |
| --- | --- | --- |
| Runtime archive (Node.js, Python, PHP, MariaDB, Git, Composer ...) | its **SHA-256** matching a Runtime Manager manifest entry | copied to `cache/downloads/`, where the Runtime Manager looks first: **Install** then needs no network (it verifies the checksum again) |
| Extension `.vsix` | `extension/package.json`, `TargetPlatform` | handed to the normal install flow (trust dialog, permissions) |
| Python wheel `.whl` | the file name's platform tag (`win_amd64` or `any`) | `cache/offline/wheels/`; with *Use Offline Python Packages* on, pip in new processes also looks there (`PIP_FIND_LINKS`) |
| npm package `.tgz` | name-version | `cache/offline/npm/` (install with `npm install <path>`) |
| Composer package `.zip` | a `composer.json` at the top | `cache/offline/composer/` (use as a Composer `artifact` repository) |
| Source ZIP (e.g. GitHub "Download ZIP") | any other ZIP | *Extract to Folder...* into an **empty** folder — a fallback when `git clone` can't reach the server |

### Python wheelhouse (no network)

**Import Wheels Folder...** imports every `.whl` directly in a folder (a USB drive, or `pip download django pandas -d <folder>` run on
another computer): the ones for this computer are copied into `cache/offline/wheels/`, the others are listed with the reason. The
**Python wheelhouse** section lists the recognized packages; type the packages (`django pandas`, `pandas==3.0.6`, `requests[socks]`)
and **Install from Wheelhouse** types this into a new terminal:

```
python -m pip install --no-index --find-links=file:///E:/.../OpenMind%20Studio/cache/offline/wheels django pandas
```

`--no-index` means pip looks only in the wheelhouse and makes no network request; the folder is a `file:///` URL, so a path with
spaces works. Only package names with extras and one version clause are accepted — no options, URLs, paths or shell characters.
The command uses the `python` first on the new terminal's PATH (the portable runtime first).

Packages for another platform (a `manylinux` wheel, a `linux-arm64` extension, a runtime for another architecture) are
refused with the reason. Extraction refuses `..`/absolute/drive names and links, and caps size and entry count. The
source file is never moved or changed. Nothing is written to npm's, pip's or Composer's global caches.

The cache index is `cache/offline/index.json` (a damaged index reads as empty). Each package shows as **Local Import /
Offline Cache**; Remove, Clear Cache and Open Package Cache Folder are in the tab.

## When something fails

When Git, the Runtime Manager, Composer, a task, the LSP installer, Run Code or a terminal prints a network failure,
a card appears with **Configure Proxy**, **Retry** (when the failed action can be repeated, e.g. a runtime install),
**Open New Proxy-Ready Terminal**, **Import Wheels / Offline Package** and **Use Offline Cache**.

**pip** ending with `No matching distribution found` after `407 Proxy Authentication Required` / `Tunnel connection failed` is a
proxy problem, not a missing package, and the card says so: *"pip could not reach PyPI because the network proxy requires
authentication. This is not a missing Python package."* (the proxy indicators always win over pip's closing lines, even when they
arrive in a later chunk of terminal output). A tunnel failure without 407 is "proxy unavailable". Without any network cause, a
missing package raises no card. Terminal output only counts unmistakable problems (proxy 407, proxy
unreachable, TLS, DNS), so a `ping` timing out doesn't raise it. A dismissed problem stays quiet for two minutes.
Details stay in the Output channels, with the proxy password removed.

Card actions for a terminal failure: **Retry Command** runs the command you typed again — only after the click — in a new terminal
with the current proxy variables, the same shell and the folder the failed terminal started in. A command that can delete or
change files or system settings (`Remove-Item`, `rm -rf`, `del /s`, `format`, `reg`, `git clean`, a redirection `>`, `| sh` ...)
asks first, showing the command and folder. **Open New Proxy-Ready Terminal** opens one.

Terminals opened before a proxy change keep the old variables. They are marked stale: the header shows `⚠ Network: ...` and the
terminal shows a banner *"Proxy settings changed. Open a new terminal to apply them."* with **Open New Proxy-Ready Terminal** (same
shell and folder), **Restart This Terminal With Proxy** (asks first; the new terminal is started before the old one is closed, so a
failure keeps it) and **Keep Current Terminal** (no warning for it until the next change). A notice says so once, except while the
failure card is up (it would cover the card's buttons).

## Troubleshooting

- *"the proxy requires a user name and password"* — Network > Proxy Authentication, then Retry.
- *pip: `ProxyError('Cannot connect to proxy.')`* — the proxy address/port is wrong; Test Connection shows "Proxy unavailable".
- *git: `SSL certificate problem: unable to get local issuer certificate`* — the network inspects HTTPS. OpenMind does not
  disable certificate checks; ask the administrator for the certificate, or import the package offline.
- *npm: `ENOTFOUND registry.npmjs.org`* — the network resolves names only through the proxy: choose Manual or System
  Proxy.
- *It works in a new terminal but not in an old one* — old terminals keep the environment they started with.
- *Windows uses a PAC script* — enter the proxy manually (ask your IT department for `host:port`).

## Limitations

- PAC/WPAD auto-configuration is not evaluated. Per-URL proxy rules from a PAC script are not supported.
- SOCKS: OpenMind's own requests support SOCKS5; tools support it unevenly (Cargo doesn't through `CARGO_HTTP_PROXY`).
- Proxy authentication is Basic (user name + password in the proxy URL/headers); NTLM/Kerberos negotiation isn't
  implemented.
- Already-running processes (open terminals, a running language server) keep their environment until restarted.
- Offline npm/Composer packages are cached, not installed: you run the install command with the local path.
- Pause/resume of a download is automatic (a failed download resumes on the next attempt); there is no Pause button.
- Retry Command and Restart use the folder the terminal *started* in; a `cd` typed later isn't known.
- The risky-command check is a word list: it asks for more than necessary rather than less, but it is not a parser.
- A bare "Tunnel connection failed" without a 407 is reported as proxy unavailable, not as authentication.
- pip's own download cache (`%LOCALAPPDATA%\pip\cache`) is pip's default; OpenMind doesn't redirect it.
