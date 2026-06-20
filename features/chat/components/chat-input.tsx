"use client";

import { FormEvent, KeyboardEvent, useRef, useState } from "react";
import { Loader2, SendHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type ChatInputProps = {
  disabled?: boolean;
  onSend: (content: string) => void;
};

export function ChatInput({ disabled = false, onSend }: ChatInputProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submitMessage = () => {
    const trimmedValue = value.trim();

    if (!trimmedValue || disabled) {
      return;
    }

    onSend(trimmedValue);
    setValue("");
    textareaRef.current?.focus();
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submitMessage();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitMessage();
    }
  };

  return (
    <form
      className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-lg border bg-background p-2 shadow-lg"
      onSubmit={handleSubmit}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Message UGC Video Generator..."
        rows={1}
        disabled={disabled}
        className="max-h-36 min-h-11 flex-1 border-0 px-3 py-3 shadow-none focus-visible:ring-0"
        aria-label="Chat message"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!value.trim() || disabled}
        aria-label="Send message"
      >
        {disabled ? (
          <Loader2 className="animate-spin" />
        ) : (
          <SendHorizontal />
        )}
      </Button>
    </form>
  );
}
