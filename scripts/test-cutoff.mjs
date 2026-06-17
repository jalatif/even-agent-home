import { spawn, spawnSync } from 'child_process'

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  console.log("Starting backend...")
  // We can just rely on the existing backend if it's running, or we can just fetch
  const TOKEN = 'my_super_secret_persistent_token_123';
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${TOKEN}`
  };

  // Ensure oh-my-pi has a session with long text
  const res = await fetch('http://localhost:3456/api/prompt', {
    method: 'POST',
    headers,
    body: JSON.stringify({ provider: 'antigravity', sessionId: 'test-cutoff', text: 'This is a very long text that will wrap multiple times. '.repeat(10) })
  });
  console.log("Prompt started", res.status);
  
  // Wait a bit
  await sleep(2000);
  
  // Fetch console state from the backend (which simulator is pushing to)
  const cons = await fetch('http://localhost:3456/api/console', { headers });
  const logs = await cons.json();
  
  // Find latest state
  let latestState = null;
  for (const log of logs) {
     if (log.text.includes('[AgentHomeTest]')) {
         const json = log.text.split('[AgentHomeTest] ')[1];
         try {
             const data = JSON.parse(json);
             if (data.event === 'state' && data.screen === 'sidebar.messages') {
                 latestState = data;
             }
         } catch(e) {}
     }
  }
  
  console.log("Latest state:", latestState ? latestState.messages.length : 'none');
}

main().catch(console.error);
