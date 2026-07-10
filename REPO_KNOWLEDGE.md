# Totem In-Browser — Repo Knowledge Document

> Last updated: 2026-07-09
> Tech stack: Next.js 16 (App Router) / React 19 / TypeScript / Zustand
> LLM inference: @mlc-ai/web-llm (in-browser WebGPU), custom IndexedDB persistence

---

## 1. Architecture Overview

This is a fully client-side, in-browser LLM chat application. There are **no server APIs** for chat — all model loading, inference, state management, and data persistence happen entirely on the user's device. The app downloads models from Hugging Face and runs them via WebGPU on the user's GPU.

```
                    ┌──────────────────────────────────────┐
                    │            app/assistant.tsx         │  ← App page component (rendered on server, hydrates client)
                    │                                      │
                    │   ┌────────────────────────────────┐ │
                    │   │      WebLLMLoader              │ │  ← Gate: checks GPU/cache before showing UI
                    │   │   (checks WebGPU, model cache  │ │
                    │   │    VRAM requirements, mobile)  │ │
                    │   └──────────────┬─────────────────┘ │
                    │                  │ [phase === "done"]│
                    │                  ▼                   │
                    │   ┌────────────────────────────────┐ │
                    │   │        ChatShell               │ │
                    │   │   ┌──────────────┐             │ │
                    │   │   │ AssistantRuntimeProvider  │ │
                    │   │   │   (AUI)         │          │ │
                    │   │   │    ├── SidebarProvider     │ │
                    │   │   │    │    ├── ThreadListSidebar  │
                    │   │   │    │    └── SidebarInset       │
                    │   │   │    │        ├── header (toolbar)│
                    │   │   │    │        └── <Thread>      │
                    │   │   └──────────────┘             │
                    │   │                                │
                    │   │  ┌───────────────┐            │
                    │   │  │useIndexedDBChatRuntime│     │
                    │   │  │ (bridges AI SDK useChat │   │
                    │   │  │   → AssistantUI runtime) │
                    │   │  └───────────────┘            │
                    │   └────────────────────────────────┘ │
                    │                                      │
                    │  Modals:                             │
                    │   • FaqBuilder (Totem Builder)       │
                    │   • PerpetualPrompt                  │
                    └──────────────────────────────────────┘

    Data layer (all IndexedDB, zero network after model load):
    ┌───────────────────────────────────────────────────────────┐
    │  lib/db.ts          — App's ChatThreadStore (Zustand)     │
    │                       IDB name: webllm (via Zustand FAQ)  │
    │  webllm-faq DB      — FAQ knowledge entries               │
    │  faq-matcher.ts     — loadFaqData/setFaqData/Matcher class│
    │  webllm-engine.ts   — getModelId/getWebLLMEngine/warmup  │
    │                       subscribeToFirstInference()         │
    │  transport/         — WebLLMChatTransport (AIML)        │
    │                       sendMessage/abortStream/readStream  │
    └───────────────────────────────────────────────────────────┘
```

---

## 2. Routing & Page Structure

| Path | File | Description |
|------|------|-------------|
| `/` | `app/page.tsx` | Minimal wrapper that renders `<Assistant />` |
| N/A | `app/assistant.tsx` | **App surface** — exports `{ Assistant }`, the top-level mounted component for the app (a "page" component in Next.js terms, not a route page). This is where everything wires together. |

There are no other routes. Chat persistence uses IndexedDB — no database server.

---

## 3. Component Hierarchy

### Top-Level: `<Assistant />` (`app/assistant.tsx`)

Two rendering paths:
1. **Normal path** (default): `<WebLLMLoader>` wraps `<ChatShell>`. Loader checks GPU compatibility and model cache before revealing ChatShell.
2. **Demo path**: when `NEXT_PUBLIC_DEMO_MODE=true`, bypasses loader entirely and mounts ChatShell directly.

### ChatShell — the core layout (`app/assistant.tsx`)

