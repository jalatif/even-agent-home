# Agent Home — Custom Agents Guide

This file was created for you by Agent Home on first start. You can keep it,
edit it, or delete it — Agent Home will **not** overwrite it once it exists.

Agent Home comes with built-in agents (`claude`, `codex`, `pi`, `opencode`,
`antigravity`, `oh-my-pi`, `hermes`, `openclaw`). You can add **your own**
agents by editing one file:

```
~/.agent-home/agents.yaml
```

(That file is also created for you on first start, with commented-out examples.)

There are **three ways** to add an agent, depending on what you're connecting
to. Pick the **first one that fits** — each is more powerful than the one
before, and a bit more work.

---

## Which tier should I use?

| Use this if… | Tier | Effort |
|---|---|---|
| You have an **OpenAI-compatible endpoint** (Ollama, LM Studio, vLLM, a proxy, real OpenAI…) | **Tier 1 — `gateway`** | 1 minute |
| You have a **command-line tool** you run per question that **streams JSON lines** with token deltas | **Tier 2 — `cli`** | ~10 minutes |
| Your tool is **weird** — it runs a background server, needs polling, stores sessions in a database, or does anything a config file can't describe | **Tier 3 — `module`** | write a small script |

**Start with Tier 1.** Most people only ever need it.

After editing `agents.yaml`, **restart the backend**. Your agent then appears in
the Agent Home agent list and works just like a built-in.

> All custom agents are **additions** — they never change or break the built-in
> ones. If your config has an error, the bad entry is skipped (with a logged
> message) and everything else keeps working.

---

## Tier 1 — `type: gateway` (an OpenAI-compatible server)

Use this for anything that speaks OpenAI's API:
`POST /v1/chat/completions` with `{model, messages, stream:true}` and SSE deltas.

### Minimum example (Ollama running locally)

```yaml
agents:
  - name: ollama-local
    type: gateway
    gatewayUrl: http://127.0.0.1:11434
    model: llama3.1
```

That's it. Fill in `name`, `gatewayUrl`, and `model`.

### Full example (a remote server that needs an API key)

```yaml
agents:
  - name: my-llm-proxy
    type: gateway
    gatewayUrl: https://my-llm-proxy.example.com
    model: gpt-4o
    models: [gpt-4o, gpt-4o-mini]   # shown in the model picker
    apiKeyEnv: MY_PROXY_KEY         # read the key from this env var (recommended)
    # apiKey: "sk-..."              # …or hardcode it (less secure; avoid in shared files)
```

### Fields

| Field | Required? | What it does |
|---|---|---|
| `name` | **yes** | A unique id, lowercase + dashes only (`ollama-local`). Becomes the agent's id in the UI. |
| `type` | **yes** | Must be `gateway`. |
| `gatewayUrl` | **yes** | The base URL. Agent Home appends `/v1/chat/completions`. |
| `model` | **yes** | The default model id to send. |
| `models` | no | List of models for the picker. Defaults to `[model]`. |
| `apiKey` | no | A static key sent as `Authorization: Bearer <key>`. Leave empty for no-auth local servers. |
| `apiKeyEnv` | no | Name of an **env var** to read the key from. Preferred over `apiKey` (keeps secrets out of this file). If both are set, `apiKeyEnv` wins. |
| `bin` | no | Leave it out (= always available) or set a command name; the agent shows as available only if `command -v <bin>` finds it. |

---

## Tier 2 — `type: cli` (a command-line tool that streams JSON)

Use this when you have a CLI you run once per question, and it prints **one JSON
object per line** describing what it's doing (tokens, tool calls, completion).

This tier needs a little more info, because every CLI names its fields
differently. You tell Agent Home **how to run your CLI** and **which JSON fields
mean what**.

> **How do I know my CLI's JSON shape?** Run your tool with its "JSON mode" flag
> (often `--json` or `--mode json`) on a simple prompt and look at one line of
> output. If you see something like `{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}`,
> that's exactly what the example below maps. If your tool prints
> `{"type":"delta","text":"Hello"}`, adapt the `events.textDelta` paths to match.

