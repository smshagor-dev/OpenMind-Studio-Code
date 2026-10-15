# Agent chat, history, attachments and acceleration

The Agent sidebar opens at least 480px wide (bounded by the window) and preserves the existing animations. Conversations, documents, images and task snapshots are saved locally in a separate SQLite database beside the engine logs, under `agent/history.sqlite`. The history button opens saved conversations; delete removes their DB records. Restoring a conversation requires its original workspace and never automatically resumes interrupted tasks. New chat resets the model context and keeps the previous conversation in history.

Attach up to six files using **Attach files** or drag and drop. Supported inputs: UTF-8 source/text, text PDFs (50 pages maximum), DOCX, PNG/JPEG/WebP. Each source file is limited to 10 MB; extracted text to 100 KB per attachment. Images are resized to 1280px and encoded as JPEG up to about 500 KB. Scanned PDFs require page images. DOCX macros and embedded programs never execute. File contents and web results are untrusted input; normal workspace, command and approval guards still apply.

## Optional engines

The bundled coding editions are text models. Image understanding and generation require additional running local engines; configuring a URL does not install or download those engines. There is no cloud fallback. Open Agent settings, enter the appropriate URL, use **Check connections**, then Apply. An empty URL disables that capability.

| Capability | Compatible server | Example base URL | Requirement |
| --- | --- | --- | --- |
| Web search | SearXNG | `https://your-search.example` | Enable `json` in search formats; `/search` API accepts `q` and `format=json` |
| Image reading | OpenAI-compatible local vision server | `http://127.0.0.1:8081/v1` | Load a vision-capable model; expose `/models` and multimodal `/chat/completions` |
| Image generation | AUTOMATIC1111-compatible local server | `http://127.0.0.1:7860` | Start with `--api`, load a checkpoint; expose `/sdapi/v1/txt2img` |

Connection checks query server metadata; they do not prove vision inference, image generation or GPU execution works. Use an image attachment and a generation request to verify those with your installed engines. Generated 512px PNGs appear in chat with a download link. Images and documents remain local; web search sends the generated query to the configured SearXNG server. Review queries in Ask mode before approving. Never put credentials into these URLs.

The agent receives search/generation tools only when configured and decides whether the user's request requires them. Ask and Accept Edits require approval for those tools. Auto allows them; Plan exposes search but excludes image generation. Stop cancels local requests; an external image server may finish an already accepted job independently. Generated images are not automatically written over project files.

## GPU and limits

**Use GPU acceleration** passes `--gpu-layers auto` to the local coding runtime; disabling it uses `--gpu-layers 0`. A change applies to the next task and restarts the engine if necessary. The header reports the engine's offloaded layer count when available and detected VRAM capacity, not live VRAM consumption. Driver/runtime compatibility and available memory determine actual offload. Context and output settings cannot exceed the downloaded model's limits; larger contexts also consume memory. Vision and image engines control their own GPU use and share the same VRAM budget.

History snapshots are debounced 350ms while streaming and flushed at turn completion or before switching chats. An abrupt process or power loss may lose the last unsaved fragment. The DB caps each record at 1 MB, each conversation at 32 MB and 2000 records; large conversations should be split with New Chat. Images are stored as separate records, including queued-task attachments. History save failures are reported. Back up the SQLite file together with its WAL while the app is closed. History may contain source code and sensitive attachments; it is stored under the app's local data directory and is not encrypted by this feature.

References: [SearXNG API](https://docs.searxng.org/dev/search_api.html), [AUTOMATIC1111 API](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/API).
