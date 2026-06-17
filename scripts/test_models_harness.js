import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// This test harness validates that the models in core.js match models_dump.json
// It ensures that we don't accidentally regress to "guessing" models in the future.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_DIR = join(__dirname, '..');
const CORE_JS_PATH = join(ROOT_DIR, 'backend', 'src', 'routes', 'core.js');
const MODELS_DUMP_PATH = join(ROOT_DIR, 'scripts', 'test-artifacts', 'models_dump.json');

function extractDefaultModels(coreJsContent) {
    const match = coreJsContent.match(/const DEFAULT_MODELS = ({[\s\S]*?});/);
    if (!match) throw new Error("Could not find DEFAULT_MODELS definition in core.js");
    
    // Evaluate the object in a sandbox
    return new Function(`return ${match[1]}`)();
}

function runHarnessTest() {
    console.log("Running Harness Test: Validating Model Lists are not guessed...");
    
    let coreJs;
    let dumpJson = [];
    try {
        coreJs = readFileSync(CORE_JS_PATH, 'utf-8');
        const lines = readFileSync(MODELS_DUMP_PATH, 'utf-8').trim().split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                dumpJson.push(...JSON.parse(line));
            } catch (e) {}
        }
    } catch (err) {
        console.error("Failed to read required files:", err.message);
        process.exit(1);
    }

    const defaultModels = extractDefaultModels(coreJs);
    
    let hasErrors = false;

    // Validate claude
    if (defaultModels.claude) {
        const expectedClaude = dumpJson.filter(m => m.id.startsWith('claude-')).map(m => m.id.split('@')[0]);
        const actualClaude = defaultModels.claude;
        const missing = expectedClaude.filter(m => !actualClaude.includes(m));
        const extra = actualClaude.filter(m => !expectedClaude.includes(m));
        
        if (missing.length > 0 || extra.length > 0) {
            console.error("❌ Claude models mismatch!");
            console.error("  Missing:", missing);
            console.error("  Extra:", extra);
            hasErrors = true;
        } else {
            console.log("✅ Claude models validated.");
        }
    }

    // Validate oh-my-pi
    if (defaultModels['oh-my-pi']) {
        const expectedOmp = dumpJson.filter(m => m.provider === 'litellm' || m.provider === 'deepseek' || m.provider === 'opencode-go').map(m => m.id);
        const actualOmp = defaultModels['oh-my-pi'];
        const missing = expectedOmp.filter(m => !actualOmp.includes(m));
        const extra = actualOmp.filter(m => !expectedOmp.includes(m));
        
        if (missing.length > 0 || extra.length > 0) {
            console.error("❌ oh-my-pi models mismatch!");
            console.error("  Missing:", missing);
            console.error("  Extra:", extra);
            hasErrors = true;
        } else {
            console.log("✅ oh-my-pi models validated.");
        }
    }

    // Validate codex
    if (defaultModels.codex) {
        const expectedCodex = dumpJson.filter(m => m.provider === 'openai').map(m => m.id);
        const actualCodex = defaultModels.codex;
        const missing = expectedCodex.filter(m => !actualCodex.includes(m));
        const extra = actualCodex.filter(m => !expectedCodex.includes(m));
        
        if (missing.length > 0 || extra.length > 0) {
            console.error("❌ codex models mismatch!");
            console.error("  Missing:", missing);
            console.error("  Extra:", extra);
            hasErrors = true;
        } else {
            console.log("✅ codex models validated.");
        }
    }

    if (hasErrors) {
        console.error("\n❌ Harness Test Failed! Do not guess models. Always pull exact strings from models_dump.json.");
        process.exit(1);
    } else {
        console.log("\n✅ All Harness Tests Passed. Model lists strictly match ground truth.");
        process.exit(0);
    }
}

runHarnessTest();
