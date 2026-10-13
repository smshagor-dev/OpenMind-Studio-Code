# Privacy policy

OpenMind Studio is a desktop program. It has **no telemetry, no analytics, no advertising and no crash reporting**,
and its authors run no server that receives anything from it. Your files, settings, history and keys stay on your
computer (or in the folder you installed it to).

## What it sends, and when

### Automatically

1. **Update check.** About 45 seconds after start and then every few hours, the program requests the update feed
   (`latest.json`) of the newest release from GitHub
   (`https://github.com/smshagor-dev/OpenMind-Studio/releases/latest/download/latest.json`, served by GitHub and its
   download network). GitHub receives the request and your IP address, as with any download; nothing about you, your
   files or your use of the program is sent. With **Settings > Workbench > Automatic Updates** on (the default) a
   newer version is downloaded from the same release and verified against OpenMind Studio's signature; with it off the
   program only tells you a new version exists. The check itself can't be turned off yet.
2. **Extensions marketplace list.** While the **Extensions** view is shown, the Popular list is loaded from Open VSX
   (`open-vsx.org`, run by the Eclipse Foundation). Turn this off with **Settings > Extensions > Load Marketplace
   Automatically**; then Open VSX is contacted only when you search, open an extension page or install.

### Only when you ask for it

- **Downloads you start**: Runtime Manager runtimes and add-ons, Language Tools packages, language servers and
  workloads come from their publishers (e.g. nodejs.org, python.org, github.com, npm, PyPI, Maven Central); each is
  named in the program before it is downloaded, and verified where the source allows it (pinned SHA-256 checksums for
  runtimes and archives, lockfile integrity hashes for npm packages, Go's checksum database for Go tools).
- **Package tools you run** in the terminal (pip, npm, Git, Cargo, Go, Composer …) reach their own registries; the
  program's download gateway on your computer forwards them and adds nothing.
- **AI**: only the provider you configure, only when you send a message or run an AI action; online providers ask
  for confirmation (provider, address, what and how much) before anything leaves your computer. API keys are stored
  encrypted (Windows DPAPI) and are never sent anywhere else.
- **Git** remote operations (clone, fetch, pull, push) go to the remote you use.
- **Collaboration** (preview): while you host or join a room, the program talks to the other participants and, for
  connections across networks, to the signalling, STUN and TURN servers configured for the room; on a local network it
  announces the room to computers on that network.
- **Built-in browser** pages you open load whatever those pages load.
- **Network diagnostics** (Terminal > Network) contact the hosts they test, only when you run them; the saved report
  stays on your computer with secrets removed.

## Third parties

Requests to the services above are subject to their own privacy policies: GitHub
(https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement), Open VSX / Eclipse Foundation
(https://www.eclipse.org/legal/privacy/), and the AI provider, package registry or Git host you choose.

## Contact

Questions: smshagor.dev@gmail.com. Security issues: see [SECURITY.md](../SECURITY.md).