```
AssistantRuntimeProvider (AUI)
├── ThreadPersistenceSync (useDbThreadSync hook, renders <>)
├── SidebarProvider
│   ├── ThreadListSidebar
│   │   ├── SidebarHeader ("Totem" branding)
│   │   ├── SidebarContent ← <ThreadList />
│   │   └── SidebarFooter ← "Uncache model" button
│   └── SidebarInset
│       ├── header
│       │   ├── SidebarTrigger (toggles sidebar)
│       │   ├── disabled X-link button ("In Dev")
│       │   ├── disabled Telegram link button ("In Dev")
│       │   ├── "Perpetual Prompt" button → opens PerpetualPrompt
│       │   └── "Totem Builder" button → opens FaqBuilder
│       └── <Thread> (main chat area)
├── <FaqBuilder open/...>  (Dialog modal)
└── <PerpetualPrompt open/...> (Dialog modal)
```

### `<WebLLMLoader>` (`components/webllm-loader.tsx`)

**Purpose:** Pre-launch gate. Checks WebGPU availability, hardware compatibility, cached models, and mobile support before allowing the chat UI to appear.

**Export:** `WebLLMLoader({ children })` — renders `<>{children}</>` when everything is ready; otherwise shows loader UI.

**Key behaviors:**
- **Mobile detection:** blocks on mobile unless user clicks "Continue anyway". Mentions iPhone 17, high-end Android flagships, recent iPad Pro/Air as supported.
- **Model catalog:** imports `prebuiltAppConfig.model_list` from `@mlc-ai/web-llm`, sorts by VRAM. User selects model from dropdown (full catalog).
- **Hardware assessment:** queries GPU via `navigator.gpu.requestAdapter()`, gets description/vendor/architecture/maxBufferMB/systemMemoryGB. Classifies as `ok | caution | warning | blocked`. Blocks if: no WebGPU, software renderer detected (SwiftShader/WARP/llvmpipe/virgl), or <4 GB system RAM.
- **Cache check:** calls `hasModelInCache(modelId)` from `@mlc-ai/web-llm`. If cached → auto-starts loading (line 316: "auto-start loading when the model is already cached — no need for an extra click").
- **F16 → F32 fallback:** on error message containing "shader-f16", swaps to f32 quantization version of same model automatically.
- **Warmup:** after download, runs a silent 1-token completion to pre-compile WebGPU shaders (line 279: `await warmupWebLLMEngine()`).

**Load phases:** `checking → ready-cached / ready-fresh → loading → done | error`

---

### `<Thread>` (`components/assistant-ui/thread.tsx`) — The chat area

The main chat rendering component. Contains several nested sub-components:

```
<Thread> (exported)
├── <ThreadPrimitive.Root style={{ "--thread-max-width": "44rem", ... }}>
│   └── <ThreadPrimitive.Viewport turnAnchor="top">
│       ├── [empty?] → <ThreadWelcome> + <ThreadSuggestions>
│       │   └── Suggestions: ["What is Totem?", "What is a Perpetual Prompt?", ...]
│       ├── Thread primitive messages ({messages.map(ThreadMessage)})
│       └── ViewportFooter (sticky bottom)
│           ├── scroll-to-bottom button
│           ├── "First prompt loading" banner (conditional — shown during first inference)
│           └── <Composer>
```

Each `ThreadMessage` conditionally renders:
- **User message** → `<UserMessage>` with attachments + edit action bar + branch picker.
- **Assistant message** → `<AssistantMessage>` with markdown rendering, reasoning block, tool call fallback, error display, and action bar (copy/refresh/edit/more).

**Action bar per assistant message:** Copy, Refresh, Show More (Export Markdown), Edit.

**User messages** include an edit button (inline editing replaces text content in AI SDK state).

---

### `<ThreadListSidebar>` (`components/assistant-ui/threadlist-sidebar.tsx`)

Left sidebar showing thread list and containing:
- Branding header ("Totem")
- Thread list component (from AUI)
- **Footer:** "Uncache model" button → calls `clearWebLLMCache()` from `lib/webllm-engine`

---

### `<FaqBuilder>` (`components/faq-builder.tsx`) — "Totem Builder"

A dialog for managing FAQ knowledge base entries.

