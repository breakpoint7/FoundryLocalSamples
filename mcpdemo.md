# MCP demo

A small, end-to-end demo of **Retrieval-Augmented Generation via the Model
Context Protocol (MCP)**. Instead of building and embedding a local corpus,
this demo asks a remote MCP server — the public **Microsoft Learn** server at
`https://learn.microsoft.com/api/mcp` — to do the search, and then has a
local [Foundry Local](https://aka.ms/foundry-local) chat model answer using
the returned snippets.

The chat model runs **locally**; the search runs on **Microsoft's servers**
over MCP. No API keys, no local index to build.

> Companion to the local-RAG version — see [ragdemo.md](ragdemo.md) for the
> all-local variant that uses embeddings instead of MCP.

---

## How it works

```
                              ┌────────────────────────────┐
                              │     mcp.js (Node)          │
                              │                            │
  User question ──▶ ask() ──▶ │  ┌──────────────────────┐  │
                              │  │ 1. MCP client        │  │      Streamable HTTP
                              │  │    microsoft_docs_   │──┼─────────────────────▶  https://learn.microsoft.com/api/mcp
                              │  │    search(query)     │  │                              │
                              │  └──────────────────────┘  │                              │
                              │            ▼               │                              │
                              │  ┌──────────────────────┐  │                              │
                              │  │ 2. Build prompt with │◀─┼──── snippets / urls ─────────┘
                              │  │    snippets as       │  │
                              │  │    CONTEXT:          │  │
                              │  └──────────────────────┘  │
                              │            ▼               │
                              │  ┌──────────────────────┐  │
                              │  │ 3. Foundry Local     │  │
                              │  │    chat model        │  │
                              │  │    (streams tokens)  │  │
                              │  └──────────────────────┘  │
                              └────────────────────────────┘
                                          │
                       ┌──────────────────┴───────────────────┐
                       ▼                                      ▼
              ┌────────────────┐                     ┌────────────────┐
              │  mcpdemo.js    │                     │  mcpserver.js  │
              │   (console)    │                     │   (web UI)     │
              └────────────────┘                     └────────────────┘
                                                              │
                                                              ▼
                                                browser at http://localhost:3001
                                                (SSE stream, inlined HTML)
```

Every question follows the same three-step pipeline:

1. **Call the MCP tool** `microsoft_docs_search` with the user's question.
   The MCP server returns up to N passages (default 5), each with a title,
   URL, and a chunk of article text.
2. **Build a prompt** that stuffs those passages into a `CONTEXT:` block in
   front of the user's question, with a system prompt that tells the model to
   cite snippets inline as `[1]`, `[2]`, etc.
3. **Stream the chat model's answer** token-by-token. The UI also shows
   timings (search time, context size, time-to-first-token).

In **compare** mode the UI also runs the question through the chat model with
no MCP search at all — so you can directly see what the model knows on its
own versus what it knows when grounded in live Microsoft docs.

### What's different from the RAG demo?

| | RAG demo (`ragdemo.md`) | MCP demo (this) |
| --- | --- | --- |
| Retrieval | Local cosine similarity over embedded docs | Remote MCP `microsoft_docs_search` |
| Corpus prep | One-time `convertdocs.py` + embedding | None — server does it |
| Network calls per Q | 0 (besides Foundry Local) | 1 MCP call |
| Freshness | Snapshot at index time | Always current MS Learn content |
| Coverage | Whatever you indexed | All of Microsoft Learn |
| First-launch time | Slow (embed every chunk) | Fast (no local index) |

---

## Files

| File | What it is |
| --- | --- |
| `mcp.js` | The reusable AI module. Exports `init({ chatAlias, maxResults, tokenCap, debug })` which boots Foundry Local, loads the chat model, connects to the MS Learn MCP server, and returns `{ ask, shutdown, info }`. The `ask(question, { force })` function does the MCP search, prompt building, and returns a token stream plus timings. `force` can be `"auto"` (default — uses MCP), `"mcp"` (always uses MCP, even when 0 hits), or `"base"` (skip MCP entirely). Also includes a small repetition-loop guard for small models like phi-4-mini. |
| `mcpdemo.js` | A thin console REPL on top of `mcp.js`. Useful for quick testing without the browser. |
| `mcpserver.js` | A **self-contained** Express server on top of `mcp.js`. The entire HTML/CSS/JS for the UI is inlined at the bottom of the file — no `public/` directory, no static middleware. Routes: `GET /` (the page), `GET /info` (model + MCP server info for the header), `GET /ask?q=...&force=...` (Server-Sent Events stream). |
| `package.json` | Declares ESM (`"type": "module"`) and the runtime dependencies (`@modelcontextprotocol/sdk`, `foundry-local-sdk-winml`, `express`). |

The MCP demo does **not** use `docs.json`, `docs.vectors.json`, or
`convertdocs.py` — those are for the local-RAG demo.

---

## Prerequisites

- **Node.js 20+**
- **[Foundry Local](https://aka.ms/foundry-local)** installed, with the
  service running. First run downloads the chat model (~few GB); later runs
  reuse the cache.
- **Internet access** to reach `https://learn.microsoft.com/api/mcp`.
- Windows is the easiest path because the SDK in use here is
  `foundry-local-sdk-winml`, but Foundry Local works on other platforms too.

> **Heads up:** Foundry Local is a single-tenant local service. If you have
> another app already using the same chat model alias (for example the RAG
> demo running at the same time), the second one can fail to load. Close
> other Foundry Local apps before starting this demo — or, since the two
> demos use the same `phi-4-mini` alias, run one at a time.

---

## Install

```powershell
npm install
```

---

## Run the web UI (recommended)

```powershell
npm run mcp
# then open http://localhost:3001
```

On first launch you'll see:

- Foundry Local downloading/registering execution providers
- The chat model loading
- A connection to `https://learn.microsoft.com/api/mcp` and the list of
  available MCP tools (you should see `microsoft_docs_search` among them)
- `Open http://localhost:3001`

In the browser:

- Type a question and press **Ask**. You'll see, in order:
  - The mode badge (**MCP**)
  - `MCP search: N hits in XXX ms`
  - **Articles fed into the prompt** with clickable links
  - The streaming answer with `[1]`, `[2]`, … citations
  - A footer with `search · context size · first-token` timings
- Check **"Compare with base model"** to see two answers side-by-side: one
  grounded in MS Learn, one from the chat model alone with no search.

### Web UI options

```powershell
node mcpserver.js --chat phi-4-mini --maxResults 5 --tokenCap 3000 --port 3001
node mcpserver.js --debug              # also dump the raw MCP responses
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--chat <alias>` | `phi-4-mini` | Foundry Local alias for the chat model. |
| `--maxResults <n>` | `5` | Max snippets to take from the MCP search. |
| `--tokenCap <n>` | `3000` | `maxTokenBudget` passed to the MS Learn MCP server (server-side trim of the snippets it returns). |
| `--port <n>` | `3001` | Port to serve on. |
| `--debug` | off | Console-log the raw MCP tool results (useful for understanding the shape). |

Stop with **Ctrl+C** — the server closes the MCP connection and unloads the
chat model cleanly.

---

## Run the console REPL

Same logic, no browser:

```powershell
npm run mcp:cli
# or with flags:
node mcpdemo.js --chat phi-4-mini --maxResults 5
node mcpdemo.js --debug
```

Type a question and hit Enter. Blank line quits.

---

## Things to try in a demo

- Ask a question about something Microsoft has *recently* documented (e.g. a
  new Azure feature). The base model often answers with stale or invented
  facts; the MCP side cites live MS Learn pages. That contrast is the
  pedagogical point of MCP.
- Watch the **Articles fed into the prompt** list before the answer starts
  streaming — it appears as soon as the MCP search returns, while the model
  is still doing prefill on the large context. This visualizes the "remote
  retrieval, local generation" split.
- Toggle `--debug` and ask one question to see the raw `microsoft_docs_search`
  tool result shape. Good for explaining what MCP tool calls actually look
  like under the hood.
- Notice when the same article shows up two or three times in the hit list.
  That's MCP returning multiple *passages* from the same doc — search-result
  chunks, not whole articles. The chat model usually copes fine with the
  overlap.

---

## Running both demos at once

The two demos live on different ports (`3000` for RAG, `3001` for MCP) and
have completely separate servers, so they can coexist in the browser. Just
remember the Foundry Local single-tenant rule:

- They both default to the same `--chat phi-4-mini`. The model is loaded
  once into the local service, and subsequent app starts attach to the
  already-loaded model fine **as long as the EP setup matches**. If one demo
  crashes on `load_model`, stop the other one first.
- For a side-by-side demo, start the RAG server first (`npm run rag`,
  http://localhost:3000), then the MCP server (`npm run mcp`,
  http://localhost:3001), and switch browser tabs.
