// ragserver.js — thin web UI for the RAG demo
//
// Run:
//   node ragserver.js
//   node ragserver.js --chat phi-4-mini --embed qwen3-embedding-0.6b --k 4
//
// Then open http://localhost:3000

import express from "express";
import { init } from "./rag.js";

// --------------------------------------------------------------------------
// CLI args (same as ragdemo.js)
// --------------------------------------------------------------------------
const args = process.argv.slice(2);
function flag(name, def) {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
}
const chatAlias  = flag("chat",  "phi-4-mini");
const embedAlias = flag("embed", "qwen3-embedding-0.6b");
const topK       = parseInt(flag("k", "4"), 10);
const rebuild    = args.includes("--rebuild");
const port       = parseInt(flag("port", "3000"), 10);

// --------------------------------------------------------------------------
// Boot models once at startup
// --------------------------------------------------------------------------
const { ask, shutdown, info } =
    await init({ chatAlias, embedAlias, topK, rebuild });

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------
const app = express();
app.use(express.static("public"));

// Expose model info so the UI can show a header badge.
app.get("/info", (_req, res) => res.json(info));

// SSE: stream tokens + a final sources event.
//   ?q=...            the question
//   ?force=auto|rag|base   (default: auto)
app.get("/ask", async (req, res) => {
    const q     = (req.query.q ?? "").toString().trim();
    const force = (req.query.force ?? "auto").toString();
    if (!q) return res.status(400).end("missing q");
    if (!["auto", "rag", "base"].includes(force)) {
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
        const { mode, sources, stream, topScore } = await ask(q, { force });
        send("mode", { mode, topScore });
        for await (const token of stream) send("token", token);
        if (sources) send("sources", sources);
        send("done", {});
    } catch (err) {
        send("error", err.message ?? String(err));
    } finally {
        res.end();
    }
});

const server = app.listen(port, () => {
    console.log(`\nReady. Chat=${info.chatModel}  Embed=${info.embedModel}  TopK=${info.topK}`);
    console.log(`Open http://localhost:${port}\n`);
});

// Graceful shutdown so models are released cleanly.
for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, async () => {
        console.log(`\n${sig} received, shutting down...`);
        server.close();
        await shutdown();
        process.exit(0);
    });
}
