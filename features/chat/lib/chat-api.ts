import type {
  ChatApiRequest,
  ChatApiResponse,
  ChatMessage,
  ProductAnalysis
} from "@/features/chat/types/chat";

const MAX_RETRIES = 2;

function shouldRetry(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

async function postChat(request: ChatApiRequest) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const errorMessage = await readErrorMessage(response);

    throw new Error(
      errorMessage ??
        (shouldRetry(response.status)
          ? "The assistant is temporarily unavailable. Please try again."
          : "The assistant could not process that message.")
    );
  }

  return (await response.json()) as ChatApiResponse;
}

async function readErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as unknown;

    if (body && typeof body === "object") {
      const error = (body as Record<string, unknown>).error;

      return typeof error === "string" ? error : null;
    }
  } catch {
    return null;
  }

  return null;
}

export async function sendChatMessage(messages: ChatMessage[]) {
  const request: ChatApiRequest = {
    messages: messages.map(({ role, content }) => ({ role, content }))
  };

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await postChat(request);
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw error;
      }

      await new Promise((resolve) =>
        window.setTimeout(resolve, 350 * (attempt + 1))
      );
    }
  }

  throw new Error("The assistant could not process that message.");
}

function formatList(values: string[]) {
  return values.map((value) => `- ${value}`).join("\n");
}

function formatProductAnalysis(analysis: ProductAnalysis) {
  return [
    `## ${analysis.productName}`,
    "",
    `**Category:** ${analysis.category}`,
    `**Target audience:** ${analysis.targetAudience}`,
    "",
    "**Main benefits**",
    formatList(analysis.mainBenefits),
    "",
    "**Pain points**",
    formatList(analysis.painPoints),
    "",
    `**Viral hook:** ${analysis.viralHook}`,
    `**Caption:** ${analysis.caption}`,
    `**CTA:** ${analysis.cta}`,
    "",
    `**Background:** ${analysis.backgroundKeyword}`,
    `**GIF:** ${analysis.gifKeyword}`,
    `**Music mood:** ${analysis.musicMood}`,
    "",
    analysis.hashtags.join(" ")
  ].join("\n");
}

export function getAssistantMessageContent(response: ChatApiResponse) {
  if (response.type === "video") {
    return "Done! Your UGC video is ready.";
  }

  if (response.type === "product" && response.status === "analyzed") {
    return response.analysis
      ? formatProductAnalysis(response.analysis)
      : "I analyzed the product, but the result was incomplete. Please try again.";
  }

  return response.message ?? "Analyzing your product...";
}

export function getAssistantVideoUrl(response: ChatApiResponse) {
  return response.type === "video" ? response.videoUrl : undefined;
}
