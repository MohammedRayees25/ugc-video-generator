import axios, { AxiosError } from "axios";
import * as cheerio from "cheerio";

export type ScrapedProductPage = {
  title: string;
  description: string;
  content: string;
  assets: ScrapedWebsiteAssets;
};

export type ScrapedWebsiteAssets = {
  logoUrl?: string;
  heroImageUrl?: string;
  ogImageUrl?: string;
  screenshotUrls: string[];
  brandColors: string[];
};

const SCRAPE_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_PARAGRAPHS = 40;
const MAX_CONTENT_LENGTH = 12_000;
const MAX_IMAGES = 8;

export class ScraperError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "INVALID_URL"
      | "TIMEOUT"
      | "NETWORK"
      | "HTTP_STATUS"
      | "EMPTY_CONTENT"
  ) {
    super(message);
    this.name = "ScraperError";
  }
}

function normalizeUrl(rawUrl: string) {
  const trimmedUrl = rawUrl.trim();
  const candidate = /^https?:\/\//i.test(trimmedUrl)
    ? trimmedUrl
    : `https://${trimmedUrl}`;

  try {
    const url = new URL(candidate);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ScraperError("Only HTTP and HTTPS URLs are supported.", "INVALID_URL");
    }

    return url.toString();
  } catch (error) {
    if (error instanceof ScraperError) {
      throw error;
    }

    throw new ScraperError("The product URL is invalid.", "INVALID_URL");
  }
}

