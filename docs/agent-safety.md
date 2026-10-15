# Agent mutation safety

Agent file tools resolve targets inside the current project, prepare a preview, and recheck paths and disk state after approval. Writes use exclusively created random temporary files and preserve existing permissions, encoding and line endings. Folder deletions check descendants and refuse links and Git internals.

Before a write, deletion or Undo, every editor window answers a live document-state request, including windows whose agent panel has never been opened. Dirty target files or dirty descendants block the change. The originating window must still have a project containing the target. An unresponsive window fails the operation closed. These checks protect editor buffers; approved shell commands still run with the user's operating-system permissions and are not a sandbox.

Undo compares the expected result of the agent's change with the current file before restoring anything. Later disk changes and dirty editor buffers are conflicts, not permission to overwrite. Failed restorations remain in history; the response reports whether more Undo history exists. Folder/large-file deletions without a byte backup must be restored from the Recycle Bin.

The shared local model engine has one lease for a complete turn. A competing turn, model deletion or manual engine stop is refused while it is leased. App shutdown still cancels all turns and stops the engine. New Chat cancels and waits for the worker before resetting its conversation.

Unix commands run in their own process group, terminated on completion, Stop or timeout. Windows commands require a Job Object. Output shutdown is bounded. Portable update responses have a 512 MiB compressed-size limit, enforced with or without Content-Length before signature verification and extraction.
