"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { hasModelInCache, prebuiltAppConfig } from "@mlc-ai/web-llm";
import { getWebLLMEngine, getWebLLMModelId, resetWebLLMEngine, warmupWebLLMEngine } from "@/lib/webllm-engine";
import { loadFaqData } from "@/lib/faq-matcher";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ModelRecord = {
  model_id: string;
  vram_required_MB?: number;
  low_resource_required?: boolean;
};

// Sort the full WebLLM model catalog by VRAM (small → large) so the lightest
// models surface first in the dropdown.
const ALL_MODELS: ModelRecord[] = [...prebuiltAppConfig.model_list]
  .map((m) => ({
    model_id: m.model_id,
    vram_required_MB: m.vram_required_MB,
    low_resource_required: m.low_resource_required,
  }))
  .sort(
    (a, b) =>
      (a.vram_required_MB ?? Infinity) - (b.vram_required_MB ?? Infinity),
  );

type GpuInfo = {
  description: string;
  vendor?: string;
  architecture?: string;
  maxBufferMB?: number;
  /** System RAM in GB from navigator.deviceMemory (Chromium only). */
  systemMemoryGB?: number;
};

type HardwareSeverity = "ok" | "caution" | "warning" | "blocked";

type HardwareAssessment = {
  severity: HardwareSeverity;
  headline: string;
  detail: string;
};

/**
 * Known software-rendered WebGPU adapters. These technically expose WebGPU
 * but run on the CPU and are far too slow for any LLM inference. Matched
 * case-insensitively against the full adapter description string.
 *
 * - SwiftShader / Subzero — Chrome's CPU fallback (no real GPU present)
 * - WARP                  — Windows Advanced Rasterization Platform (D3D software renderer)
 * - llvmpipe / softpipe   — Mesa CPU renderers on Linux
 * - virgl                 — VirtIO GPU used inside virtual machines
 */
const SOFTWARE_RENDERER_PATTERNS = [
  "swiftshader",
  "subzero",   // SwiftShader sub-backend
  "warp",
  "llvmpipe",
  "softpipe",
  "virgl",
] as const;

function isSoftwareRenderer(gpu: GpuInfo): boolean {
  const haystack = [gpu.description, gpu.vendor, gpu.architecture]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return SOFTWARE_RENDERER_PATTERNS.some((p) => haystack.includes(p));
}

/**
 * Conservative hardware assessment. When in doubt we lean towards a more
 * cautious rating — a false negative (warning capable hardware) is far less
 * harmful than letting users kick off a large download that will inevitably fail.
 */
function assessHardware(
  gpu: GpuInfo,
  vramRequired?: number,
): HardwareAssessment {
  // 1. Hard block — WebGPU unavailable
  if (
    gpu.description === "WebGPU not available" ||
    gpu.description === "No adapter found"
  ) {
    return {
      severity: "blocked",
      headline: "Hardware not supported",
      detail:
        gpu.description === "WebGPU not available"
          ? "WebGPU is not available in this browser. Use a Chromium-based browser with hardware acceleration enabled."
          : "No WebGPU adapter was found. Update your GPU drivers or enable hardware acceleration in browser settings.",
    };
  }

  // 2. Hard block — software / CPU-fallback renderer (no real GPU)
  if (isSoftwareRenderer(gpu)) {
    return {
      severity: "blocked",
      headline: "Software renderer detected — not supported",
      detail: `"${gpu.description}" is a CPU-based software renderer. It exposes WebGPU but is far too slow for LLM inference. Enable hardware acceleration in your browser settings or use a device with a real GPU.`,
    };
  }

  // 3. Hard block — very low system RAM
  if (gpu.systemMemoryGB !== undefined && gpu.systemMemoryGB < 4) {
    return {
      severity: "blocked",
      headline: "Insufficient system memory",
      detail: `Only ${gpu.systemMemoryGB} GB of system RAM detected. At least 4 GB is required to run a local LLM.`,
    };
  }

  // 3. GPU info could not be queried
  if (gpu.description === "Unable to query GPU") {
    return {
      severity: "caution",
      headline: "Hardware unknown",
      detail:
        "Could not query GPU information. Proceed with caution — the model may fail to load if your GPU lacks sufficient memory.",
    };
  }

  // 4. Low system RAM warning for larger models
  if (
    gpu.systemMemoryGB !== undefined &&
    gpu.systemMemoryGB < 8 &&
    vramRequired !== undefined &&
    vramRequired > 2048
  ) {
    return {
      severity: "caution",
      headline: "Limited system memory",
      detail: `${gpu.systemMemoryGB} GB of system RAM may not be enough for this model (~${Math.round(vramRequired).toLocaleString()} MB required). Consider selecting a smaller model.`,
    };
  }

  return {
    severity: "ok",
    headline: "Hardware looks compatible",
    detail: "Your GPU appears to have sufficient memory for the selected model.",
  };
}

