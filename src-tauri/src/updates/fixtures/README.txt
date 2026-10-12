Test fixtures for updates/portable.rs: a small payload signed with a throwaway key made only for these tests
(`tauri signer generate`). Only the PUBLIC key is here (test.key.pub, base64 as in plugins.updater.pubkey); the private
key was never committed and was deleted after signing. It is not OpenMind's release key.