function cleanText(value: string | undefined) {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function resolveAssetUrl(rawUrl: string | undefined, pageUrl: string) {
  const cleanedUrl = cleanText(rawUrl);

  if (!cleanedUrl || cleanedUrl.startsWith("data:")) {
    return "";
  }

  try {
    return new URL(cleanedUrl, pageUrl).toString();
  } catch {
    return "";
  }
}

function readMeta($: cheerio.CheerioAPI, selector: string) {
  return cleanText($(selector).first().attr("content"));
}

function extractOpenGraph($: cheerio.CheerioAPI) {
  const entries: string[] = [];

  $("meta[property^='og:'], meta[name^='og:']").each((_, element) => {
    const property = cleanText(
      $(element).attr("property") ?? $(element).attr("name")
    );
    const content = cleanText($(element).attr("content"));

    if (property && content) {
      entries.push(`${property}: ${content}`);
    }
  });

  return unique(entries);
}

function extractVisibleParagraphs($: cheerio.CheerioAPI) {
  const paragraphs: string[] = [];

  $("p, li").each((_, element) => {
    const text = cleanText($(element).text());

    if (text.length >= 35) {
      paragraphs.push(text);
    }
  });

  return unique(paragraphs).slice(0, MAX_PARAGRAPHS);
}

function extractBrandColors($: cheerio.CheerioAPI) {
  const values = [
    readMeta($, "meta[name='theme-color']"),
    readMeta($, "meta[name='msapplication-TileColor']"),
    $("style")
      .map((_, element) => cleanText($(element).text()))
      .get()
      .join(" ")
  ];
  const matches = values
    .join(" ")
    .match(/#[0-9a-fA-F]{6}\b/g);

  return unique(matches ?? []).slice(0, 6);
}

function imageScore(src: string, alt: string, className: string) {
  const haystack = `${src} ${alt} ${className}`.toLowerCase();
  let score = 0;

  if (/hero|product|screenshot|app|phone|preview|cover/.test(haystack)) {
    score += 6;
  }

  if (/logo|brand|icon/.test(haystack)) {
    score += 3;
  }

  if (/\.(png|jpe?g|webp)(\?|$)/.test(src.toLowerCase())) {
    score += 2;
  }

  return score;
}

function extractWebsiteAssets($: cheerio.CheerioAPI, pageUrl: string): ScrapedWebsiteAssets {
  const ogImageUrl = resolveAssetUrl(
    readMeta($, "meta[property='og:image']") ||
      readMeta($, "meta[name='twitter:image']"),
    pageUrl
  );
  const iconUrl = resolveAssetUrl(
    $("link[rel~='icon'], link[rel='apple-touch-icon']")
      .first()
      .attr("href"),
    pageUrl
  );
  const imageCandidates = $("img")
    .map((_, element) => {
      const src = resolveAssetUrl(
        $(element).attr("src") ??
          $(element).attr("data-src") ??
          $(element).attr("data-lazy-src"),
        pageUrl
      );

      return {
        src,
        alt: cleanText($(element).attr("alt")),
        className: cleanText($(element).attr("class"))
      };
    })
    .get()
    .filter((image) => image.src)
    .sort(
      (left, right) =>
        imageScore(right.src, right.alt, right.className) -
        imageScore(left.src, left.alt, left.className)
    );
  const logoUrl =
    imageCandidates.find((image) =>
      /logo|brand|icon/i.test(`${image.src} ${image.alt} ${image.className}`)
    )?.src ?? iconUrl;
  const heroImageUrl =
    imageCandidates.find((image) =>
      /hero|product|screenshot|app|phone|preview|cover/i.test(
        `${image.src} ${image.alt} ${image.className}`
      )
    )?.src ?? ogImageUrl;

  return {
    logoUrl: logoUrl || undefined,
    heroImageUrl: heroImageUrl || undefined,
    ogImageUrl: ogImageUrl || undefined,
    screenshotUrls: unique(imageCandidates.map((image) => image.src)).slice(
      0,
      MAX_IMAGES
    ),
    brandColors: extractBrandColors($)
  };
}

export function extractFirstUrl(message: string) {
  const match = message.match(
    /\b(?:https?:\/\/)?(?:localhost(?::\d{2,5})?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})(?::\d{2,5})?)(?:\/[^\s<>"'`)]*)?/i
  );

  return match?.[0] ?? null;
}

export async function scrapeProductPage(rawUrl: string): Promise<ScrapedProductPage> {
  const url = normalizeUrl(rawUrl);

  try {
    const response = await axios.get<string>(url, {
      timeout: SCRAPE_TIMEOUT_MS,
      maxRedirects: MAX_REDIRECTS,
      responseType: "text",
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent":
          "Mozilla/5.0 (compatible; UGCVideoGenerator/1.0; +https://example.com/bot)"
      },
      validateStatus: (status) => status >= 200 && status < 400
    });

    const $ = cheerio.load(response.data);

    const assets = extractWebsiteAssets($, url);

    $("script, style, noscript, svg, iframe, canvas").remove();

    const title =
      cleanText($("title").first().text()) ||
      readMeta($, "meta[property='og:title']") ||
      readMeta($, "meta[name='twitter:title']");
    const description =
      readMeta($, "meta[name='description']") ||
      readMeta($, "meta[property='og:description']") ||
      readMeta($, "meta[name='twitter:description']");
    const headings = unique([
      ...$("h1")
        .map((_, element) => cleanText($(element).text()))
        .get(),
      ...$("h2")
        .map((_, element) => cleanText($(element).text()))
        .get()
    ]);
    const openGraph = extractOpenGraph($);
    const paragraphs = extractVisibleParagraphs($);

    const content = unique([
      title,
      description,
      ...headings,
      ...openGraph,
      assets.logoUrl ? `logo: ${assets.logoUrl}` : "",
      assets.heroImageUrl ? `hero image: ${assets.heroImageUrl}` : "",
      assets.brandColors.length
        ? `brand colors: ${assets.brandColors.join(", ")}`
        : "",
      ...paragraphs
    ])
      .join("\n")
      .slice(0, MAX_CONTENT_LENGTH)
      .trim();

    if (!content) {
      throw new ScraperError("The page did not contain readable content.", "EMPTY_CONTENT");
    }

    return {
      title,
      description,
      content,
      assets
    };
  } catch (error) {
    if (error instanceof ScraperError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      throw toScraperError(error);
    }

    throw new ScraperError("Unable to scrape the product page.", "NETWORK");
  }
}

function toScraperError(error: AxiosError) {
  if (error.code === "ECONNABORTED") {
    return new ScraperError("The product page request timed out.", "TIMEOUT");
  }

  if (error.response) {
    return new ScraperError(
      `The product page returned HTTP ${error.response.status}.`,
      "HTTP_STATUS"
    );
  }

  return new ScraperError("Unable to reach the product page.", "NETWORK");
}