type LoadPhase =
  | { type: "checking" }
  | { type: "ready-cached"; gpu: GpuInfo }
  | { type: "ready-fresh"; gpu: GpuInfo }
  | { type: "loading"; progress: number; text: string }
  | { type: "error"; message: string; gpu: GpuInfo }
  | { type: "done" };

async function getWebGPUInfo(): Promise<GpuInfo> {
  // Capture system RAM early — available on Chromium via navigator.deviceMemory.
  const systemMemoryGB =
    typeof navigator !== "undefined" && "deviceMemory" in navigator
      ? (navigator as Navigator & { deviceMemory?: number }).deviceMemory
      : undefined;

  try {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      return { description: "WebGPU not available", systemMemoryGB };
    }
    const adapter = await navigator.gpu.requestAdapter({
      powerPreference: "high-performance",
    });
    if (!adapter) return { description: "No adapter found", systemMemoryGB };

    // Chromium M121+: adapter.info is a synchronous property (GPUAdapterInfo).
    // Older builds exposed an async requestAdapterInfo() method — try both.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapterAny = adapter as any;
    const info: {
      vendor?: string;
      architecture?: string;
      device?: string;
      description?: string;
    } =
      adapterAny.info ??
      (typeof adapterAny.requestAdapterInfo === "function"
        ? await adapterAny.requestAdapterInfo()
        : {});

    const parts = [info.description, info.vendor, info.architecture, info.device]
      .map((s) => (s ?? "").trim())
      .filter(Boolean);

    const maxBufferMB =
      typeof adapter.limits?.maxBufferSize === "number"
        ? Math.round(adapter.limits.maxBufferSize / (1024 * 1024))
        : undefined;

    return {
      description: parts.length > 0 ? parts.join(" · ") : "Unknown GPU",
      vendor: info.vendor || undefined,
      architecture: info.architecture || undefined,
      maxBufferMB,
      systemMemoryGB,
    };
  } catch {
    return { description: "Unable to query GPU", systemMemoryGB };
  }
}

