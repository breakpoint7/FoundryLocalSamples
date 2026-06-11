import { FoundryLocalManager } from 'foundry-local-sdk';

// Initialize the Foundry Local SDK
console.log('Initializing Foundry Local SDK...');

// 1 - Every Foundry Local application must create a FoundryLocalManager to interact with the SDK.
const manager = FoundryLocalManager.create({
    appName: 'Hello_World',
    logLevel: 'info'
});
console.log('✓ SDK initialized successfully');

// 2 - Discover available execution providers and their registration status.
const eps = manager.discoverEps();
const maxNameLen = 30;
console.log('\nAvailable execution providers:');
console.log(`  ${'Name'.padEnd(maxNameLen)}  Registered`);
console.log(`  ${'─'.repeat(maxNameLen)}  ──────────`);
for (const ep of eps) {
    console.log(`  ${ep.name.padEnd(maxNameLen)}  ${ep.isRegistered}`);
}

// 3 - Download and register all execution providers with per-EP progress.
// EP packages include dependencies and may be large.
// Download is only required again if a new version of the EP is released.
console.log('\nDownloading execution providers:');
if (eps.length > 0) {
    let currentEp = '';
    await manager.downloadAndRegisterEps((epName, percent) => {
        if (epName !== currentEp) {
            if (currentEp !== '') {
                process.stdout.write('\n');
            }
            currentEp = epName;
        }
        process.stdout.write(`\r  ${epName.padEnd(maxNameLen)}  ${percent.toFixed(1).padStart(5)}%`);
    });
    process.stdout.write('\n');
} else {
    console.log('No execution providers to download.');
}

// Optional List all the available models in the catalog (could also use Foundry Local CLI)
console.log('\nAvailable models:');
const models = await manager.catalog.getModels();
const aliasWidth = 30;
const idWidth = 50;
console.log(`  ${'Alias'.padEnd(aliasWidth)}  ${'Variant ID'.padEnd(idWidth)}  Cached`);
console.log(`  ${'─'.repeat(aliasWidth)}  ${'─'.repeat(idWidth)}  ──────`);

for (const m of models) {
    // Each model can have multiple variants (CPU / GPU / NPU builds)
    for (const v of m.variants) {
        console.log(
            `  ${m.alias.padEnd(aliasWidth)}  ${v.id.padEnd(idWidth)}  ${v.isCached}`
        );
    }
}

// 4 - Get a specific model to work with
const modelAlias = 'phi-3-mini-4k'; // Using an available model from the list above
const model = await manager.catalog.getModel(modelAlias);

// 5 - Download the model
console.log(`\nDownloading model ${modelAlias}...`);
await model.download((progress) => {
    process.stdout.write(`\rDownloading... ${progress.toFixed(2)}%`);
});
console.log('\n✓ Model downloaded');

// 6 - Load the model
console.log(`\nLoading model ${modelAlias}...`);
await model.load();
console.log('✓ Model loaded');

// 7 - Create chat client
console.log('\nCreating chat client...');
const chatClient = model.createChatClient();
console.log('✓ Chat client created');

// 8 - Example chat completion (Do something useful)
console.log('\nTesting chat completion...');
const completion = await chatClient.completeChat([
    { role: 'user', content: 'Why is the sky blue?' }
]);

console.log('\nChat completion result:');
console.log(completion.choices[0]?.message?.content);

// Example streaming completion
console.log('\nTesting streaming completion...');
for await (const chunk of chatClient.completeStreamingChat(
    [{ role: 'user', content: 'Write a short poem about programming.' }]
)) {
    const content = chunk.choices?.[0]?.delta?.content;
    if (content) {
        process.stdout.write(content);
    }
}
console.log('\n');

// 9 - Unload the model
console.log('Unloading model...');
await model.unload();
console.log(`✓ Model unloaded`);