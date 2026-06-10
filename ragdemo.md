# RAG demo

A small, end-to-end **Retrieval-Augmented Generation** demo that runs entirely
on your machine using [Foundry Local](https://aka.ms/foundry-local). It indexes
a folder of Microsoft Azure documentation pages, embeds them with a local
embedding model, and answers questions in a streaming chat UI — with an
optional side-by-side compare so you can see how the same chat model answers
**with** retrieval versus **without**.

Nothing leaves your machine. No API keys.

---

## How it works

```
            ┌──────────────────────┐
  markdown  │   convertdocs.py     │   one-time prep: chunk + clean
  files     │  (Python, offline)   │   → docs.json
            └──────────────────────┘
                       │
                       ▼
            ┌──────────────────────┐
            │      rag.js          │   embeds chunks once  → docs.vectors.json
            │ (Foundry Local SDK)  │   loads chat + embed models
            └──────────────────────┘
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
    ┌──────────────┐      ┌──────────────┐
    │ ragdemo.js   │      │ ragserver.js │
    │   (CLI)      │      │ (web UI)     │
    └──────────────┘      └──────────────┘
                                 │
                                 ▼
                        public/index.html
                       (browser, SSE stream)
```

At query time, every question follows the same RAG loop:

1. **Embed the question** with the local embedding model.
2. **Score** every doc chunk by cosine similarity to the question vector.
3. **Pick the top K** chunks (default 4).
4. **Build a prompt** that contains those chunks as `CONTEXT:` plus the
   question, and **stream** the chat model's answer token-by-token.

A small **relevance gate** decides whether retrieval is actually useful for a
given question — if the top-scoring chunk doesn't clearly stand out from the
pack, the demo falls back to plain small-talk mode instead of stuffing
irrelevant context into the prompt.

In **compare** mode the UI also runs the same question through the chat model
with **no** retrieved context at all, so you can directly see what the base
model knows on its own versus what it knows when grounded in your docs.

---

## Files

| File | What it is |
| --- | --- |
| `convertdocs.py` | One-time script that reads a list of markdown files (`files.txt`), strips frontmatter / code blocks / Learn-specific directives, chunks each doc into ~1500-character pieces with overlap, and writes `docs.json`. Only needs to be re-run when the source docs change. |
| `docs.json` | The chunked corpus the demo answers from. Each entry has `id`, `source`, `title`, `url`, and `content`. Already provided in this folder (Azure API Management docs). |
| `docs.vectors.json` | Embedding cache — one float vector per chunk in `docs.json`. Created on first run, then reused on every subsequent run. Auto-invalidated if the embedding model id or chunk count changes. Use `--rebuild` to force a fresh build. |
| `rag.js` | The reusable AI module. Exports `init({ chatAlias, embedAlias, topK, rebuild })` which loads the models, builds/loads the vector cache, and returns `{ ask, shutdown, info }`. The `ask(question, { force })` function does embedding, ranking, prompt building, and returns a token stream. `force` can be `"auto"` (default, with relevance gate), `"rag"` (always retrieve), or `"base"` (skip retrieval entirely). |
| `ragdemo.js` | A thin console REPL on top of `rag.js`. Useful for quick testing without the browser. |
| `ragserver.js` | An Express server on top of `rag.js` (paired with `mcpserver.js` for the MCP demo). Serves `public/` and exposes two routes: `GET /info` (model info for the UI header) and `GET /ask?q=...&force=...` (Server-Sent Events stream of tokens + sources). |
| `public/index.html` | Self-contained web UI: vanilla JS + [Pico.css](https://picocss.com/) + [marked](https://marked.js.org/) loaded from CDN. Renders streaming markdown, a mode badge, a sources list with cosine scores, and the compare-with-base-model toggle. No build step. |
| `package.json` | Project manifest — declares ESM (`"type": "module"`) and the runtime dependencies (`foundry-local-sdk-winml`, `express`). |
| `mcpdemo.js` | Unrelated MCP sample that happens to live in this folder. Not part of the RAG demo. |

---

## Prerequisites

- **Node.js 20+**
- **[Foundry Local](https://aka.ms/foundry-local)** installed and the Foundry
  Local service running. The first run will download the chat and embedding
  models (~few GB) — subsequent runs reuse the cache.
- Windows is the easiest path because the SDK in use here is
  `foundry-local-sdk-winml`, but the demo will work on any platform Foundry
  Local supports.

> **Heads up:** Foundry Local is effectively a single-tenant local service.
> Don't run two apps that both load the same model alias at the same time —
> the second one tends to crash. Close other Foundry Local apps before
> starting this demo.

---

## Install

```powershell
npm install
```

---

## Run the web UI (recommended)

```powershell
npm run rag
# then open http://localhost:3000
```

On first launch you'll see:

- Foundry Local downloading/registering execution providers
- The embedding model loading
- 598 chunks being embedded (only once — cached to `docs.vectors.json`)
- The chat model loading
- `Open http://localhost:3000`

In the browser:

- Type a question and press **Ask**. Tokens stream in live, with citation
  numbers `[1]`, `[2]`, … that map to the **Sources** block underneath.
- Check **"Compare with base model"** to see two answers side-by-side: one
  grounded in your docs, one from the chat model alone with no context.

### Web UI options

```powershell
node ragserver.js --chat phi-3-mini-4k --embed qwen3-embedding-0.6b --k 4 --port 3000
node ragserver.js --rebuild              # force re-embed even if cache exists
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--chat <alias>` | `phi-4-mini` | Foundry Local alias for the chat model. |
| `--embed <alias>` | `qwen3-embedding-0.6b` | Alias for the embedding model. |
| `--k <n>` | `4` | How many chunks to retrieve per question. |
| `--port <n>` | `3000` | Port to serve on. |
| `--rebuild` | off | Ignore `docs.vectors.json` and re-embed everything. |

Stop with **Ctrl+C** — the server unloads both models cleanly on shutdown.

---

## Run the console REPL

Same logic, no browser:

```powershell
npm run rag:cli
# or with flags:
node ragdemo.js --chat phi-3-mini-4k --k 4
```

Type a question and hit Enter. Blank line quits.

---

## Re-indexing your own docs (optional)

The included `docs.json` covers a slice of Azure API Management docs. To point
the demo at your own corpus:

1. Build a `files.txt` listing the markdown files you want to include
   (one absolute path per line).
2. Edit `convertdocs.py` to point `REPO_ROOT` and `FILES_LIST` at your source.
3. `python convertdocs.py` → produces a new `docs.json`.
4. Start the demo with `--rebuild` once so the embedding cache is regenerated
   for the new corpus.

---

## Things to try in a demo

- Ask something clearly answered by the docs (e.g. an API Management feature)
  with **Compare** on — the RAG side cites snippets, the base side often
  confidently invents a plausible-but-wrong version.
- Ask a generic question (e.g. *"what is 2+2"*) — the relevance gate kicks in,
  the badge flips to **small talk**, and no docs are stuffed into the prompt.
- Force retrieval on an off-topic question by toggling **Compare** — you'll
  see the RAG side dutifully citing the closest (but unrelated) chunks, which
  is a useful illustration of why the relevance gate exists.
