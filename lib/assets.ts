import fs from "fs";
import path from "path";
import axios from "axios";
import type { ScrapedWebsiteAssets } from "@/lib/scraper";

export type AssetSelectionInput = {
  backgroundKeyword: string;
  gifKeyword: string;
  musicMood: string;
  category: string;
  emotion?: string;
  websiteAssets?: ScrapedWebsiteAssets;
};

export type AssetReference = {
  /** Public URL path (e.g. /assets/videos/gym.mp4) or empty string when absent. */
  path: string;
  source: "local" | "remote";
};

export type GenerationAssets = {
  background: AssetReference;
  gif: AssetReference;
  audio: AssetReference;
  website: ScrapedWebsiteAssets;
  /** Absolute filesystem path to a presenter image/video, or null if none available. */
  presenterPath: string | null;
};

/* -------------------------------------------------------------------------- */
/* Local asset discovery                                                       */
/* -------------------------------------------------------------------------- */

const ASSETS_ROOT = path.join(process.cwd(), "public", "assets");

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const GIF_EXTS = new Set([".gif"]);
const AUDIO_EXTS = new Set([".mp3", ".wav", ".ogg", ".m4a"]);
const PRESENTER_EXTS = new Set([".mp4", ".mov", ".webm", ".png", ".jpg", ".jpeg", ".svg"]);

/** Log how many files are available in each asset folder at startup. */
function logAssetInventory() {
  const dirs: Record<string, Set<string>> = {
    backgrounds: IMAGE_EXTS,
    videos: VIDEO_EXTS,
    presenters: PRESENTER_EXTS,
    gifs: GIF_EXTS,
    audio: AUDIO_EXTS,
  };

  console.info("── Asset library inventory ──────────────────────────────────");
  for (const [subdir, exts] of Object.entries(dirs)) {
    const files = listDir(subdir, exts);
    const label = subdir.charAt(0).toUpperCase() + subdir.slice(1);
    if (files.length > 0) {
      console.info(`  ✓ ${label}: ${files.length} file(s)`, files.map((f) => path.basename(f)));
    } else {
      console.info(`  ✗ ${label}: 0 files (folder empty or missing)`);
    }
  }
  console.info("─────────────────────────────────────────────────────────────");
}

/**
 * Returns public URL paths (e.g. /assets/videos/gym.mp4) so that existing
 * video-generator helpers (publicPathToFilePath) can resolve them normally.
 * Returns an empty array — never throws — when the folder is absent or empty.
 */
function listDir(subdir: string, validExts: Set<string>): string[] {
  const absDir = path.join(ASSETS_ROOT, subdir);
  try {
    return fs
      .readdirSync(absDir)
      .filter((f) => validExts.has(path.extname(f).toLowerCase()) && !f.startsWith("."))
      .map((f) => `/assets/${subdir}/${f}`);
  } catch {
    return [];
  }
}

function pickRandom<T>(arr: T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Prefer files whose name contains any of the hint tokens; fall back to a
 * random file from the full list if nothing matches.
 */
function pickByHint(files: string[], ...hints: string[]): string | null {
  if (files.length === 0) return null;

  const tokens = hints
    .join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);

  const matches = files.filter((f) => {
    const base = path.basename(f).toLowerCase();
    return tokens.some((t) => base.includes(t));
  });

  return pickRandom(matches.length > 0 ? matches : files);
}

/* -------------------------------------------------------------------------- */
/* Presenter selection                                                         */
/* -------------------------------------------------------------------------- */

const PRESENTER_KEYWORD_MAP: Array<{ keywords: string[]; hints: string[] }> = [
  { keywords: ["fitness", "gym", "workout", "health", "training", "sport"], hints: ["fitness", "gym", "sport", "workout"] },
  { keywords: ["food", "meal", "nutrition", "recipe", "restaurant", "cooking"], hints: ["food", "chef", "cook", "kitchen"] },
  { keywords: ["beauty", "skincare", "makeup", "cosmetic", "glow", "fashion", "style"], hints: ["beauty", "makeup", "fashion", "style"] },
  { keywords: ["technology", "tech", "app", "software", "saas", "ai", "automation", "digital"], hints: ["tech", "app", "software", "digital"] },
  { keywords: ["finance", "money", "investing", "banking", "wealth", "crypto", "trading"], hints: ["finance", "money", "invest", "business"] },
  { keywords: ["travel", "hotel", "vacation", "trip", "destination", "adventure"], hints: ["travel", "adventure", "outdoor", "nature"] },
  { keywords: ["lifestyle", "gaming", "creator", "entertainment", "productivity"], hints: ["lifestyle", "creator", "vlog"] },
];

/**
 * Returns an absolute filesystem path so video-generator can read it directly.
 * Presenters are loaded via readFile(), not publicPathToFilePath().
 */
function selectPresenterPath(category: string, backgroundKeyword: string): string | null {
  const absDir = path.join(ASSETS_ROOT, "presenters");
  let absFiles: string[];
  try {
    absFiles = fs
      .readdirSync(absDir)
      .filter((f) => PRESENTER_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith("."))
      .map((f) => path.join(absDir, f));
  } catch {
    absFiles = [];
  }

  if (absFiles.length === 0) return null;

  const text = `${category} ${backgroundKeyword}`.toLowerCase();
  for (const { keywords, hints } of PRESENTER_KEYWORD_MAP) {
    if (keywords.some((kw) => text.includes(kw))) {
      const match = absFiles.find((f) =>
        hints.some((h) => path.basename(f).toLowerCase().includes(h))
      );
      return match ?? pickRandom(absFiles);
    }
  }

  return pickRandom(absFiles);
}

