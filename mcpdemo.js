// mcpdemo.js — console REPL on top of mcp.js
//
// Run:
//   node mcpdemo.js
//   node mcpdemo.js --chat phi-4-mini --maxResults 5
//   node mcpdemo.js --debug

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { init } from "./mcp.js";

// --------------------------------------------------------------------------
// CLI
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

// --------------------------------------------------------------------------
// Boot + REPL
// --------------------------------------------------------------------------
const { ask, shutdown, info } =
    await init({ chatAlias, maxResults, tokenCap, debug });

const rl = createInterface({ input: stdin, output: stdout });
console.log(
    `\nReady. Chat=${info.chatModel}  MCP=${info.mcpServer}` +
    `\nType a question (blank line to quit).\n`);

while (true) {
    const q = (await rl.question("> ")).trim();
    if (!q) break;
    try {
        console.log("Searching Microsoft Learn...");
        const { mode, hits, stream, timings } = await ask(q);

        if (hits && hits.length > 0) {
            console.log(`  ${hits.length} hits in ${timings.searchMs}ms`);
            console.log(`\nMCP search hit on these articles:`);
            hits.forEach((h, n) => {
                console.log(`  [${n + 1}] ${h.title}`);
                if (h.url) console.log(`        ${h.url}`);
            });
            console.log(
                `\nSending ${timings.contextChars.toLocaleString()} chars ` +
                `(~${timings.contextTokens.toLocaleString()} tokens) of context.`);
            console.log("Model is reading the context and building a response...");
        } else {
            console.log(`  0 hits in ${timings.searchMs}ms (mode=${mode})`);
        }

        console.log("\nAnswer:\n");
        let firstShown = false;
        for await (const token of stream) {
            if (!firstShown) {
                process.stdout.write(`(time-to-first-token: ${timings.ttftMs}ms)\n\n`);
                firstShown = true;
            }
            process.stdout.write(token);
        }

        if (hits && hits.length > 0) {
            process.stdout.write("\n\nSources:\n");
            hits.forEach((h, n) => {
                console.log(`  [${n + 1}] ${h.title}`);
                if (h.url) console.log(`        ${h.url}`);
            });
        }
    } catch (err) {
        console.error("Error:", err.message ?? err);
    }
    console.log();
}

rl.close();
await shutdown();
console.log("Done.");