### Example (a `pi`/`oh-my-pi`-style CLI)

```yaml
agents:
  - name: my-pi-clone
    type: cli
    bin: pi                                   # the command to run
    args: ["-p", "--mode", "json", "--provider", "litellm", "{{text}}"]
    sessionFlag: ["--session", "{{sessionId}}"]   # added when resuming a session
    model: llama3.1
    models: [llama3.1, qwen2.5]
    thinkingFlag: ["--thinking", "{{thinking}}"]  # added when the user picks a thinking level
    sessionsDir: "~/.pi/agent/sessions"       # where transcripts live (for listing/history)
    cwdEncoder: omp-compat                    # how a cwd maps to a session subdir (omp/pi family)

    events:
      # Where the session id appears in the stream:
      sessionId: "session.id"

      # How to pull token deltas out of an event:
      textDelta:
        type: "message_update"                       # the outer event type
        nestedType: "assistantMessageEvent.type"     # inner field that equals "text_delta"
        value: "assistantMessageEvent.delta"         # the actual text to emit

      thinkingAsText: true                     # also emit "thinking" deltas as normal text
      resultMarkers: [turn_end, agent_end]     # event types that mean "done"
```

### Placeholders you can use in `args` / `sessionFlag` / `thinkingFlag`

| Placeholder | Replaced with |
|---|---|
| `{{text}}` | The user's prompt text. |
| `{{sessionId}}` | The session id to resume (empty for a new session). |
| `{{model}}` | The selected model id. |
| `{{thinking}}` | The selected thinking level (e.g. `medium`), or empty. |
| `{{yolo}}` | `1` when auto-approve/yolo is on, else `0`. |