export function WebLLMLoader({
  children,
}: {
  children: React.ReactNode;
}) {
  const isMobile = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|mobile/i.test(
      navigator.userAgent,
    );
  }, []);

  const [mobileAcknowledged, setMobileAcknowledged] = useState(false);
  const [phase, setPhase] = useState<LoadPhase>({ type: "checking" });
  const [selectedModel, setSelectedModel] = useState<string>(() =>
    getWebLLMModelId(),
  );
  const loadingRef = useRef(false);
  // Preserve the last-known GPU info so the error state can offer a retry
  // that returns to the model-selection screen with full context.
  const gpuRef = useRef<GpuInfo>({ description: "Unknown GPU" });

  // Re-check cache + GPU whenever the selected model changes
  useEffect(() => {
    let cancelled = false;
    setPhase({ type: "checking" });
    (async () => {
      try {
        const [cached, gpu] = await Promise.all([
          hasModelInCache(selectedModel),
          getWebGPUInfo(),
          loadFaqData(), // Pre-load FAQ data in parallel
        ]);
        if (!cancelled) {
          gpuRef.current = gpu;
          setPhase(
            cached
              ? { type: "ready-cached", gpu }
              : { type: "ready-fresh", gpu },
          );
        }
      } catch {
        if (!cancelled) {
          setPhase({
            type: "ready-fresh",
            gpu: { description: "Unknown GPU" },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedModel]);

  const startLoading = (modelOverride?: string) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    const modelId = modelOverride ?? selectedModel;
    setPhase({ type: "loading", progress: -1, text: "Starting engine…" });

    getWebLLMEngine((report) => {
      setPhase({
        type: "loading",
        progress: report.progress,
        text: report.progress >= 1 ? "Warming up first inference…" : report.text,
      });
      // Do NOT set "done" here — warmup must run first (see .then below).
    }, modelId)
      .then(async () => {
        // Run a silent 1-token completion to pre-compile WebGPU shaders so
        // the first real user message is noticeably faster.
        setPhase({ type: "loading", progress: 1, text: "Warming up first inference…" });
        await warmupWebLLMEngine();
        setPhase({ type: "done" });
      })
      .catch((err: unknown) => {
        console.error("[Totem] Engine failed to load:", err);
        loadingRef.current = false;

        // The browser lacks the shader-f16 WebGPU extension. Transparently
        // retry with the f32 quantisation of the same model — no user action needed.
        const isF16Error =
          !modelOverride &&
          err instanceof Error &&
          err.message.toLowerCase().includes("shader-f16");

        if (isF16Error) {
          const f32Id = modelId.replace(/q4f16/gi, "q4f32").replace(/q8f16/gi, "q8f32");
          const fallbackId =
            ALL_MODELS.find((m) => m.model_id === f32Id)?.model_id ??
            ALL_MODELS.find((m) => m.model_id.includes("f32"))?.model_id;

          if (fallbackId) {
            resetWebLLMEngine().then(() => {
              setSelectedModel(fallbackId);
              startLoading(fallbackId);
            });
            return;
          }
        }

        const message =
          err instanceof Error ? err.message : "Unknown error. Check the console for details.";
        setPhase({ type: "error", message, gpu: gpuRef.current });
      });
  };

  // Auto-start loading when the model is already cached — no need for an
  // extra click since there's no download involved.
  useEffect(() => {
    if (phase.type === "ready-cached" && !loadingRef.current) {
      startLoading();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.type]);

  if (isMobile && !mobileAcknowledged) {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background">
        <div className="flex max-w-md w-full flex-col items-center gap-4 rounded-2xl border bg-card p-8 shadow-sm text-center">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              Mobile support is limited
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Running a local LLM on mobile requires a high-performance device.
              Supported hardware includes the{" "}
              <span className="font-medium text-foreground">iPhone 17</span>,
              high-end Android flagships, and recent iPad Pro / iPad Air models.
            </p>
            <p className="text-sm text-muted-foreground mt-2">
              Older or mid-range devices may crash or fail to load the model.
              For the best experience, use a desktop browser.
            </p>
          </div>
          <Button
            size="lg"
            className="w-full"
            onClick={() => setMobileAcknowledged(true)}
          >
            Continue anyway
          </Button>
        </div>
      </div>
    );
  }

  if (phase.type === "done") {
    return <>{children}</>;
  }

  if (phase.type === "checking") {
    return <LoadingShell label="Checking model cache…" showSpinner />;
  }

  if (phase.type === "loading") {
    return (
      <LoadingShell
        label={phase.text || "Loading model…"}
        progress={phase.progress}
      />
    );
  }

  if (phase.type === "error") {
    return (
      <div className="flex h-dvh w-full items-center justify-center bg-background">
        <div className="flex max-w-md w-full flex-col items-center gap-4 rounded-2xl border bg-card p-8 shadow-sm text-center">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold tracking-tight text-destructive">
              Failed to load model
            </h1>
            <p className="text-xs text-muted-foreground mt-1">
              The engine encountered an error while loading. This can happen due
              to insufficient GPU memory or a temporary browser issue.
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              Your browser or computer may not be able to handle this model. However, your
              computer may still be suitable for{" "}
              <span className="font-medium text-foreground">Totem Desktop</span>. Follow{" "}
              <a
                href="https://t.me/OfficialTotemToken"
                target="_blank"
                rel="noopener noreferrer"
                className="underline text-primary"
              >
                our Telegram
              </a>{" "}
              for updates.
            </p>
          </div>
          <div className="w-full rounded-md bg-muted px-4 py-3 text-left">
            <p className="text-xs font-mono text-muted-foreground break-all">
              {phase.message}
            </p>
          </div>
          <Button
            size="lg"
            className="w-full"
            onClick={() => {
              setPhase({ type: "ready-fresh", gpu: phase.gpu });
            }}
          >
            Try again
          </Button>
        </div>
      </div>
    );
  }

  // ready-cached or ready-fresh
  const isCached = phase.type === "ready-cached";
  const gpu = phase.gpu;
  const selectedRecord = ALL_MODELS.find((m) => m.model_id === selectedModel);
  const vramRequired = selectedRecord?.vram_required_MB;
  const assessment = assessHardware(gpu, vramRequired);

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background">
      <div className="flex max-w-md w-full flex-col items-center gap-6 rounded-2xl border bg-card p-8 shadow-sm text-center">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isCached ? "Model ready to load" : "WebLLM & WebGPU"}
          </h1>
          {!isCached && (
            <p className="text-xs text-muted-foreground">
              Run large language models locally in your browser via WebGPU — no
              server required.
            </p>
          )}
        </div>

        {/* Model selector (full prebuilt catalog, sorted by VRAM) */}
        <div className="w-full flex flex-col gap-1.5 text-left">
          <label
            htmlFor="model-select"
            className="text-xs font-medium text-muted-foreground"
          >
            Model
          </label>
          <select
            id="model-select"
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value)}
            className="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {ALL_MODELS.map((m) => (
              <option key={m.model_id} value={m.model_id}>
                {m.model_id}
                {m.vram_required_MB != null
                  ? `  —  ${Math.round(m.vram_required_MB).toLocaleString()} MB VRAM`
                  : ""}
              </option>
            ))}
          </select>
          {vramRequired != null && (
            <p className="text-[11px] text-muted-foreground">
              Requires ~{Math.round(vramRequired).toLocaleString()} MB VRAM
              {selectedRecord?.low_resource_required
                ? " · low-resource model"
                : ""}
            </p>
          )}
        </div>

        {/* GPU info badge */}
        <div className="w-full rounded-md bg-muted px-4 py-2 text-left flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium shrink-0">
              WebGPU adapter
            </span>
            <span className="text-xs font-mono text-foreground truncate">
              {gpu.description}
            </span>
          </div>
          {gpu.maxBufferMB != null && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium shrink-0">
                Max buffer
              </span>
              <span className="text-xs font-mono text-foreground">
                {gpu.maxBufferMB.toLocaleString()} MB
              </span>
            </div>
          )}
          {gpu.systemMemoryGB != null && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground font-medium shrink-0">
                System RAM
              </span>
              <span className="text-xs font-mono text-foreground">
                {gpu.systemMemoryGB} GB
              </span>
            </div>
          )}
        </div>

        <HardwareAssessmentBanner assessment={assessment} />

        <p className="text-sm text-muted-foreground leading-relaxed">
          {isCached
            ? "The model weights are cached in your browser. Click below to load the model into memory."
            : "The model needs to be downloaded before the assistant can run locally in your browser. This is a one-time download — subsequent loads are instant."}
        </p>

        {!isCached && (
          <div className="w-full rounded-md bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-4 py-3 text-left">
            <p className="text-xs text-amber-800 dark:text-amber-300 font-medium">
              Download size
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {vramRequired != null
                ? `Approximately ${Math.round(vramRequired).toLocaleString()} MB. `
                : ""}
              The model is cached in your browser after the first download.
            </p>
          </div>
        )}

        <Button size="lg" className="w-full" onClick={() => startLoading()}>
          {isCached ? "Load model" : "Download and load model"}
        </Button>
      </div>
    </div>
  );
}

