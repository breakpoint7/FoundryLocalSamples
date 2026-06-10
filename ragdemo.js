// ragdemo.js — console REPL on top of rag.js
//
// Run:
//   node ragdemo.js
//   node ragdemo.js --chat phi-3-mini-4k --embed qwen3-embedding-0.6b --k 4
//   node ragdemo.js --rebuild

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { init } from "./rag.js";

// --------------------------------------------------------------------------
// CLI args
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

// --------------------------------------------------------------------------
// Boot + REPL
// --------------------------------------------------------------------------
const { ask, shutdown, info } =
    await init({ chatAlias, embedAlias, topK, rebuild });

const rl = createInterface({ input: stdin, output: stdout });
console.log(
    `\nReady. Chat=${info.chatModel}  Embed=${info.embedModel}  TopK=${info.topK}` +
    `\nType a question (blank line to quit).\n`);

while (true) {
    const q = (await rl.question("> ")).trim();
    if (!q) break;
    try {
        const { mode, sources, stream, topScore } = await ask(q);
        if (mode === "rag") console.log("Using RAG...");
        else console.log(`(no relevant docs — top score ${topScore.toFixed(3)})`);

        console.log("\nAnswer:\n");
        for await (const token of stream) process.stdout.write(token);

        if (sources) {
            process.stdout.write("\n\nSources:\n");
            for (const s of sources) {
                console.log(`  [${s.n}] (${s.score.toFixed(3)}) ${s.title}`);
                if (s.url) console.log(`        ${s.url}`);
            }
        }
    } catch (err) {
        console.error("Error:", err.message ?? err);
    }
    console.log();
}

rl.close();
await shutdown();
console.log("Done.");
