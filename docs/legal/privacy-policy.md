# OpenMind Studio Privacy Policy

**Effective date:** the publication date of OpenMind Studio 1.0.3
**Last updated:** 13 October 2026
**Applies to:** OpenMind Studio, the desktop code editor for Windows, Linux and macOS, version 1.0.3 and later

This policy explains what OpenMind Studio stores on your computer, what it sends over the network, when, and to whom.
OpenMind Studio is a desktop program. Its developer runs **no server that receives your files, your activity or any
information about you**, and the program contains **no telemetry, analytics, advertising or automatic crash
reporting**. The program does make network requests, listed in section 3. Each one goes directly from your computer to
the service named there.

## 1. Who is responsible

OpenMind Studio is developed by Md Shahanur Islam Shagor (publishing as "OpenMind"). Contact for privacy questions:
**smshagor.dev@gmail.com**.

## 2. What OpenMind Studio stores on your computer

Everything below stays on your computer, or in the folder or network share where OpenMind Studio is installed. Nothing
is uploaded to the developer.

| What | Where | Purpose |
| --- | --- | --- |
| Settings, keyboard shortcuts, profiles | `settings/` next to the program (or your per-user data folder) | Your preferences |
| Local database (SQLite) | `data/openmind-studio.db`, or `data/machines/<id>/` for a portable copy used on several computers | Window layout, open tabs and session, recent files and folders, pinned folders, Explorer state, breakpoints, notebook trust records, extension and runtime records, collaboration rooms and their history |
| Search index | `data/search-index/` | Fast search in your project; it contains text from your project files |
| AI provider list and AI conversations | `data/ai/` (created only when you use AI) | Your configured providers and, unless you turn off **Save Conversation History**, your conversations |
| Logs | `logs/` | Diagnostics for you and for support. Logs stay local and are never sent automatically |
| Downloaded runtimes, tools, language servers, extensions, caches | `runtimes/`, `tools/`, `language-servers/`, `extensions/`, `cache/`, `temp/` | Programs you chose to install, and their download caches |
| Browser engine profile | `data/webview/` | Storage of the program's built-in web view |

Your project files stay where they are. OpenMind Studio reads and writes them only when you work with them.

**On a computer or network share used by several people** (an "all users" or network installation), each computer and
Windows account gets its own database, settings and logs. Downloaded runtimes and tools may be shared.

### Secrets

API keys for AI providers, proxy passwords, database passwords, collaboration Room Codes, TURN passwords and secrets
stored by extensions are kept encrypted with **Windows DPAPI**. Only your Windows account on that computer can decrypt
them. They are never written to logs and never sent anywhere except the one service they belong to.
**On Linux and macOS this encryption is not available yet: those secrets are stored in the program's local database
without encryption.** Protect that folder accordingly.

## 3. What OpenMind Studio sends over the network

### 3.1 Automatically

1. **Update check.** About 45 seconds after start, and then every few hours, the program downloads the update
   description file (`latest.json`) of the newest release from GitHub
   (`https://github.com/smshagor-dev/OpenMind-Studio/releases/latest/download/latest.json`). GitHub receives this
   request with your IP address and standard request headers, as with any download. No information about you, your
   files or your use of the program is added. On Windows, with **Automatic Updates** on (the default), a newer version
   is also downloaded from the same release and verified against OpenMind Studio's signature before it is installed.
   On Linux and macOS the program only tells you that a new version exists. The check itself cannot currently be turned
   off.
2. **Extension marketplace list.** While the **Extensions** view is shown, the list of popular extensions is loaded from
   Open VSX (`open-vsx.org`, operated by the Eclipse Foundation). Turn this off with **Settings > Extensions > Load
   Marketplace Automatically**. Open VSX is then contacted only when you search, open an extension page or install an
   extension.

### 3.2 Only when you start it

- **Downloads you choose**: runtimes and add-ons (Runtime Manager), tool packages and language servers (Language Tools),
  workloads and extensions. They come from their publishers, for example nodejs.org, python.org, github.com, npm, PyPI,
  Maven Central or Open VSX. Each source is shown before the download starts.
- **Package tools you run** in the integrated terminal (pip, npm, Git, Cargo, Go, Composer and others) contact their own
  registries. OpenMind Studio's download gateway on your computer forwards these requests and adds nothing to them.
- **AI features**: text is sent only to the AI provider *you* configured, and only when you send a message or run an AI
  action. Before anything goes to an online provider, the program shows the provider, its address and what will be sent,
  and asks for confirmation. A provider on your own computer receives the text directly.
- **Git** clone, fetch, pull and push contact the remote repository you use.
- **Collaboration (preview)**: while you host or join a room, the program connects to the other participants. Across
  networks it also connects to the signalling, STUN, TURN or classroom voice servers configured for that room. OpenMind
  Studio has none of these servers built in: they are chosen by you or your organisation. On a local network the program
  announces a hosted room to other computers on that network. Connections between participants are encrypted in transit
  (DTLS). The room's host computer stores the shared documents and an activity log of the room. A classroom voice server
  processes the audio it relays.
- **Built-in browser**: pages you open load whatever those pages load.
- **Proxy test and network diagnostics** contact the addresses they test, and only when you run them. The saved report
  stays on your computer, with secrets removed.
- **Links** you click open in your own web browser.

## 4. Third-party services

The services named in section 3 process your requests under their own privacy policies. They include GitHub
(<https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement>), the Eclipse Foundation / Open VSX
(<https://www.eclipse.org/legal/privacy/>), and the AI provider, package registry, Git host or collaboration server you choose.
OpenMind Studio does not sell or share information with anyone, because it does not collect any.

## 5. How long data is kept, and how to delete it

Local data is kept until you delete it.

- **Clear AI history**, **Clear Search Index**, **Clear Secrets** (per extension) and **Clear Credentials** (proxy) are in
  the program.
- Uninstalling removes the program files. On Windows, your data folders (`data/`, `settings/`, `logs/`) are kept so that a
  reinstall keeps your settings. Delete them by hand to remove everything.
- A portable copy keeps everything in its own folder: deleting the folder deletes all of its data.
- Data held by a third-party service (for example a Git host or an AI provider) is deleted through that service.

## 6. Security

Downloads are verified with pinned checksums or signatures where the source allows it. Updates are accepted only when
they carry OpenMind Studio's update signature. Secrets are encrypted on Windows (see section 2). No method of storage or
transmission is completely secure, and you are responsible for the security of your computer and of the services you
connect.

## 7. Children

OpenMind Studio is a general-purpose software development tool and is not directed at children. It does not knowingly
collect information from anyone, including children.

## 8. Changes to this policy

A changed policy is published with the release that changes the program's behaviour, with a new "Last updated" date.
The current version is always included with the program (`legal/PRIVACY-POLICY.md`) and published with each release.

## 9. Contact

Privacy questions and requests: **smshagor.dev@gmail.com**.
