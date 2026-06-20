import type { Message } from "@anthropic-ai/sdk/resources/messages";

import type { ProductAnalysis } from "@/features/chat/types/chat";
import {
  anthropic,
  anthropicModel,
  normalizeAnthropicError
} from "@/lib/anthropic-config";
import type { ScrapedProductPage } from "@/lib/scraper";

const MAX_ANALYSIS_RETRIES = 2;

const SYSTEM_PROMPT = [
  "You analyze product landing pages for UGC short-form video generation.",
  "Return ONLY valid JSON. Do not wrap it in markdown. Do not include commentary.",
  "Use concise, funny, trendy, social-media-ready copy.",
  "Captions must be short, punchy, and natural for TikTok/Reels/Shorts."
].join("\n");

function promptForAnalysis(page: ScrapedProductPage, retryNote = "") {
  return [
    retryNote,
    "Analyze this scraped product page and return exactly this JSON shape:",
    JSON.stringify(
      {
        productName: "string",
        category: "string",
        targetAudience: "string",
        mainBenefits: ["string"],
        painPoints: ["string"],
        viralHook: "string",
        caption: "string",
        cta: "string",
        hookVariations: ["string"],
        featureCaptions: ["string"],
        ctaCaptions: ["string"],
        emotion: "reaction | mindblown | arrow | money | checkmark | laugh | success | warning | wow",
        backgroundKeyword: "string",
        gifKeyword: "string",
        musicMood: "string",
        hashtags: ["string"]
      },
      null,
      2
    ),
    "Rules:",
    "- hookVariations: exactly 5 options, max 8 words each, funny/trendy, emojis allowed.",
    "- featureCaptions: exactly 5 options, max 8 words each, product-specific.",
    "- ctaCaptions: exactly 5 options, max 8 words each, action-oriented.",
    "- category should be one of: fitness, food, travel, finance, AI, education, gaming, beauty, productivity, fashion, technology, lifestyle.",
    "- emotion should describe the GIF style: reaction, mindblown, arrow, money, checkmark, laugh, success, warning, or wow.",
    "",
    "Scraped page:",
    JSON.stringify(page, null, 2)
  ]
    .filter(Boolean)
    .join("\n");
}

function extractText(content: Message["content"]) {
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
}

function parseJsonObject(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    const match = value.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error("Claude did not return JSON.");
    }

    return JSON.parse(match[0]) as unknown;
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  );
}

function assertProductAnalysis(value: unknown): ProductAnalysis {
  if (!value || typeof value !== "object") {
    throw new Error("Product analysis is not an object.");
  }

  const candidate = value as Record<string, unknown>;
  const requiredStrings = [
    "productName",
    "category",
    "targetAudience",
    "viralHook",
    "caption",
    "cta",
    "backgroundKeyword",
    "gifKeyword",
    "musicMood"
  ];

  for (const key of requiredStrings) {
    if (
      typeof candidate[key] !== "string" ||
      candidate[key].trim().length === 0
    ) {
      throw new Error(`Product analysis field "${key}" is invalid.`);
    }
  }

  if (!isStringArray(candidate.mainBenefits)) {
    throw new Error('Product analysis field "mainBenefits" is invalid.');
  }

  if (!isStringArray(candidate.painPoints)) {
    throw new Error('Product analysis field "painPoints" is invalid.');
  }

  if (!isStringArray(candidate.hashtags)) {
    throw new Error('Product analysis field "hashtags" is invalid.');
  }

  const readString = (key: string) => {
    const field = candidate[key];

    if (typeof field !== "string") {
      throw new Error(`Product analysis field "${key}" is invalid.`);
    }

    return field.trim();
  };

  return {
    productName: readString("productName"),
    category: readString("category"),
    targetAudience: readString("targetAudience"),
    mainBenefits: candidate.mainBenefits.map((item) => item.trim()),
    painPoints: candidate.painPoints.map((item) => item.trim()),
    viralHook: readString("viralHook"),
    caption: readString("caption"),
    cta: readString("cta"),
    hookVariations: isStringArray(candidate.hookVariations)
      ? candidate.hookVariations.map((item) => item.trim())
      : [readString("viralHook")],
    featureCaptions: isStringArray(candidate.featureCaptions)
      ? candidate.featureCaptions.map((item) => item.trim())
      : candidate.mainBenefits.map((item) => item.trim()),
    ctaCaptions: isStringArray(candidate.ctaCaptions)
      ? candidate.ctaCaptions.map((item) => item.trim())
      : [readString("cta")],
    emotion:
      typeof candidate.emotion === "string" && candidate.emotion.trim()
        ? candidate.emotion.trim()
        : readString("gifKeyword"),
    backgroundKeyword: readString("backgroundKeyword"),
    gifKeyword: readString("gifKeyword"),
    musicMood: readString("musicMood"),
    hashtags: candidate.hashtags.map((item) => item.trim())
  };
}

export async function analyzeProductPage(
  page: ScrapedProductPage
): Promise<ProductAnalysis> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_ANALYSIS_RETRIES; attempt += 1) {
    try {
      const completion = await anthropic.messages.create({
        model: anthropicModel,
        max_tokens: 1000,
        temperature: 0.3,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: promptForAnalysis(
              page,
              attempt > 0
                ? "Your previous response was invalid. Return ONLY valid JSON matching the schema."
                : ""
            )
          }
        ]
      });

      return assertProductAnalysis(parseJsonObject(extractText(completion.content)));
    } catch (error) {
      const providerError = normalizeAnthropicError(error);

      if (providerError.code !== "unknown") {
        throw error;
      }

      lastError = error;
      console.warn("Product analysis attempt failed", {
        attempt: attempt + 1,
        error
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Product analysis failed.");
}
