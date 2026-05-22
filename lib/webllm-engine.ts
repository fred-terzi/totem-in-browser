"use client";

import {
  CreateWebWorkerMLCEngine,
  type InitProgressCallback,
  type MLCEngineInterface,
} from "@mlc-ai/web-llm";

// Tool/function calling is no longer required — RAG context is injected
// automatically by the transport. Default to a small, fast general-purpose
// model. Override with NEXT_PUBLIC_WEBLLM_MODEL or the in-app selector.
const DEFAULT_WEBLLM_MODEL = "Qwen3.5-2B-q4f16_1-MLC";

let enginePromise: Promise<MLCEngineInterface> | null = null;
let activeWorker: Worker | null = null;
let activeModelId: string | null = null;

// All progress listeners registered before the engine finishes loading.
const progressListeners = new Set<InitProgressCallback>();

export function getWebLLMModelId(): string {
  return process.env.NEXT_PUBLIC_WEBLLM_MODEL ?? DEFAULT_WEBLLM_MODEL;
}

function createWorker(): Worker {
  // Next.js/Turbopack and webpack both understand the
  // `new Worker(new URL(...), { type: "module" })` pattern and will bundle
  // the worker file as a separate chunk.
  return new Worker(new URL("./webllm.worker.ts", import.meta.url), {
    type: "module",
  });
}

export async function getWebLLMEngine(
  onInitProgress?: InitProgressCallback,
  modelId?: string,
): Promise<MLCEngineInterface> {
  const targetModel = modelId ?? activeModelId ?? getWebLLMModelId();

  // If a different model was requested, tear down the previous engine first.
  if (enginePromise && modelId && activeModelId && modelId !== activeModelId) {
    await resetWebLLMEngine();
  }

  if (onInitProgress) {
    progressListeners.add(onInitProgress);
  }

  if (!enginePromise) {
    activeWorker = createWorker();
    activeModelId = targetModel;
    enginePromise = CreateWebWorkerMLCEngine(activeWorker, targetModel, {
      initProgressCallback: (report) => {
        for (const cb of progressListeners) cb(report);
        // Once fully loaded no further callbacks will fire, so clear the set.
        if (report.progress >= 1) progressListeners.clear();
      },
    });
  }

  // Await the promise here so we can detect the case where the engine was
  // already fully loaded before this call (e.g. a React StrictMode remount
  // or a second call while loading was already in progress). In that scenario
  // the progress callbacks have already fired and progressListeners was
  // cleared — the callback registered above would never be invoked, leaving
  // the caller stuck. We flush any remaining listeners now so they receive
  // the final "done" signal.
  const engine = await enginePromise;

  if (onInitProgress && progressListeners.has(onInitProgress)) {
    progressListeners.delete(onInitProgress);
    onInitProgress({ progress: 1, timeElapsed: 0, text: "Ready" });
  }

  return engine;
}

/**
 * Tear down the active engine + worker. Used when switching models or
 * recovering from a fatal worker error.
 */
export async function resetWebLLMEngine(): Promise<void> {
  enginePromise = null;
  activeModelId = null;
  if (activeWorker) {
    activeWorker.terminate();
    activeWorker = null;
  }
  progressListeners.clear();
}

// ---------------------------------------------------------------------------
// First-inference lifecycle pub/sub
// Allows UI components to show a "first prompt loading" banner while the
// initial (warm-up) inference is in flight, then dismiss it automatically.
// ---------------------------------------------------------------------------
type FirstInferenceState = "pending" | "running" | "done";
let firstInferenceState: FirstInferenceState = "pending";
const firstInferenceListeners = new Set<
  (state: "running" | "done") => void
>();

export function subscribeToFirstInference(
  cb: (state: "running" | "done") => void,
): () => void {
  firstInferenceListeners.add(cb);
  // Replay current state to late subscribers
  if (firstInferenceState !== "pending") cb(firstInferenceState as "running" | "done");
  return () => firstInferenceListeners.delete(cb);
}

export function notifyFirstInferenceRunning(): void {
  if (firstInferenceState !== "pending") return;
  firstInferenceState = "running";
  for (const cb of firstInferenceListeners) cb("running");
}

export function notifyFirstInferenceDone(): void {
  if (firstInferenceState === "done") return;
  firstInferenceState = "done";
  for (const cb of firstInferenceListeners) cb("done");
  firstInferenceListeners.clear();
}

/**
 * Run a silent 1-token completion to pre-compile WebGPU shaders.
 * Call this immediately after the engine loads so the first real user
 * message does not pay the shader-compilation cost.
 */
export async function warmupWebLLMEngine(): Promise<void> {
  try {
    const engine = await getWebLLMEngine();
    notifyFirstInferenceRunning();
    const stream = await engine.chat.completions.create({
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1,
      stream: true,
    });
    // Drain the stream so shaders are fully compiled
    for await (const _ of stream) { /* no-op */ }
  } catch {
    // Non-fatal — the first real message will just be a bit slower
  } finally {
    notifyFirstInferenceDone();
  }
}

/**
 * Delete cached model weights from the browser's Cache Storage to free up
 * disk space. Also tears down the active engine so the model will be
 * re-downloaded on next use.
 */
export async function clearWebLLMCache(): Promise<void> {
  await resetWebLLMEngine();

  if (typeof caches === "undefined") return;

  const keys = await caches.keys();
  await Promise.all(keys.map((key) => caches.delete(key)));
}