/* -------------------------------------------------------------------------- */
/* Background selection — scans both /backgrounds (images) and /videos        */
/* -------------------------------------------------------------------------- */

function selectBackground(input: AssetSelectionInput): string | null {
  // Merge static background images and video backgrounds into one pool
  const images = listDir("backgrounds", IMAGE_EXTS);
  const videos = listDir("videos", VIDEO_EXTS);
  const all = [...images, ...videos];
  return pickByHint(all, input.backgroundKeyword, input.category);
}

/* -------------------------------------------------------------------------- */
/* GIF selection                                                               */
/* -------------------------------------------------------------------------- */

function selectGif(input: AssetSelectionInput): string | null {
  const files = listDir("gifs", GIF_EXTS);
  return pickByHint(files, input.gifKeyword, input.category, input.emotion ?? "");
}

/* -------------------------------------------------------------------------- */
/* Audio selection                                                             */
/* -------------------------------------------------------------------------- */

function selectAudio(input: AssetSelectionInput): string | null {
  const files = listDir("audio", AUDIO_EXTS);
  return pickByHint(files, input.musicMood, input.category);
}

/* -------------------------------------------------------------------------- */
/* Remote asset helpers (optional, keyed by env vars)                         */
/* -------------------------------------------------------------------------- */

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function buildSearchQuery(...values: string[]) {
  return values.map(normalize).filter(Boolean).join(" ").trim();
}

async function findPexelsVideo(input: AssetSelectionInput): Promise<string | null> {
  if (!process.env.PEXELS_API_KEY) return null;
  try {
    const query = buildSearchQuery(input.backgroundKeyword, input.category);
    const response = await axios.get<{
      videos?: Array<{
        video_files?: Array<{ link?: string; height?: number }>;
      }>;
    }>("https://api.pexels.com/videos/search", {
      timeout: 10_000,
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: { query, orientation: "portrait", per_page: 3 },
    });
    const files =
      response.data.videos?.flatMap((v) => v.video_files ?? []) ?? [];
    const best = files
      .filter((f) => f.link)
      .sort((a, b) => Math.abs((a.height ?? 0) - 1920) - Math.abs((b.height ?? 0) - 1920))[0];
    return best?.link ?? null;
  } catch (error) {
    console.warn("Pexels lookup failed", { error });
    return null;
  }
}

async function findGiphyGif(input: AssetSelectionInput): Promise<string | null> {
  if (!process.env.GIPHY_API_KEY) return null;
  try {
    const query = buildSearchQuery(input.gifKeyword, input.category);
    const response = await axios.get<{
      data?: Array<{
        images?: { original?: { url?: string }; fixed_height?: { url?: string } };
      }>;
    }>("https://api.giphy.com/v1/gifs/search", {
      timeout: 10_000,
      params: { api_key: process.env.GIPHY_API_KEY, q: query, limit: 1, rating: "g" },
    });
    return (
      response.data.data?.[0]?.images?.original?.url ??
      response.data.data?.[0]?.images?.fixed_height?.url ??
      null
    );
  } catch (error) {
    console.warn("Giphy lookup failed", { error });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export async function selectGenerationAssets(
  input: AssetSelectionInput
): Promise<GenerationAssets> {
  logAssetInventory();

  const [remoteBackground, remoteGif] = await Promise.all([
    findPexelsVideo(input),
    findGiphyGif(input),
  ]);

  const localBg = selectBackground(input);
  const localGif = selectGif(input);
  const localAudio = selectAudio(input);
  const presenterPath = selectPresenterPath(input.category, input.backgroundKeyword);

  const bgPath = remoteBackground ?? localBg ?? "";
  const gifPath = remoteGif ?? localGif ?? "";
  const audioPath = localAudio ?? "";

  // Diagnostic: log what was selected (or why it was skipped)
  console.info("── Asset selection results ──────────────────────────────────");
  if (bgPath) {
    console.info(`  ✓ Background selected: ${bgPath} (${remoteBackground ? "remote" : "local"})`);
  } else {
    console.info("  ✗ Background: none found → will use gradient fallback");
  }
  if (presenterPath) {
    console.info(`  ✓ Presenter selected: ${path.basename(presenterPath)}`);
  } else {
    console.info("  ✗ Presenter: none found in public/assets/presenters/");
  }
  if (gifPath) {
    console.info(`  ✓ GIF selected: ${gifPath} (${remoteGif ? "remote" : "local"})`);
  } else {
    console.info("  ✗ GIF: none found in public/assets/gifs/");
  }
  if (audioPath) {
    console.info(`  ✓ Audio selected: ${audioPath}`);
  } else {
    console.info("  ✗ Audio: none found in public/assets/audio/ → video will have no music");
  }
  console.info("─────────────────────────────────────────────────────────────");

  return {
    background: {
      path: bgPath,
      source: remoteBackground ? "remote" : "local",
    },
    gif: {
      path: gifPath,
      source: remoteGif ? "remote" : "local",
    },
    audio: {
      path: audioPath,
      source: "local",
    },
    website: input.websiteAssets ?? { screenshotUrls: [], brandColors: [] },
    presenterPath,
  };
}
