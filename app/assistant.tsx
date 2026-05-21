"use client";

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useMemo, useState, type FC } from "react";
import { BookOpen, MessageSquare } from "lucide-react";
import { Thread } from "@/components/assistant-ui/thread";
import { WebLLMChatTransport } from "../lib/transport/webllm-transport";
import { WebLLMLoader } from "@/components/webllm-loader";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThreadListSidebar } from "@/components/assistant-ui/threadlist-sidebar";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { FaqBuilder } from "@/components/faq-builder";
import { PerpetualPrompt } from "@/components/perpetual-prompt";
import { useDbThreadSync } from "@/hooks/use-db-thread-sync";
import { useIndexedDBChatRuntime } from "@/hooks/use-idb-chat-runtime";

const ChatShell = () => {
  const transport = useMemo(() => new WebLLMChatTransport(), []);
  const [faqBuilderOpen, setFaqBuilderOpen] = useState(false);
  const [perpetualPromptOpen, setPerpetualPromptOpen] = useState(false);

  const runtime = useIndexedDBChatRuntime({
    transport,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPersistenceSync />
      <SidebarProvider>
        <div className="flex h-dvh w-full pr-0.5">
          <ThreadListSidebar />
          <SidebarInset>
            <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
              <SidebarTrigger />
              <Separator orientation="vertical" className="mr-2 h-4" />
              <Button variant="outline" size="sm" disabled>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/icons/X-Logo.jpg`} alt="X" width={16} height={16} className="rounded-sm" />
                In Dev
              </Button>
              <Button variant="outline" size="sm" disabled>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/icons/telegram_PNG31.png`} alt="Telegram" width={16} height={16} />
                In Dev
              </Button>
              <div className="flex-1" />
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPerpetualPromptOpen(true)}
              >
                <MessageSquare className="size-4" />
                Perpetual Prompt
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setFaqBuilderOpen(true)}
              >
                <BookOpen className="size-4" />
                Totem Builder
              </Button>
            </header>
            <div className="flex-1 overflow-hidden">
              <Thread />
            </div>
          </SidebarInset>
        </div>
      </SidebarProvider>
      <FaqBuilder open={faqBuilderOpen} onOpenChange={setFaqBuilderOpen} />
      <PerpetualPrompt open={perpetualPromptOpen} onOpenChange={setPerpetualPromptOpen} />
    </AssistantRuntimeProvider>
  );
};

const ThreadPersistenceSync: FC = () => {
  useDbThreadSync();
  return null;
};

export const Assistant = () => {
  // Demo mode: bypass the loading screen entirely for UI development.
  // Set NEXT_PUBLIC_DEMO_MODE=true in .env.local, then restart the dev server.
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "true") {
    return <ChatShell />;
  }
  return (
    <WebLLMLoader>
      <ChatShell />
    </WebLLMLoader>
  );
};
