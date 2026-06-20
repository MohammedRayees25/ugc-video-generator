import { Avatar } from "@/components/ui/avatar";

export function TypingIndicator() {
  return (
    <div className="mx-auto flex w-full max-w-3xl gap-3 px-4 py-5">
      <Avatar role="assistant" />
      <div className="flex items-center gap-1 rounded-lg bg-muted px-3 py-2">
        <span className="sr-only">Assistant is typing</span>
        {[0, 150, 300].map((delay) => (
          <span
            className="size-1.5 animate-bounce rounded-full bg-muted-foreground"
            style={{ animationDelay: `${delay}ms` }}
            key={delay}
          />
        ))}
      </div>
    </div>
  );
}