A flag array is only added when its placeholder resolves to a non-empty value
(so `sessionFlag` isn't added on the first message of a brand-new session).

### Fields

| Field | Required? | What it does |
|---|---|---|
| `name` | **yes** | Unique id, lowercase + dashes. |
| `type` | **yes** | Must be `cli`. |
| `bin` | **yes** | The command to run. Must be on your `PATH` (or an absolute path). |
| `args` | **yes** | Arg template with `{{placeholders}}`. |
| `events` | **yes** | The event-schema map (see below). |
| `model` | **yes** | Default model id. |
| `models` | no | Picker list. Defaults to `[model]`. |
| `sessionFlag` | no | Args added when resuming a session. |
| `thinkingFlag` | no | Args added when a thinking level is chosen. |
| `sessionsDir` | no | Transcript directory, for listing sessions and reading history. |
| `cwdEncoder` | no | `omp-compat` for the omp/pi session-dir naming; omit otherwise. |
| `env` | no | Extra env vars (a map) merged into the subprocess. |

### The `events` map

This is what makes Tier 2 declarative. It maps your CLI's JSON vocabulary onto
the events Agent Home understands.

| Key | Meaning |
|---|---|
| `sessionId` | JSON path to the session id (e.g. `session.id`). |
| `textDelta.type` | The outer event type that carries a token (e.g. `message_update`). |
| `textDelta.value` | JSON path to the delta string inside that event (e.g. `assistantMessageEvent.delta`). |
| `textDelta.nestedType` | Optional inner `.type` to match (e.g. `assistantMessageEvent.type` == `text_delta`). |
| `thinkingAsText` | If `true`, "thinking" deltas are also shown as normal text. |
| `resultMarkers` | A list of event types that signal the answer is complete (e.g. `[turn_end, agent_end]`). |
| `toolStart` / `toolEnd` | Optional markers for tool-call boundaries (so the UI can show "running a tool"). |

---

## Tier 3 — `type: module` (write a small script)

Use this only if your tool **can't be described by Tier 1 or 2**. Examples:

- It runs a **background server** you have to start and then send requests to.
- It only reveals results by **polling** a command on a timer.
- Sessions are stored in a **database** (e.g. SQLite) you have to query.
- It **doesn't stream** — it dumps the whole answer at the end.
- It needs **custom parsing** (proprietary markup, multi-step logic).

For these, you write a small JavaScript file that implements Agent Home's agent
interface, and point your config at it.

### Step 1 — point your config at a script

```yaml
agents:
  - name: my-weird-agent
    type: module
    module: /home/me/my-agent-provider.js   # absolute path to your script
    options:                                 # anything you want, passed into your script
      bin: mycli
      pollMs: 2000
```

### Step 2 — write the script

Your script exports a single function `createProvider(emit, options)` that
returns an object with the methods Agent Home calls. Here's a complete, minimal,
copy-pasteable template:

```js
// /home/me/my-agent-provider.js
// A custom Agent Home provider. Required exports: createProvider(emit, options).

export function createProvider(emit, options) {
  const opt = options || {};
  const sessions = new Map();   // sessionId -> your session state

  // Called when the user sends a message. Stream tokens via emit(), then a result.
  async function prompt(sessionId, text, cwd, model, thinking, yolo) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { id: sessionId, busy: false, text: "" };
      sessions.set(sessionId, session);
    }
    if (session.busy) {
      throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
    }
    session.busy = true;

    emit(sessionId, { type: "user_prompt", text });
    emit(sessionId, { type: "status", state: "busy" });

    try {
      // === YOUR LOGIC HERE ===
      // Talk to your tool however it needs (spawn it, HTTP it, poll it…).
      // For each chunk of text you produce, emit it:
      //
      //   emit(sessionId, { type: "text_delta", text: chunk });
      //
      const answer = "Hello from my custom agent!";   // <-- replace with real output

      emit(sessionId, { type: "result", success: true, text: answer, provider: "my-weird-agent" });
      return { sessionId, provider: "my-weird-agent" };
    } catch (err) {
      emit(sessionId, { type: "result", success: false, text: String(err.message || err), provider: "my-weird-agent" });
      throw err;
    } finally {
      session.busy = false;
    }
  }

  // Recent sessions for this agent. Return [] if you don't track any.
  function listSessions(limit) {
    return Array.from(sessions.values())
      .slice(0, limit || 10)
      .map(s => ({
        id: s.id,
        title: (s.text || "").slice(0, 64),
        timestamp: new Date().toISOString(),
        cwd: "",
        provider: "my-weird-agent",
        status: s.busy ? "busy" : null,
      }));
  }

  // Prior messages in a session, newest at the end. Return [] if none.
  function getHistory(sessionId, limit) {
    return [];   // implement if you keep history
  }

  // Is a session currently working? Return { state: "busy" | "idle", provider }.
  function getStatus(sessionId) {
    const s = sessions.get(sessionId);
    return { state: s?.busy ? "busy" : "idle", provider: "my-weird-agent" };
  }

  // Stop the current generation (abort the spawn/fetch/poll).
  function interrupt(sessionId) {
    const s = sessions.get(sessionId);
    if (s) s.busy = false;
  }

  // Optional but recommended: clean up on backend shutdown.
  function dispose() {
    sessions.clear();
  }

  // These two can be no-ops unless your agent asks permission/questions.
  function respondPermission(_sessionId, _decision) {}
  function respondQuestion(_sessionId, _answer) {}

  return {
    prompt,
    listSessions,
    getHistory,
    getStatus,
    interrupt,
    respondPermission,
    respondQuestion,
    dispose,
  };
}
```

### The contract your script must satisfy

| Method | Must do |
|---|---|
| `prompt(sessionId, text, cwd, model, thinking, yolo)` | Produce the answer. Call `emit(sessionId, {type:"text_delta", text})` for each chunk, then `emit(sessionId, {type:"result", success, text, provider})`. Return `{sessionId, provider}`. |
| `listSessions(limit)` | Return an array (can be `[]`). |
| `getHistory(sessionId, limit)` | Return `[{role:"user"\|"assistant", text}]` (can be `[]`). |
| `getStatus(sessionId)` | Return `{state:"busy"\|"idle", provider}`. |
| `interrupt(sessionId)` | Stop the in-flight work. |
| `respondPermission` / `respondQuestion` | Can be no-ops. |
| `dispose()` | Optional cleanup. |

`emit(sessionId, msg)` is given to you. The only message types you need:
`user_prompt`, `status` (`{state:"busy"\|"idle"}`), `text_delta` (`{text}`),
`result` (`{success, text, provider}`), and optionally `error` (`{value}`) /
`tool_start` / `tool_end`.

### ✨ Don't want to write it by hand? Generate it.

If you use an AI coding agent (Claude, Codex, Cursor, etc.), paste this prompt —
it will produce a correct provider script for your specific tool:

````text
I need a Node.js ES module that is an Agent Home "custom agent provider" for
the tool: <YOUR TOOL NAME AND WHAT IT DOES>.

The module MUST export: createProvider(emit, options)
- emit(sessionId, msg) is provided; call it with:
  { type: "user_prompt", text }
  { type: "status", state: "busy" | "idle" }
  { type: "text_delta", text }            // for each chunk of the answer
  { type: "result", success: boolean, text, provider: "<your agent name>" }
- The returned object MUST implement: prompt(sessionId, text, cwd, model,
  thinking, yolo) -> { sessionId, provider }; listSessions(limit); getHistory(
  sessionId, limit); getStatus(sessionId); interrupt(sessionId);
  respondPermission(); respondQuestion(); dispose().

How to talk to my tool:
<DESCRIBE HERE: the command to run, the API to call, or the polling needed.
Include example input/output, the JSON shape of its responses, how session
ids work, and how to know when it's finished. Paste a sample run if you can.>

Constraints:
- Pure Node.js, ESM (`export function`), no build step.
- Use only node: built-ins + (optionally) globals like fetch.
- Stream tokens incrementally via text_delta; don't dump the whole answer at
  once unless the tool itself is non-streaming.
- Be robust: on error, emit a result with success:false and rethrow.
- Keep per-session state in a Map keyed by sessionId.
````

Fill in the `<...>` blanks with your tool's details and run it. Drop the
generated file somewhere stable and point `module:` at it.

---

## Common pitfalls

- **Restart the backend** after editing `agents.yaml`. Changes aren't picked up live.
- **`name` must be unique** and lowercase-with-dashes (`my-agent`, not `My Agent`).
  It also can't match a built-in name (`claude`, `pi`, …) — those are reserved.
- **A bad entry doesn't break anything.** If one agent's config is wrong, it's
  skipped and you'll see a message in the backend logs; the others still load.
- **Secrets:** prefer `apiKeyEnv` (Tier 1) or reading from `process.env` in your
  module (Tier 3) over hardcoding keys in `agents.yaml`.
- **Availability:** if you set `bin: somecommand`, the agent only shows as
  available when `somecommand` is installed. Leave `bin` out for things that are
  always reachable (like a remote URL).

## Where things live

| Path | What |
|---|---|
| `~/.agent-home/agents.yaml` | Your custom agent definitions (edit this). |
| `~/.agent-home/agents.json` | Same, if you prefer JSON (used only if `.yaml` is absent). |
| `~/.agent-home/README.md` | This guide. |
| `$AGENTHOME_AGENTS_CONFIG` | Env var override: absolute path to your config file. |
| `$AGENTHOME_AGENTS_NO_SEED=1` | Set this to stop Agent Home from creating the template/guide on first start. |

## Troubleshooting

- **My agent doesn't appear.** Check the backend logs for a `[agents]` line —
  it'll say which entry failed and why (bad name, missing field, bad URL, …).
- **My agent appears but says "unavailable".** You set `bin:` to a command that
  isn't on your `PATH`. Either install it or remove the `bin:` line.
- **My Tier 2 CLI produces no text.** Your `events.textDelta` paths don't match
  your CLI's JSON. Run your CLI by hand, look at one JSON line, and adjust the
  paths. The paths are dotted field names against each parsed JSON line.
- **My Tier 3 module errors at load.** Make sure it's ESM (`export function`),
  the path in `module:` is absolute, and it exports `createProvider`.