**Export:** `FaqBuilder({ open, onOpenChange })`

**State flow:**
1. On open → calls `loadFaqData()` (reads from IndexedDB), populates entries in state.
2. **EntryForm:** inline edit/add form with question/keywords(as comma-separated)/answer fields. Commits via `setFaqData()` which writes back to IDB.
3. **EntryCard:** display-only with expand/collapse, edit, and delete-confirm (two-step).
4. "Reset to defaults" → calls `resetFaqData()`.

**Data model (`lib/faq-matcher.ts`):**
```typescript
type FaqEntry = { id: string; question: string; keywords: string[]; answer: string }
type FaqData = { faq: FaqEntry[]; followUpTopics: string[] }
```

---

### `<PerpetualPrompt>` (`components/perpetual-prompt.tsx`) — "Perpetual Prompt"

A dialog for editing the system prompt.

**State flow:** opens → `getSystemPrompt()` → writes to textarea → on save → `setSystemPrompt(value.trim() || DEFAULT_PROMPT)`.
Reset calls `resetSystemPrompt()` which restores `DEFAULT_PROMPT`.

---

## 4. State & Data Flow

### Chat transport (AI SDK → WebLLM → IndexedDB)

```
User types into <Composer>
    │
    ▼
ChatPrimitive.Send
    │──→ Thread state → isRunning = true
    │──→ useAISDKRuntime({ chat })
          │──→ useIndexedDBChatRuntime() ──→ AuiState runtime
                │──→ Bridge: dynamic proxy wraps WebLLMChatTransport
                      │   (same pattern as useChatRuntime)
        │──→ AI SDK `useChat` with transport
              │──→ transport.sendMessage({ message })  ← WebLLM Chat Transport
                    │──→ getWebLLMEngine()
                    │     → load model (if not loaded)
                    │     → prefill: systemPrompt + FAQ prompt + perThreadPrompt + threadHistory + lastUserMessage
                    │     → generate: createCompletion(prompt, { onChunk })
                    │        → stream chunks → appendTextContent(textFragment)
                    │     → warmup (initial load only)
              │──→ message set in AUI state
              │──→ AI SDK transport handles streaming updates
```

### Message persistence (IndexedDB)

**Load path (`use-idb-chat-runtime.ts`: `useChatThreadRuntime`):**
1. Thread ID changes → `db.getThread(id)` → reads from IndexedDB ChatThreadStore
2. Converts to `UIMessage[]` format: `parts: [{ type: "text", text, metadata }]`, `role: "user" | "assistant"`, `createdAt`, threadId, _threadListItem
3. **Only sets messages if chat.messages.length === 0** — avoids overwriting active conversations on reconnect

**Save path (`use-db-thread-sync.ts`):**
1. Every AI SDK message change → `serializeMessages()` filters to text-only content, joins multiple text parts (multi-part content silently discarded)
2. Only persists when NOT running (line 39: "if (isRunning) return")
3. Title logic: keeps existing title if not "New conversation", otherwise uses first user message as title
4. `db.saveThread()` writes entire thread object to IDB

**Critical limitation:** Message history stores only plain text content (`msg.content.filter(p => {type === 'text'}).map(p => p.text).join("")`). Tool calls, reasoning blocks, and other UI part types are silently dropped on save.

---

## 5. Key Dependencies & Exports

