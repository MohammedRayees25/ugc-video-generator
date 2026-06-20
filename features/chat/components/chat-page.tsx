"use client";

import { useEffect, useRef } from "react";
import { Moon, Sparkles, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useChat } from "@/features/chat/hooks/use-chat";

import { ChatInput } from "./chat-input";
import { ChatMessage } from "./chat-message";
import { TypingIndicator } from "./typing-indicator";

export function ChatPage() {
  const { canSend, isTyping, messages, sendMessage } = useChat();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, isTyping]);

  const toggleTheme = () => {
    document.documentElement.classList.toggle("dark");
  };

  return (
    <main className="flex h-dvh min-h-dvh flex-col bg-background">
      <header className="sticky top-0 z-10 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="size-4" />
            </div>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold">UGC Video Generator</h1>
              <p className="text-xs text-muted-foreground">Draft mode</p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label="Toggle dark mode"
            title="Toggle dark mode"
          >
            <Sun className="size-4 dark:hidden" />
            <Moon className="hidden size-4 dark:block" />
          </Button>
        </div>
      </header>

      <section className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto">
        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}
        {isTyping && <TypingIndicator />}
        <div ref={bottomRef} />
      </section>

      <footer className="border-t bg-background px-4 py-3">
        <ChatInput disabled={!canSend} onSend={sendMessage} />
      </footer>
    </main>
  );
}
