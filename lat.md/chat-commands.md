# Slash command execution

Typed slash commands (`/compact`, `/compress`, `/reset`, `/web`, …) are run through the gateway's command pipeline, not submitted to the model as plain prompt text. This is what makes them _do_ something instead of being echoed back as prose.

The desktop talks to the hermes-agent gateway over JSON-RPC. A normal message goes via `prompt.submit`, which the gateway treats as a user turn — so a literal `/compact` reaches the model and comes back as text. Real commands must instead go through `slash.exec` (registry-backed worker) with a `command.dispatch` fallback for commands that resolve to an alias, plugin, skill, or an agent prompt.

## Routing pipeline

The pure routing logic lives in [[src/renderer/src/screens/Chat/slashExec.ts#executeSlash]]: try `slash.exec`, and on rejection fall back to `command.dispatch`, returning a `SlashExecOutcome` of `done` (output rendered), `send` (resolved to an agent prompt the caller should stream), or `error`.

It mirrors hermes-agent's reference client (`web/src/lib/slashExec.ts`) so every front-end implements the same contract. Returning the `send` directive rather than dispatching it keeps the streaming turn lifecycle (loading state, active turn, `prompt.submit`) in the caller.

## Local vs gateway commands

Commands flagged `local: true` or in the `info` category are handled entirely in the renderer and never reach the gateway; everything else is routed through the pipeline.

A handful of commands (`/new`, `/clear`, `/fast`, `/usage`) are resolved client-side by `useLocalCommands`. The submit handler [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#useChatActions]] checks those first, then routes any remaining `/…` text through the dashboard transport's slash pipeline — falling back to plain-text send only on the legacy (non-dashboard) transport.

## Commands never queue

Slash commands run on the gateway's **persistent slash-worker subprocess**, concurrent with any in-flight turn — so they respond instantly and must NOT sit in the busy queue behind a running turn (only plain prompts queue).

`handleSubmitOrQueue` in [[src/renderer/src/screens/Chat/Chat.tsx]] dispatches any `/…` text immediately (for local commands or whenever the dashboard transport is active) instead of queueing. The `slash.exec` call sets no loading/active-turn state, so it can't collide with a streaming turn. The one exception is a command that resolves to a `send` directive (an agent prompt needing the single-flight main session): if a turn is already running it is deferred onto the queue via `enqueueMessage` rather than colliding. The legacy transport has no worker, so its slash commands still queue.

Because no global loading state is set, the slash branch shows its own feedback: it inserts an in-place `⏳ Running …` agent bubble, buffers the pipeline output, and replaces that bubble with the result (or `error: …`) when the command resolves — otherwise a slow or unreachable gateway would leave the user staring at nothing.

## Renderer-native commands

A few non-local commands have dedicated desktop handling and must NOT be diverted to the gateway slash pipeline, or they'd lose their behaviour.

The approval responses `/approve` and `/deny` (the `RENDERER_NATIVE_SLASH` set) are excluded from the pipeline and sent as prompt-level input, matching their dedicated button handlers — `slash.exec` rejects pending-input commands anyway.

## Side questions (`/btw`)

`/btw` (with aliases `/bg` and `/background`) is a side question that runs on a **concurrent background agent**, so it must never block or queue behind the main turn — that is the point of "ask without affecting context".

It maps to the gateway's `prompt.background` RPC, which spawns a separate agent and reports back later via a `background.complete` event (a normal `prompt.submit` mid-turn is rejected with "session busy"). [[src/renderer/src/screens/Chat/hooks/useChatActions.ts#parseBackgroundCommand|parseBackgroundCommand]] detects these commands; `handleSubmitOrQueue` in [[src/renderer/src/screens/Chat/Chat.tsx]] fires them immediately — bypassing the busy queue — via the shared background flow (also used by the 💭 quick-ask button). The transport's `runBackground` ([[src/renderer/src/screens/Chat/hooks/useDashboardChatTransport.ts#useDashboardChatTransport]]) calls the RPC, and its gateway-event handler renders the `background.complete` answer as a standalone `[bg …]` message. The legacy (non-dashboard) transport has no background RPC and falls back to the blocking quick-ask.
