// mcp.js — shared MCP-RAG logic (MS Learn search + Foundry Local chat)
//
// Exports:
//   init({ chatAlias, maxResults, tokenCap, debug }) -> { ask, shutdown, info }
//   ask(question, { force }) -> { mode, hits, stream, timings }
//     force: "auto" (default, uses MCP) | "mcp" | "base" (no MCP search)

import { FoundryLocalManager } from "foundry-local-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const SYSTEM_PROMPT =
    "You are a helpful Microsoft documentation assistant. Answer the user's " +
    "question using the CONTEXT below, which comes from a live search of " +
    "Microsoft Learn. Synthesize a clear, confident answer and cite supporting " +
    "snippets inline as [1], [2], etc. If the context truly doesn't address " +
    "the question, say so plainly in one sentence. Do not apologize for the " +
    "context being incomplete.";

const SMALLTALK_PROMPT =
    "You are a friendly Microsoft documentation assistant. The user has not " +
    "asked a documentation question. Respond briefly and naturally, and invite " +
    "them to ask a Microsoft / Azure question.";

const BASE_PROMPT =
    "You are a helpful assistant. Answer the user's question to the best of " +
    "your ability using only your own knowledge. Be clear and concise. If you " +
    "are not sure, say so plainly.";

// --------------------------------------------------------------------------
// init
// --------------------------------------------------------------------------
export async function init({
    chatAlias  = "phi-4-mini",
    maxResults = 5,
    tokenCap   = 3000,
    debug      = false,
} = {}) {
    // 1. Foundry Local + EPs
    console.log("Initializing Foundry Local...");
    const manager = FoundryLocalManager.create({ appName: "mcpdemo" });

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

    // 2. Chat model
    console.log(`[chat] resolving ${chatAlias}...`);
    const chatModel = await manager.catalog.getModel(chatAlias);
    console.log(`  -> ${chatModel.id}  (cached: ${chatModel.isCached})`);
    if (!chatModel.isCached) {
        console.log("[chat] downloading...");
        await chatModel.download((pct) =>
            process.stdout.write(`\r  ${pct.toFixed(1)}%   `));
        process.stdout.write("\n");
    }
    console.log("[chat] loading into memory...");
    await chatModel.load();

    const chat = chatModel.createChatClient();
    // Phi-4-mini in particular tends to fall into repetition loops at very low
    // temperatures with large contexts. A small bump diversifies sampling
    // without making the answer feel random.
    chat.settings.temperature = 0.5;
    // Defensive cap so a runaway generation can't stream forever. Foundry
    // Local's OpenAI-compatible client may name this differently per build;
    // we set both common spellings and ignore unknown-key errors.
    try { chat.settings.maxTokens  = 800; } catch { /* ignore */ }
    try { chat.settings.max_tokens = 800; } catch { /* ignore */ }

    // 3. MCP client
    const mcpUrl = new URL(
        `https://learn.microsoft.com/api/mcp?maxTokenBudget=${tokenCap}`);
    console.log(`\nConnecting to MCP server: ${mcpUrl.origin}${mcpUrl.pathname}`);
    const mcp = new Client(
        { name: "mcpdemo", version: "0.1.0" },
        { capabilities: {} }
    );
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    await mcp.connect(transport);

    const { tools } = await mcp.listTools();
    const toolNames = tools.map((t) => t.name);
    console.log(`  available tools: ${toolNames.join(", ")}`);
    if (!toolNames.includes("microsoft_docs_search")) {
        throw new Error("microsoft_docs_search tool missing from MCP server");
    }

    // ----------------------------------------------------------------------
    // Internal: search MS Learn via MCP
    // ----------------------------------------------------------------------
    async function searchLearn(query) {
        const res = await mcp.callTool({
            name: "microsoft_docs_search",
            arguments: { query },
        });
        if (debug) {
            console.log("--- raw MCP result ---");
            console.log(JSON.stringify(res, null, 2));
            console.log("----------------------");
        }

        const hits = [];
        const pushAll = (arr) => {
            for (const p of arr ?? []) {
                hits.push({
                    title:   p.title      ?? "(untitled)",
                    url:     p.contentUrl ?? p.url ?? "",
                    content: p.content    ?? p.snippet ?? "",
                });
            }
        };

        if (res.structuredContent?.results) {
            pushAll(res.structuredContent.results);
        } else {
            for (const item of res.content ?? []) {
                if (item.type !== "text") continue;
                try {
                    const parsed = JSON.parse(item.text);
                    if (Array.isArray(parsed))   pushAll(parsed);
                    else if (parsed?.results)    pushAll(parsed.results);
                    else                         pushAll([parsed]);
                } catch {
                    hits.push({ title: "(snippet)", url: "", content: item.text });
                }
            }
        }
        return hits.slice(0, maxResults);
    }

    // ----------------------------------------------------------------------
    // ask
    // ----------------------------------------------------------------------
    async function ask(question, { force = "auto" } = {}) {
        const timings = {};

        // Base mode: skip MCP entirely, just ask the chat model.
        if (force === "base") {
            const messages = [
                { role: "system", content: BASE_PROMPT },
                { role: "user",   content: question },
            ];
            return {
                mode: "base",
                hits: null,
                stream: streamChat(messages, timings),
                timings,
            };
        }

        // Search MS Learn
        const t0 = performance.now();
        const hits = await searchLearn(question);
        timings.searchMs = Math.round(performance.now() - t0);

        let messages;
        if (hits.length === 0) {
            // No hits — fall through to small-talk (unless caller forced "mcp",
            // in which case we still send the empty-context prompt).
            messages = [
                { role: "system", content: force === "mcp" ? SYSTEM_PROMPT : SMALLTALK_PROMPT },
                { role: "user",   content: question },
            ];
            return {
                mode: force === "mcp" ? "mcp" : "smalltalk",
                hits,
                stream: streamChat(messages, timings),
                timings,
            };
        }

        const context = hits.map((h, n) =>
            `[${n + 1}] ${h.title}${h.url ? ` — ${h.url}` : ""}\n${h.content}`
        ).join("\n\n---\n\n");
        timings.contextChars  = context.length;
        timings.contextTokens = Math.round(context.length / 4); // rough rule of thumb

        messages = [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: `CONTEXT:\n${context}\n\nQUESTION: ${question}` },
        ];
        return {
            mode: "mcp",
            hits,
            stream: streamChat(messages, timings),
            timings,
        };
    }

    // Wrap chat stream so we can measure time-to-first-token AND short-circuit
    // small-model repetition loops (same line repeated 3+ times in a row).
    async function* streamChat(messages, timings) {
        const tStart = performance.now();
        const raw = chat.completeStreamingChat(messages);
        let first = true;

        let lineBuf = "";           // accumulates chars of the current line
        let lastLine = "";          // last completed non-trivial line
        let repeatCount = 0;        // how many times lastLine has repeated
        const MIN_LINE = 15;        // ignore tiny lines (headings, bullets)
        const MAX_REPEATS = 3;      // 3 identical lines in a row = stuck

        for await (const chunk of raw) {
            const t = chunk.choices?.[0]?.delta?.content;
            if (!t) continue;
            if (first) {
                timings.ttftMs = Math.round(performance.now() - tStart);
                first = false;
            }

            // Repetition detector — operates on full lines as they complete.
            lineBuf += t;
            let nl;
            while ((nl = lineBuf.indexOf("\n")) !== -1) {
                const line = lineBuf.slice(0, nl).trim();
                lineBuf = lineBuf.slice(nl + 1);
                if (line.length >= MIN_LINE) {
                    if (line === lastLine) {
                        repeatCount++;
                        if (repeatCount >= MAX_REPEATS) {
                            yield "\n\n_[stopped: model started repeating itself]_\n";
                            return;
                        }
                    } else {
                        lastLine = line;
                        repeatCount = 1;
                    }
                }
            }

            yield t;
        }
    }

    async function shutdown() {
        try { await mcp.close(); } catch { /* ignore */ }
        await chatModel.unload();
    }

    return {
        ask,
        shutdown,
        info: {
            chatModel: chatModel.id,
            mcpServer: `${mcpUrl.origin}${mcpUrl.pathname}`,
            maxResults,
            tokenCap,
        },
    };
}