function HardwareAssessmentBanner({
  assessment,
}: {
  assessment: HardwareAssessment;
}) {
  const styles: Record<
    HardwareSeverity,
    { container: string; icon: string; title: string; text: string }
  > = {
    ok: {
      container:
        "bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800",
      icon: "✓",
      title: "text-green-800 dark:text-green-300",
      text: "text-green-700 dark:text-green-400",
    },
    caution: {
      container:
        "bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800",
      icon: "⚠",
      title: "text-yellow-800 dark:text-yellow-300",
      text: "text-yellow-700 dark:text-yellow-400",
    },
    warning: {
      container:
        "bg-orange-50 dark:bg-orange-950/30 border border-orange-200 dark:border-orange-800",
      icon: "⚠",
      title: "text-orange-800 dark:text-orange-300",
      text: "text-orange-700 dark:text-orange-400",
    },
    blocked: {
      container:
        "bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800",
      icon: "✕",
      title: "text-red-800 dark:text-red-300",
      text: "text-red-700 dark:text-red-400",
    },
  };
  const s = styles[assessment.severity];

  return (
    <div className={`w-full rounded-md px-4 py-3 text-left ${s.container}`}>
      <p className={`text-xs font-semibold flex items-center gap-1.5 ${s.title}`}>
        <span aria-hidden>{s.icon}</span>
        Hardware assessment · {assessment.headline}
      </p>
      <p className={`text-xs mt-1 leading-relaxed ${s.text}`}>
        {assessment.detail}
      </p>
    </div>
  );
}

function LoadingShell({
  label,
  progress,
  showSpinner = false,
}: {
  label: string;
  progress?: number;
  showSpinner?: boolean;
}) {
  const hasProgress = typeof progress === "number";
  const isIndeterminate = hasProgress && progress < 0;
  const pct = hasProgress && !isIndeterminate ? Math.round(progress * 100) : 0;

  return (
    <div className="flex h-dvh w-full items-center justify-center bg-background">
      <div className="flex max-w-md w-full flex-col items-center gap-4 rounded-2xl border bg-card p-8 shadow-sm">
        <div className="flex items-center gap-2">
          {(showSpinner || isIndeterminate) && (
            <span className="inline-block size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          )}
          <p className="text-sm font-medium text-foreground">{label}</p>
        </div>

        {hasProgress && (
          <div className="w-full flex flex-col gap-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              {isIndeterminate ? (
                <div className="h-full w-1/3 rounded-full bg-primary animate-pulse-slide" />
              ) : (
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-300 ease-out",
                    pct < 100 ? "bg-primary" : "bg-green-500",
                  )}
                  style={{ width: `${pct}%` }}
                />
              )}
            </div>
            {!isIndeterminate && (
              <p className="text-xs text-muted-foreground text-right tabular-nums">
                {pct}%
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
