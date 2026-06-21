import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { formatMessageTime } from "@/features/chat/lib/time";
import type { ChatMessage as ChatMessageType } from "@/features/chat/types/chat";
import { cn } from "@/lib/utils";

import { MarkdownMessage } from "./markdown-message";

type ChatMessageProps = {
  message: ChatMessageType;
};

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <article
      className={cn(
        "w-full border-b border-border/70",
        isUser ? "bg-background" : "bg-muted/30"
      )}
    >
      <div
        className={cn(
          "mx-auto flex w-full max-w-3xl gap-3 px-4 py-5",
          isUser && "justify-end"
        )}
      >
        {!isUser && <Avatar role="assistant" />}
        <div className={cn("min-w-0 max-w-[82%]", isUser && "order-first")}>
          <div
            className={cn(
              "rounded-lg px-4 py-3 shadow-sm",
              isUser
                ? "bg-primary text-primary-foreground"
                : "border bg-background"
            )}
          >
            {/*
             * User messages are always plain text — never markdown.
             * Rendering user input through ReactMarkdown causes auto-linked
             * URLs to receive class="text-primary", which is invisible against
             * the bg-primary user bubble, producing an empty green box.
             */}
            {isUser ? (
              <p className="break-words whitespace-pre-wrap text-sm leading-relaxed">
                {message.content}
              </p>
            ) : (
              <MarkdownMessage content={message.content} className="break-words" />
            )}
            {message.videoUrl && (
              <div className="mt-4 space-y-3">
                <video
                  className="aspect-[9/16] max-h-[520px] w-full rounded-md border bg-muted object-cover"
                  controls
                  src={message.videoUrl}
                />
                <Button asChild variant="secondary" size="sm">
                  <a href={message.videoUrl} download>
                    Download video
                  </a>
                </Button>
              </div>
            )}
          </div>
          {/*
           * suppressHydrationWarning: the <time> content depends on
           * message.createdAt which is created with new Date(). The server
           * and client call new Date() at slightly different wall-clock times,
           * producing different ISO strings. suppressHydrationWarning tells
           * React this mismatch is expected and should not cause a warning.
           * The displayed value is always correct on the client after hydration.
           */}
          <time
            className={cn(
              "mt-1 block text-xs text-muted-foreground",
              isUser && "text-right"
            )}
            dateTime={message.createdAt.toISOString()}
            suppressHydrationWarning
          >
            {formatMessageTime(message.createdAt)}
          </time>
        </div>
        {isUser && <Avatar role="user" />}
      </div>
    </article>
  );
}