### `lib/db.ts` — Database layer (200+ lines)
- Exports: `db` object (`{ threads: ChatThreadStore }`), `{ Message, Thread }` types
- StorageKey: `"chat-thread-store"` in IndexedDB (Zustand's default key)
- IDB database name: `"webllm"` (from Zustand FAQ adapter, imported from `zustand/middleware/faq`)
- **ChatThreadStore:** persistes `{ threads: Thread[] }` to localStorage/IndexedDB; used by the index thread adapter

### `lib/faq-matcher.ts` — Knowledge base (190+ lines)
- **Matcher class** (line 246): exact keyword matching using fuzzy/fallback logic
- Exports: `loadFaqData`, `setFaqData`, `resetFaqData`, `getFaqData`, `DEFAULT_KNOWLEDGE`, `{ FaqEntry, FaqData }` types
- Default knowledge includes 9 entries covering Totem token, staking, governance, and more

### `lib/webllm-engine.ts` — Model loading/warmup (150+ lines)
- Exports: `getModelId()` (env fallback to Qwen3.2-B-Q4), `getWebLLMEngine(callback?, modelId?)`, `warmupWebLLMEngine()`, `clearWebLLMCache()`, `subscribeToFirstInference(callback)`

### lib/transport/webllm-transport.ts — AI SDK ChatTransport (100+ lines)
- Implements: `{ sendMessage, abortStream | isSupported }` from @ai-sdk/react
- Key logic in send: gets engine → checks loaded? loads it → prefill with systemPrompt + FAQ prompt + threadHistory → generate with streaming

### hooks/use-idb-chat-runtime.ts — AI SDK bridge (122 lines)
- Export: `useIndexedDBChatRuntime({ transport })` → AssistantRuntime
- Export: **`chatHelpersRef`** — shared ref for direct message manipulation (used by thread edit)

### hooks/use-db-thread-sync.ts — IDB persistence hook (73 lines)
- Export: `useDbThreadSync()` — side-effect hook, mounts as `<ThreadPersistenceSync />` in ChatShell
- Persists state from AI SDK → IndexedDB when stream completes

### Components UI layer (`components/ui/*`)
All Radix/primitive wrappers: Button, Dialog, Sidebar, Input, Separator, Tooltip, etc. Standard `@/components.json` shadcn config.

---

## 6. Environment Variables & Deployment

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_BASE_PATH` | Set during deployment to the app's base path (nginx reverse proxy or Docker path) |
| `NEXT_PUBLIC_MODEL_ID` | Overwrites which model is loaded from `webllm-engine.ts` default. Example: `"Qwen3.2-B-Q4"` |
| `NEXT_PUBLIC_DEMO_MODE` | When `"true"` bypasses the WebGPU/model loading gate entirely for UI development |

**Deployment assumptions (from batch A review):**
- Service worker registration dynamically interpolates `${process.env.BASE_PATH}` — this may fail during deployment if not explicitly configured.
- Root layout hardcodes `className="dark"` on root element → dark-mode-first app with no light mode toggle.
- The `@/app/layout.tsx` also handles PWA manifest injection; it registers a service worker that caches the shell.

---

## 7. Critical Code Paths

### Message send (user → response)
1. User types in Composer → hits send button
2. `ComposerPrimitive.Send` fires → AI SDK sends via `useAISDKRuntime({ chat })`
3. `chat.transport.sendMessage()` → calls `WebLLMChatTransport.sendMessage()`
4. Transport: get engine → load model if needed → build prompt → call LLM → stream chunks

### Thread persistence (every AI SDK message change)
1. AI SDK state changes → `useDbThreadSync()` sees new messages via `useAuiState`
2. When `isRunning === false`, serializes all text content, writes thread to IndexedDB ChatThreadStore
3. Title auto-generated from first user message if still "New conversation"

### Knowledge base update (FaqBuilder dialog)
1. Dialog opens → `loadFaqData()` reads FAQ entries from IDB into React state
2. User edits/creates/deletes entries
3. On commit: `setFaqData(newEntries)` → writes back to IDB ChatThreadStore (separate store from chat threads)

### Model loading flow
1. `WebLLMLoader.mount()` → checks GPU, model cache (parallel), FAQ data in parallel
2. If cached → auto-starts load (no user interaction needed on return visits)
3. Downloads from HuggingFace (web-llm handles CDN) → shows progress bar
4. After download → warmupWebLLMEngine() runs 1-token completion for shader pre-compilation
5. Only then renders `<>{children}</>` — the ChatShell

---

## 8. Testing & Coverage (`tests/`)

Total tests: **9** (all in `tests/transport-messages.test.ts` and `tests/db.test.ts`).

**Zero coverage on:** component files, hooks, assistant.tsx layout, WebLLMLoader states, FAQ builder logic, perpetual prompt state, sidebar behavior, thread rendering.

---

## 9. Architectural Notes & Potential Issues

1. **Text-only message storage** — `serializeMessages()` filters multi-part content to text only. Tool call results (structured output) is discarded on save/reload.
2. **No server-side rendering for chat routes** — app is fully client-side with `{ "type": "client" }` in route config.
3. **PWA assumptions** — the manifest URL and service worker registration assume `${process.env.BASE_PATH}` resolves correctly during deployment.
4. **Dark-mode hardcodings** — root layout enforces dark mode permanently (`className="dark"`). No light theme exists; CSS variables use `--dark` variants only.
5. **Model catalog dependency** — `components/webllm-loader.tsx` line 18 directly uses `prebuiltAppConfig.model_list` from `@mlc-ai/web-llm`. If the package updates, VRAM estimates or model IDs may shift.
6. **F16 auto-fallback** — when the error message contains "shader-f16", it converts Q4/Q8 f12/q4f32 fallback. This is silent; user never sees why the selected model changed.

---

## 10. File Inventory by Layer

### App Surface (rendering)
- `app/page.tsx` — minimal wrapper, renders `<Assistant />`
- `app/assistant.tsx` — **top-level mounted component** wiring everything together
  - Exports `{ Assistant }`, `ChatShell`, `ThreadPersistenceSync`
  - Manages: FAQBuilder/perpetual prompt dialog state
  - Creates WebLLMChatTransport, IndexedDB runtime, layout skeleton

### Components (UI)
- `components/webllm-loader.tsx` — GPU cache & model gate
- `components/faq-builder.tsx` — FAQ knowledge base editor
- `components/perpetual-prompt.tsx` — system prompt editor
- `components/assistant-ui/thread.tsx` — thread/message rendering, composer, welcome screen, suggestions, scroll, error handling, editing
- `components/assistant-ui/threadlist-sidebar.tsx` — sidebar with thread list + "Uncache" button

### Components (UI primitives - shadcn)
All under `components/ui/*`: Button, Dialog, Input, Sidebar, Separator, Tooltip, Skeleton, Collapsible, Sheet, Avatar, etc. Radix-based wrappers per `components.json`.

### Hooks
- `hooks/use-db-thread-sync.ts` — sync AI SDK → IndexedDB on stream complete
- `hooks/use-idb-chat-runtime.ts` — bridge AI SDK `useChat` to AssistantUI runtime
- `hooks/use-mobile.ts` — standard responsive hook (from shadcn)

### Lib & Transport
- `lib/db.ts` — ChatThreadStore + Message types (200+ lines) 
- `lib/webllm-engine.ts` — model loading/warmup/f16-fallback (150+ lines)
- `lib/faq-matcher.ts` — FAQ knowledge base read/write (190+ lines)
- `lib/transport/webllm-transport.ts` — AI SDK ChatTransport for WebLLM (100+ lines)

### Config & Build
- `package.json` — main app dependencies, build scripts
- `app.config.ts` — app configuration
- `components.json` — shadcn component registry
- `tests/transport-messages.test.ts` — UI behavior tests
- `tests/db.test.ts` — DB operations test
- `public/*.txt`, `.svg` — static files

---

## 11. Quick Reference: Key Paths for Debugging

| Problem area | Look here first |
|-------------|-----------------|
| Model won't load / GPU error | `components/webllm-loader.tsx` — assessHardware, getWebGPUInfo |
| Messages not saving | `hooks/use-db-thread-sync.ts` → serializeMessages, db.saveThread |
| Missing old messages on reload | `hooks/use-idb-chat-runtime.ts` → useChatThreadRuntime |
| FAQ entries broken | `components/faq-builder.tsx` + `lib/faq-matcher.ts` |
| System prompt not applying | `components/perpetual-prompt.tsx` + check prefill order in transport |
| Chat not sending to model | `lib/transport/webllm-transport.ts` → sendMessage, readStream |
| Sidebar / UI broken | `app/assistant.tsx` → ChatShell layout structure |
| Theme/display issues | `app/layout.tsx` — dark-mode enforcement, CSS imports |
