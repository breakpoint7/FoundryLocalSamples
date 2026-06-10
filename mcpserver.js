// mcpserver.js — self-contained web UI for the MCP demo.
// Single file: the HTML/CSS/JS is inlined below so there's no shared public/
// directory and no chance of accidentally serving the RAG page.
//
// Run:
//   node mcpserver.js
//   node mcpserver.js --chat phi-4-mini --maxResults 5 --port 3001
//
// Then open http://localhost:3001

import express from "express";
import { init } from "./mcp.js";

// --------------------------------------------------------------------------
// CLI (same as mcpdemo.js, plus --port)
// --------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name, def) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
}
const chatAlias  = flag("chat", "phi-4-mini");
const maxResults = parseInt(flag("maxResults", "5"), 10);
const tokenCap   = parseInt(flag("tokenCap", "3000"), 10);
const debug      = args.includes("--debug");
const port       = parseInt(flag("port", "3001"), 10);

// --------------------------------------------------------------------------
// Boot once
// --------------------------------------------------------------------------
const { ask, shutdown, info } =
    await init({ chatAlias, maxResults, tokenCap, debug });

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------
const app = express();

// Inline page (no public/, no static middleware).
app.get("/", (_req, res) => {
    res.type("html").send(PAGE);
});

// Model + MCP info for the header.
app.get("/info", (_req, res) => res.json(info));

