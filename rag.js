// rag.js — shared RAG logic over docs.json
//
// Exports:
//   init({ chatAlias, embedAlias, topK, rebuild }) -> { ask, shutdown, info }
//   ask(question) -> { mode, sources, stream }    // stream yields token strings

import { FoundryLocalManager } from "foundry-local-sdk";
import { readFile, writeFile, stat } from "node:fs/promises";

const DOCS_PATH    = "docs.json";
const VECTORS_PATH = "docs.vectors.json";

const SYSTEM_PROMPT =
    "You are a helpful Azure documentation assistant. The user's question is " +
    "answered using the CONTEXT below, which comes from official Azure docs. " +
    "Synthesize a clear, confident answer using the context — even if individual " +
    "snippets are truncated. Cite supporting snippets inline as [1], [2], etc. " +
    "If the context truly doesn't address the question, say so plainly in one " +
    "sentence. Do not apologize for the context being incomplete.";

const SMALLTALK_PROMPT =
    "You are a friendly Azure documentation assistant. If the user has not asked a " +
    "documentation question. Respond briefly and naturally, and invite them to " +
    "ask an Azure-related question.";

const BASE_PROMPT =
    "You are a helpful assistant. Answer the user's question to the best of your " +
    "ability using only your own knowledge. Be clear and concise. If you are not " +
    "sure, say so plainly.";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------
async function fileExists(path) {
    try { await stat(path); return true; } catch { return false; }
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

async function loadModel(manager, alias, label) {
    console.log(`[${label}] resolving ${alias}...`);
    const model = await manager.catalog.getModel(alias);
    console.log(`  -> ${model.id}  (cached: ${model.isCached})`);
    if (!model.isCached) {
        console.log(`[${label}] downloading...`);
        await model.download((pct) =>
            process.stdout.write(`\r  ${pct.toFixed(1)}%   `));
        process.stdout.write("\n");
    }
    console.log(`[${label}] loading into memory...`);
    await model.load();
    return model;
}

// --------------------------------------------------------------------------
// init
// --------------------------------------------------------------------------
export async function init({
    chatAlias  = "phi-4-mini",
    embedAlias = "qwen3-embedding-0.6b",
    topK       = 4,
    rebuild    = false,
} = {}) {
    // 1. Docs
    console.log(`Reading ${DOCS_PATH}...`);
    const docs = JSON.parse(await readFile(DOCS_PATH, "utf-8"));
    console.log(`  ${docs.length} chunks`);

    // 2. Manager + EPs
    const manager = FoundryLocalManager.create({ appName: "ragdemo" });
    const eps = manager.discoverEps();
    if (eps.length > 0) {
        console.log(`Registering ${eps.length} execution provider(s)...`);
        let currentEp = "";
        await manager.downloadAndRegisterEps((epName, pct) => {
            if (epName !== currentEp) {
                if (currentEp !== "") process.stdout.write("\n");
                currentEp = epName;
            }
            process.stdout.write(`\r  ${epName.padEnd(30)} ${pct.toFixed(1).padStart(5)}%`);
        });
        process.stdout.write("\n");
    }

    // 3. Embed model
    const embedModel = await loadModel(manager, embedAlias, "embed");
    const embedClient = embedModel.createEmbeddingClient();

    // 4. Vectors cache
    let vectors;
    if (!rebuild && await fileExists(VECTORS_PATH)) {
        console.log(`Loading cached vectors from ${VECTORS_PATH}...`);
        const cache = JSON.parse(await readFile(VECTORS_PATH, "utf-8"));
        if (cache.model === embedModel.id && cache.vectors.length === docs.length) {
            vectors = cache.vectors;
            console.log(`  ${vectors.length} vectors (dim=${vectors[0].length})`);
        } else {
            console.log("  cache stale (model or doc count changed); rebuilding.");
        }
    }
    if (!vectors) {
        console.log(`Embedding ${docs.length} chunks...`);
        vectors = [];
        const BATCH = 16;
        for (let i = 0; i < docs.length; i += BATCH) {
            const batch = docs.slice(i, i + BATCH).map(d => d.content);
            const resp = await embedClient.generateEmbeddings(batch);
            for (const item of resp.data) vectors.push(item.embedding);
            process.stdout.write(`\r  ${Math.min(i + BATCH, docs.length)}/${docs.length}   `);
        }
        process.stdout.write("\n");
        await writeFile(VECTORS_PATH,
            JSON.stringify({ model: embedModel.id, vectors }));
        console.log(`Saved cache to ${VECTORS_PATH}`);
    }

    // 5. Chat model
    const chatModel = await loadModel(manager, chatAlias, "chat");
    const chat = chatModel.createChatClient();
    chat.settings.temperature = 0.2;

    // ----------------------------------------------------------------------
    // ask
    //   force: "auto" (default) | "rag" (always retrieve) | "base" (skip retrieval)
    // ----------------------------------------------------------------------
    async function ask(question, { force = "auto" } = {}) {
        // Base mode: skip retrieval entirely, just ask the chat model.
        if (force === "base") {
            const messages = [
                { role: "system", content: BASE_PROMPT },
                { role: "user",   content: question },
            ];
            const rawStream = chat.completeStreamingChat(messages);
            async function* tokens() {
                for await (const chunk of rawStream) {
                    const t = chunk.choices?.[0]?.delta?.content;
                    if (t) yield t;
                }
            }
            return { mode: "base", sources: null, stream: tokens(), topScore: 0 };
        }

        // Embed query
        const qResp = await embedClient.generateEmbedding(question);
        const qVec  = qResp.data[0].embedding;

        // Rank
        const scored = vectors.map((v, i) => ({ i, score: cosine(qVec, v) }));
        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, topK);

        // Relevance gate: top chunk should stand out from the pack.
        // "rag" force overrides the gate.
        const top1     = scored[0].score;
        const top10avg = scored.slice(0, 10).reduce((s, x) => s + x.score, 0) / 10;
        const useRag   = force === "rag" || (top1 - top10avg) > 0.05;

        let messages, sources = null;
        if (useRag) {
            sources = top.map((hit, n) => {
                const d = docs[hit.i];
                return {
                    n: n + 1,
                    score: hit.score,
                    title: d.title || "(untitled)",
                    url:   d.url || null,
                    source: d.source || null,
                };
            });
            const context = top.map((hit, n) => {
                const d = docs[hit.i];
                return `[${n + 1}] ${d.title || "(untitled)"} — ${d.url || d.source}\n${d.content}`;
            }).join("\n\n---\n\n");
            messages = [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user",   content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` },
            ];
        } else {
            messages = [
                { role: "system", content: SMALLTALK_PROMPT },
                { role: "user",   content: question },
            ];
        }

        // Wrap chat stream into a simple async generator of token strings
        const rawStream = chat.completeStreamingChat(messages);
        async function* tokens() {
            for await (const chunk of rawStream) {
                const t = chunk.choices?.[0]?.delta?.content;
                if (t) yield t;
            }
        }

        return {
            mode:    useRag ? "rag" : "smalltalk",
            sources,
            stream:  tokens(),
            topScore: top1,
        };
    }

    async function shutdown() {
        await chatModel.unload();
        await embedModel.unload();
    }

    return {
        ask,
        shutdown,
        info: {
            chatModel:  chatModel.id,
            embedModel: embedModel.id,
            topK,
            docs: docs.length,
        },
    };
}
