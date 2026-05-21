import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-dvh w-full flex-col items-center justify-center bg-background px-6 py-16">
      <div className="flex flex-col items-center gap-10 max-w-lg w-full text-center">

        {/* Logo */}
        <div className="flex flex-col items-center gap-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/icons/totem_logo.png`}
            alt="Totem logo"
            width={128}
            height={128}
            className="rounded-2xl shadow-sm"
          />
          <span className="text-sm font-semibold tracking-widest uppercase text-muted-foreground">
            Totem Preview
          </span>
        </div>

        {/* Hero */}
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-bold tracking-tight leading-tight">
            Transform your computer
            <br />
            <span className="text-muted-foreground font-medium">
              into your private AI.
            </span>
          </h1>
          <p className="text-base text-muted-foreground leading-relaxed">
            A capable AI assistant that runs entirely inside your browser — powered
            by WebGPU. Private by design. Works offline after the first load.
          </p>
        </div>

        {/* Feature list */}
        <ul className="w-full flex flex-col gap-2.5 text-sm text-left">
          {[
            "All inference happens on your device — nothing is sent to a server",
            "Works offline once the model is downloaded",
            "Designed to fit on consumer hardware",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2.5">
              <span className="mt-px text-green-500 shrink-0" aria-hidden>✓</span>
              <span className="text-muted-foreground">{item}</span>
            </li>
          ))}
        </ul>

        {/* Consent-framed CTA */}
        <div className="w-full flex flex-col items-center gap-3 rounded-2xl border bg-card p-6 shadow-sm">
          <p className="text-sm font-medium text-foreground">
            Ready to get started?
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Before loading the assistant we&apos;ll check your browser&apos;s
            WebGPU capabilities to make sure your hardware can handle it. This
            check runs entirely on your device — no data is collected or
            transmitted.
          </p>
          <Button size="lg" className="w-full mt-1" asChild>
            <Link href="/chat">Evaluate my hardware &amp; get started</Link>
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Requires a Chromium-based browser with hardware acceleration enabled
          </p>
        </div>

      </div>
    </main>
  );
}
