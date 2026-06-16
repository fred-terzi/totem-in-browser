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
            Your Mind Leads
          </span>
        </div>

        {/* Hero */}
        <div className="flex flex-col gap-4">
          <h1 className="text-4xl font-bold tracking-tight leading-tight">
            Totem-LLM In-Browser Platform
            <br />
            <span className="text-muted-foreground font-medium">
              BETA
            </span>
          </h1>
        </div>

        {/* Links */}
        <ul className="w-full flex flex-col gap-2.5 text-sm text-left">
          {[
            { label: "Telegram:", url: "https://t.me/OfficialTotemToken" },
            { label: "X:", url: "https://x.com/OFFTotemToken" },
          ].map((item) => (
            <li key={item.url} className="flex items-start gap-2.5">
              <span className="mt-px text-green-500 shrink-0" aria-hidden>✓</span>
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:underline hover:text-foreground transition-colors"
              >
                {item.label} {item.url}
              </a>
            </li>
          ))}
        </ul>

        {/* Consent-framed CTA */}
        <div className="w-full flex flex-col items-center gap-3 rounded-2xl border bg-card p-6 shadow-sm">
          <p className="text-sm font-medium text-foreground">
            Ready to get started?
          </p>
          <Button size="lg" className="w-full mt-1" asChild>
            <Link href="/chat">Evaluate my hardware &amp; get started</Link>
          </Button>
        </div>
      </div>
    </main>
  );
}
