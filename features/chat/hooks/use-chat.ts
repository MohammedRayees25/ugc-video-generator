"use client";

import { useCallback, useMemo, useState } from "react";

import {
  getAssistantMessageContent,
  getAssistantVideoUrl,
  sendChatMessage
} from "@/features/chat/lib/chat-api";
import type { ChatMessage } from "@/features/chat/types/chat";

const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    content:
      "Welcome to **UGC Video Generator**. Share a product URL or ask me about short UGC marketing videos.",
    createdAt: new Date()
  }
];

const URL_REGEX =
  /\b(?:https?:\/\/)?(?:localhost(?::\d{2,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{2,5})?)(?:\/[^\s<>"'`)]*)?/i;

const VIDEO_PROGRESS_MESSAGES = [
  "Analyzing website...",
  "Understanding product...",
  "Selecting assets...",
  "Rendering video..."
];

function createMessage(
  role: ChatMessage["role"],
  content: string,
  videoUrl?: string
): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    createdAt: new Date(),
    videoUrl
  };
}

function updateMessage(
  messages: ChatMessage[],
  id: string,
  patch: Partial<Pick<ChatMessage, "content" | "videoUrl">>
) {
  return messages.map((message) =>
    message.id === id ? { ...message, ...patch } : message
  );
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [isTyping, setIsTyping] = useState(false);

  const canSend = useMemo(() => !isTyping, [isTyping]);

  const sendMessage = useCallback(
    async (content: string) => {
      const normalizedContent = content.trim();

      if (!normalizedContent || !canSend) {
        return;
      }

      const userMessage = createMessage("user", normalizedContent);
      const nextMessages = [...messages, userMessage];

      setMessages(nextMessages);
      setIsTyping(true);

      const isVideoRequest = URL_REGEX.test(normalizedContent);
      const progressMessage = isVideoRequest
        ? createMessage("assistant", VIDEO_PROGRESS_MESSAGES[0])
        : null;
      let progressTimer: number | undefined;

      if (progressMessage) {
        setMessages((current) => [...current, progressMessage]);

        progressTimer = window.setInterval(() => {
          setMessages((current) => {
            const currentMessage = current.find(
              (message) => message.id === progressMessage.id
            );
            const currentIndex = VIDEO_PROGRESS_MESSAGES.indexOf(
              currentMessage?.content ?? ""
            );
            const nextIndex = Math.min(
              currentIndex + 1,
              VIDEO_PROGRESS_MESSAGES.length - 1
            );

            return updateMessage(current, progressMessage.id, {
              content: VIDEO_PROGRESS_MESSAGES[nextIndex]
            });
          });
        }, 2200);
      }

      try {
        const response = await sendChatMessage(nextMessages);
        const content = getAssistantMessageContent(response);
        const videoUrl = getAssistantVideoUrl(response);

        if (progressMessage) {
          setMessages((current) =>
            updateMessage(current, progressMessage.id, {
              content,
              videoUrl
            })
          );
        } else {
          setMessages((current) => [
            ...current,
            createMessage("assistant", content, videoUrl)
          ]);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error
            ? error.message
            : "I could not generate that response just now. Please try again in a moment.";

        if (progressMessage) {
          setMessages((current) =>
            updateMessage(current, progressMessage.id, {
              content: errorMessage
            })
          );
        } else {
          setMessages((current) => [
            ...current,
            createMessage("assistant", errorMessage)
          ]);
        }
      } finally {
        if (progressTimer) {
          window.clearInterval(progressTimer);
        }

        setIsTyping(false);
      }
    },
    [canSend, messages]
  );

  return {
    canSend,
    isTyping,
    messages,
    sendMessage
  };
}
