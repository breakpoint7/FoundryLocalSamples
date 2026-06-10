# Foundry Local AI demos

Two small Node.js demos showing how to ground a **local** chat model — run via
[Foundry Local](https://aka.ms/foundry-local) — with **external knowledge**,
using two different retrieval strategies.

Both demos ship with a console REPL and a polished web UI (Server-Sent
Events streaming, side-by-side "compare with base model" mode).

## The two demos

| Demo | Retrieval | What it shows |
| --- | --- | --- |
| **[RAG demo](ragdemo.md)** | Local embeddings + cosine search over an indexed corpus (`docs.json`) | Classic Retrieval-Augmented Generation: embed once, search locally, answer with citations. Everything runs offline. |
| **[MCP demo](mcpdemo.md)** | Remote **Microsoft Learn** search via the **Model Context Protocol** | Same RAG pattern, but the retrieval step is a live MCP tool call to `learn.microsoft.com`. No local index, always-fresh content. |

In both demos a small local model (default `phi-4-mini`) does the generation;
only the *source of context* differs.

## Quick start

```powershell
npm install

npm run rag      # RAG web UI on http://localhost:3000
npm run mcp      # MCP web UI on http://localhost:3001

npm run rag:cli  # RAG console REPL
npm run mcp:cli  # MCP console REPL
```

See [ragdemo.md](ragdemo.md) and [mcpdemo.md](mcpdemo.md) for prerequisites,
flags, architecture diagrams, and demo tips.