// SSE: stream the whole pipeline.
//   ?q=...                  the question
//   ?force=auto|mcp|base    (default: auto)
//
// Events emitted:
//   mode    { mode }
//   search  { ms, count }                 (MCP only)
//   hits    [ { title, url, content } ]   (MCP only, when count > 0)
//   prompt  { chars, tokens }             (MCP only, when count > 0)
//   ttft    { ms }                        once, on first token
//   token   "..."                         repeatedly
//   done    {}
//   error   "..."
app.get("/ask", async (req, res) => {
    const q     = (req.query.q ?? "").toString().trim();
    const force = (req.query.force ?? "auto").toString();
    if (!q) return res.status(400).end("missing q");
    if (!["auto", "mcp", "base"].includes(force)) {
        return res.status(400).end("bad force");
    }

    res.set({
        "Content-Type":  "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection":    "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const send = (event, data) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
        const { mode, hits, stream, timings } = await ask(q, { force });
        send("mode", { mode });

        if (hits) {
            send("search", { ms: timings.searchMs, count: hits.length });
            if (hits.length > 0) {
                send("hits", hits);
                send("prompt", {
                    chars:  timings.contextChars,
                    tokens: timings.contextTokens,
                });
            }
        }

        let firstSent = false;
        for await (const token of stream) {
            if (!firstSent) {
                send("ttft", { ms: timings.ttftMs });
                firstSent = true;
            }
            send("token", token);
        }
        send("done", {});
    } catch (err) {
        send("error", err.message ?? String(err));
    } finally {
        res.end();
    }
});

const server = app.listen(port, () => {
    console.log(`\nReady. Chat=${info.chatModel}  MCP=${info.mcpServer}`);
    console.log(`Open http://localhost:${port}\n`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        console.log(`\n${sig} received, shutting down...`);
        server.close();
        await shutdown();
        process.exit(0);
    });
}

// --------------------------------------------------------------------------
// Inline UI
// --------------------------------------------------------------------------
const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>MCP demo — Microsoft Learn</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <style>
        :root { --pico-form-element-spacing-vertical: 0.5rem; }
        main.container { max-width: 920px; padding-top: 2rem; }
        header h1 { margin-bottom: 0.25rem; }
        .tagline { color: var(--pico-muted-color); font-size: 0.9rem; margin: 0 0 0.5rem; }
        .tagline strong { color: #4d9aff; }
        .models { font-size: 0.8rem; color: var(--pico-muted-color); margin-bottom: 1.5rem; }
        .models code { font-size: 0.8rem; padding: 0.1rem 0.35rem; }

        #log { display: flex; flex-direction: column; gap: 1.25rem; margin-bottom: 1.5rem; }

        .turn { border: 1px solid var(--pico-muted-border-color);
                border-radius: var(--pico-border-radius);
                padding: 1rem 1.25rem; background: var(--pico-card-background-color); }
        .turn .q { font-weight: 600; margin-bottom: 0.5rem; }

        .badge { display: inline-block; font-size: 0.7rem; font-weight: 600;
                 padding: 0.1rem 0.5rem; border-radius: 999px; margin-right: 0.4rem;
                 vertical-align: middle; letter-spacing: 0.04em; text-transform: uppercase; }
        .badge.mcp       { background: #1f6feb; color: #fff; }
        .badge.smalltalk { background: #777;   color: #fff; }
        .badge.base      { background: #4a5a8a; color: #fff; }
        .badge.error     { background: #b53939; color: #fff; }

        .status { font-size: 0.85rem; color: var(--pico-muted-color);
                  margin: 0.25rem 0 0.75rem; font-family: var(--pico-font-family-monospace); }

        .hits { font-size: 0.85rem; margin: 0.25rem 0 0.75rem;
                border-left: 3px solid #1f6feb; padding: 0.25rem 0 0.25rem 0.75rem; }
        .hits .hits-label { font-weight: 600; color: var(--pico-muted-color);
                            text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em;
                            display: block; margin-bottom: 0.35rem; }
        .hits ol { margin: 0; padding-left: 1.25rem; }
        .hits li { margin: 0.15rem 0; }

        .answer { line-height: 1.55; margin-top: 0.5rem; }
        .answer p:first-child { margin-top: 0.25rem; }
        .answer p:last-child  { margin-bottom: 0.25rem; }
        .answer pre { padding: 0.75rem; font-size: 0.85rem; overflow-x: auto; }

        .meta { font-size: 0.75rem; color: var(--pico-muted-color);
                margin-top: 0.75rem; font-family: var(--pico-font-family-monospace); }

        .cursor::after { content: "▍"; animation: blink 1s steps(2) infinite; color: var(--pico-primary); }
        @keyframes blink { 50% { opacity: 0; } }

        form#ask { display: flex; gap: 0.5rem; }
        form#ask input { flex: 1; margin-bottom: 0; }
        form#ask button { margin-bottom: 0; width: auto; }

        .compare-toggle { font-size: 0.85rem; color: var(--pico-muted-color);
                          margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem; }
        .compare-toggle input { margin: 0; }

        .panes { display: grid; grid-template-columns: 1fr; gap: 1rem; }
        .panes.compare { grid-template-columns: 1fr 1fr; }
        .pane h4 { margin: 0 0 0.5rem; font-size: 0.8rem; text-transform: uppercase;
                   letter-spacing: 0.05em; color: var(--pico-muted-color); }
        @media (max-width: 720px) {
            .panes.compare { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
<main class="container">
    <header>
        <h1>MCP demo</h1>
        <p class="tagline">
            Live <strong>Microsoft Learn</strong> search via
            <strong>Model Context Protocol</strong>, answered by a local Foundry Local chat model.
        </p>
        <div class="models" id="models">loading…</div>
    </header>

    <div id="log"></div>

    <form id="ask" autocomplete="off">
        <input id="q" type="text" placeholder="Ask a question…" autofocus required>
        <button type="submit" id="submit">Ask</button>
    </form>
    <label class="compare-toggle">
        <input type="checkbox" id="compare">
        Compare with base model (run side-by-side, no MCP search)
    </label>
</main>

<script>
const logEl     = document.getElementById("log");
const formEl    = document.getElementById("ask");
const inputEl   = document.getElementById("q");
const submitEl  = document.getElementById("submit");
const modelsEl  = document.getElementById("models");
const compareEl = document.getElementById("compare");

fetch("/info").then(r => r.json()).then(info => {
    modelsEl.innerHTML =
        \`chat <code>\${info.chatModel}</code> · \` +
        \`mcp <code>\${info.mcpServer}</code> · \` +
        \`max-results <code>\${info.maxResults}</code> · \` +
        \`token-cap <code>\${info.tokenCap}</code>\`;
});

let inflight = 0;

formEl.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = inputEl.value.trim();
    if (!q || inflight > 0) return;
    inputEl.value = "";
    runTurn(q, compareEl.checked);
});

function runTurn(question, compare) {
    const turn = document.createElement("article");
    turn.className = "turn";
    turn.innerHTML = \`
        <div class="q"></div>
        <div class="panes\${compare ? " compare" : ""}"></div>
    \`;
    turn.querySelector(".q").textContent = question;
    logEl.appendChild(turn);
    turn.scrollIntoView({ behavior: "smooth", block: "end" });

    const panesEl = turn.querySelector(".panes");

    if (compare) {
        startStream(question, "mcp",  makePane(panesEl, "With MCP (live MS Learn search)"));
        startStream(question, "base", makePane(panesEl, "Base model (no search)"));
    } else {
        startStream(question, "auto", makePane(panesEl, null));
    }
}

function makePane(parent, heading) {
    const pane = document.createElement("div");
    pane.className = "pane";
    pane.innerHTML = \`
        \${heading ? \`<h4>\${escapeHtml(heading)}</h4>\` : ""}
        <div class="badge-row"></div>
        <div class="status"></div>
        <div class="hits"   hidden></div>
        <div class="answer cursor"></div>
        <div class="meta"></div>
    \`;
    parent.appendChild(pane);
    return pane;
}

function startStream(question, force, pane) {
    const badgeRow = pane.querySelector(".badge-row");
    const statusEl = pane.querySelector(".status");
    const hitsEl   = pane.querySelector(".hits");
    const answerEl = pane.querySelector(".answer");
    const metaEl   = pane.querySelector(".meta");

    let buffer = "";
    const metaBits = [];

    inflight++;
    submitEl.setAttribute("aria-busy", "true");
    submitEl.disabled = true;

    if (force === "base") {
        statusEl.textContent = "skipping MCP search — base model only";
    } else {
        statusEl.textContent = "🔎 searching Microsoft Learn…";
    }

    const url = \`/ask?q=\${encodeURIComponent(question)}&force=\${force}\`;
    const es  = new EventSource(url);

    es.addEventListener("mode", (e) => {
        const { mode } = JSON.parse(e.data);
        const badge = document.createElement("span");
        badge.className = \`badge \${mode}\`;
        badge.textContent = mode === "mcp"  ? "MCP"
                          : mode === "base" ? "base model"
                          :                   "small talk";
        badgeRow.appendChild(badge);
    });

    es.addEventListener("search", (e) => {
        const { ms, count } = JSON.parse(e.data);
        statusEl.textContent = \`MCP search: \${count} hits in \${ms} ms\`;
        metaBits.push(\`search \${ms}ms\`);
    });

    es.addEventListener("hits", (e) => {
        const hits = JSON.parse(e.data);
        hitsEl.hidden = false;
        hitsEl.innerHTML = \`
            <span class="hits-label">Articles fed into the prompt</span>
            <ol>\${hits.map(h => \`
                <li>\${h.url
                    ? \`<a href="\${h.url}" target="_blank" rel="noopener">\${escapeHtml(h.title)}</a>\`
                    : escapeHtml(h.title)}</li>\`).join("")}
            </ol>
        \`;
    });

    es.addEventListener("prompt", (e) => {
        const { chars, tokens } = JSON.parse(e.data);
        metaBits.push(\`context \${chars.toLocaleString()} chars (~\${tokens.toLocaleString()} tok)\`);
        metaEl.textContent = metaBits.join("  ·  ");
    });

    es.addEventListener("ttft", (e) => {
        const { ms } = JSON.parse(e.data);
        metaBits.push(\`first token \${ms}ms\`);
        metaEl.textContent = metaBits.join("  ·  ");
    });

    es.addEventListener("token", (e) => {
        buffer += JSON.parse(e.data);
        answerEl.innerHTML = marked.parse(buffer);
        answerEl.classList.add("cursor");
    });

    es.addEventListener("error", (e) => {
        const msg = e.data ? JSON.parse(e.data) : "connection lost";
        answerEl.innerHTML += \`<p><span class="badge error">error</span> \${escapeHtml(msg)}</p>\`;
        finish();
    });

    es.addEventListener("done", finish);

    function finish() {
        answerEl.classList.remove("cursor");
        es.close();
        inflight = Math.max(0, inflight - 1);
        if (inflight === 0) {
            submitEl.removeAttribute("aria-busy");
            submitEl.disabled = false;
            inputEl.focus();
        }
    }
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
}
</script>
</body>
</html>
`;
