import { NextResponse } from "next/server";
import type { Message } from "@anthropic-ai/sdk/resources/messages";

import type {
  ChatApiMessage,
  ChatApiRequest,
  ChatApiResponse
} from "@/features/chat/types/chat";
import {
  anthropic,
  anthropicModel,
  getAnthropicConfigurationError,
  normalizeAnthropicError
} from "@/lib/anthropic-config";
import { selectGenerationAssets } from "@/lib/assets";
import { analyzeProductPage } from "@/lib/product-analysis";
import { extractFirstUrl, scrapeProductPage, ScraperError } from "@/lib/scraper";
import { generateUgcVideo, VideoGenerationError } from "@/lib/video-generator";

export const runtime = "nodejs";
export const maxDuration = 120;

const MAX_MESSAGES = 24;
const SYSTEM_PROMPT = [
  "You are UGC Video Generator, a concise assistant for short UGC marketing videos.",
  "Support natural conversation. If asked what you can do, explain that you create short UGC marketing videos and ask for a product URL.",
  "For ordinary conversation, respond naturally and helpfully.",
  "Do not claim that product analysis has happened unless the server has already detected a URL."
].join("\n");

function isChatApiMessage(value: unknown): value is ChatApiMessage {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;

  return (
    (candidate.role === "user" || candidate.role === "assistant") &&
    typeof candidate.content === "string" &&
    candidate.content.trim().length > 0
  );
}

function parseRequestBody(value: unknown): ChatApiRequest | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;

  if (!Array.isArray(candidate.messages)) {
    return null;
  }

  const messages = candidate.messages.filter(isChatApiMessage);

  if (messages.length === 0) {
    return null;
  }

  return {
    messages: messages.slice(-MAX_MESSAGES)
  };
}

function latestUserMessage(messages: ChatApiMessage[]) {
  return messages.findLast((message) => message.role === "user");
}

function toAnthropicMessages(messages: ChatApiMessage[]) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function extractText(content: Message["content"]) {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function getAnthropicErrorResponse(error: unknown) {
  const normalizedError = normalizeAnthropicError(error);

  return NextResponse.json(normalizedError.body, {
    status: normalizedError.status
  });
}

export async function POST(request: Request) {
  const configurationError = getAnthropicConfigurationError();

  if (configurationError) {
    return NextResponse.json(configurationError.body, {
      status: configurationError.status
    });
  }

  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const parsedBody = parseRequestBody(body);

  if (!parsedBody) {
    return NextResponse.json(
      { error: "Request must include at least one valid chat message." },
      { status: 400 }
    );
  }

  const currentUserMessage = latestUserMessage(parsedBody.messages);

  if (!currentUserMessage) {
    return NextResponse.json(
      { error: "Request must include a user message." },
      { status: 400 }
    );
  }

  const productUrl = extractFirstUrl(currentUserMessage.content);

  if (productUrl) {
    try {
      console.info("Starting product analysis pipeline", { productUrl });

      const scrapedPage = await scrapeProductPage(productUrl);
      console.info("Product page scraped", { productUrl });

      const analysis = await analyzeProductPage(scrapedPage);
      console.info("Product analysis completed", {
        productUrl,
        productName: analysis.productName
      });

      const assets = await selectGenerationAssets({
        backgroundKeyword: analysis.backgroundKeyword,
        gifKeyword: analysis.gifKeyword,
        musicMood: analysis.musicMood,
        category: analysis.category,
        emotion: analysis.emotion,
        websiteAssets: scrapedPage.assets
      });
      console.info("Assets selected", { productUrl, assets });

      const video = await generateUgcVideo(analysis, assets);
      console.info("Video generation completed", { productUrl, video });

      const response: ChatApiResponse = {
        type: "video",
        status: "completed",
        videoUrl: video.videoPath
      };

      return NextResponse.json(response);
    } catch (error) {
      console.error("Product analysis pipeline failed", {
        productUrl,
        error
      });

      if (!(error instanceof ScraperError)) {
        const anthropicError = normalizeAnthropicError(error);

        if (anthropicError.code !== "unknown") {
          return NextResponse.json(anthropicError.body, {
            status: anthropicError.status
          });
        }
      }

      if (error instanceof VideoGenerationError) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      const status =
        error instanceof ScraperError && error.code === "INVALID_URL"
          ? 400
          : 502;

      return NextResponse.json(
        {
          error:
            error instanceof ScraperError
              ? error.message
              : "Unable to generate this product video right now."
        },
        { status }
      );
    }
  }

  try {
    const completion = await anthropic.messages.create({
      model: anthropicModel,
      max_tokens: 700,
      temperature: 0.7,
      system: SYSTEM_PROMPT,
      messages: toAnthropicMessages(parsedBody.messages)
    });

    const message = extractText(completion.content);
    const response: ChatApiResponse = {
      type: "message",
      message:
        message ||
        "I am here and ready to help. Send me a product URL when you want to generate a UGC video brief."
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error("Anthropic chat request failed", error);

    return getAnthropicErrorResponse(error);
  }
}
