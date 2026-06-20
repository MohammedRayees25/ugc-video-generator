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

export type SelectedAssets = {
  background: string;
  gif: string;
  audio: string;
};

export type AssetReference = {
  path: string;
  source: "local" | "remote";
};

export type GenerationAssets = {
  background: AssetReference;
  gif: AssetReference;
  audio: AssetReference;
  website: ScrapedWebsiteAssets;
};

type AssetKind = "background" | "gif" | "audio";

type AssetCandidate = {
  path: string;
  keywords: string[];
  fallback?: boolean;
};

type AssetCatalog = Record<AssetKind, AssetCandidate[]>;

const ASSET_BASE_PATHS: Record<AssetKind, string> = {
  background: "/assets/videos",
  gif: "/assets/gifs",
  audio: "/assets/audio"
};

const KEYWORD_ALIASES: Record<string, string[]> = {
  fitness: ["fitness", "gym", "workout", "health", "exercise", "training"],
  food: ["food", "healthy", "meal", "nutrition", "restaurant", "recipe"],
  productivity: [
    "productivity",
    "office",
    "work",
    "workspace",
    "business",
    "focus"
  ],
  beauty: ["beauty", "skincare", "cosmetic", "makeup", "glow"],
  fashion: ["fashion", "style", "clothing", "apparel", "outfit"],
  technology: ["technology", "tech", "app", "software", "saas", "digital"],
  ai: ["ai", "artificial", "automation", "smart", "assistant", "chatbot"],
  finance: ["finance", "money", "wealth", "banking", "investing"],
  education: ["education", "learning", "course", "student", "study"],
  gaming: ["gaming", "game", "stream", "esports", "play"],
  travel: ["travel", "hotel", "trip", "vacation", "destination"],
  reaction: ["reaction", "meme", "laugh", "funny", "wow"],
  mindblown: ["mindblown", "wow", "shocked", "surprise"],
  arrow: ["arrow", "pointer", "click", "tap", "cursor"],
  money: ["money", "finance", "cash", "deal", "sale"],
  warning: ["warning", "alert", "problem", "pain"],
  success: ["success", "win", "done", "checkmark"],
  calm: ["calm", "soft", "ambient", "minimal", "relaxed"],
  upbeat: ["upbeat", "happy", "bright", "energetic", "fun"],
  cinematic: ["cinematic", "premium", "dramatic", "emotional", "story"]
};

const DEFAULT_CATALOG: AssetCatalog = {
  background: [
    asset("background", "gym.mp4", ["fitness", "gym", "workout", "training"]),
    asset("background", "healthy-food.mp4", ["food", "healthy", "meal"]),
    asset("background", "office.mp4", ["productivity", "office", "business"]),
    asset("background", "beauty-routine.mp4", ["beauty", "skincare", "glow"]),
    asset("background", "fashion-studio.mp4", ["fashion", "style", "apparel"]),
    asset("background", "phone-app.mp4", ["technology", "app", "software"]),
    asset("background", "phone-app.mp4", ["ai", "assistant", "automation"]),
    asset("background", "office.mp4", ["finance", "education", "productivity"]),
    asset("background", "lifestyle.mp4", ["travel", "gaming", "creator"]),
    asset("background", "lifestyle.mp4", ["lifestyle", "creator"], true)
  ],
  gif: [
    asset("gif", "sparkle.gif", ["beauty", "premium", "wow"]),
    asset("gif", "fire.gif", ["viral", "hot", "energetic", "fitness", "wow"]),
    asset("gif", "checkmark.gif", ["productivity", "success", "benefit", "checkmark"]),
    asset("gif", "heart.gif", ["food", "beauty", "lifestyle", "love", "laugh"]),
    asset("gif", "cursor-click.gif", ["technology", "app", "software", "arrow", "ai"]),
    asset("gif", "sparkle.gif", ["mindblown", "reaction", "wow"]),
    asset("gif", "thumbs-up.gif", ["general", "positive"], true)
  ],
  audio: [
    asset("audio", "upbeat-pop.mp3", ["upbeat", "happy", "energetic"]),
    asset("audio", "ambient-calm.mp3", ["calm", "soft", "minimal"]),
    asset("audio", "cinematic-pulse.mp3", ["cinematic", "premium", "dramatic"]),
    asset("audio", "lofi-focus.mp3", ["productivity", "office", "focus"]),
    asset("audio", "bright-commercial.mp3", ["general", "commercial"], true)
  ]
};

function asset(
  kind: AssetKind,
  filename: string,
  keywords: string[],
  fallback = false
): AssetCandidate {
  return {
    path: `${ASSET_BASE_PATHS[kind]}/${filename}`,
    keywords,
    fallback
  };
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function tokenize(...values: string[]) {
  const tokens = new Set<string>();

  for (const value of values) {
    for (const token of normalize(value).split(" ")) {
      if (token.length >= 2) {
        tokens.add(token);
      }
    }
  }

  return tokens;
}

function expandTokens(tokens: Set<string>) {
  const expanded = new Set(tokens);

  for (const token of tokens) {
    for (const alias of KEYWORD_ALIASES[token] ?? []) {
      expanded.add(alias);
    }
  }

  return expanded;
}

function scoreCandidate(candidate: AssetCandidate, queryTokens: Set<string>) {
  const candidateTokens = expandTokens(tokenize(candidate.path, ...candidate.keywords));
  let score = candidate.fallback ? 0.1 : 0;

  for (const token of queryTokens) {
    if (candidateTokens.has(token)) {
      score += 3;
    }

    for (const candidateToken of candidateTokens) {
      if (candidateToken.includes(token) || token.includes(candidateToken)) {
        score += 0.75;
      }
    }
  }

  return score;
}

function selectAsset(candidates: AssetCandidate[], queryTokens: Set<string>) {
  const rankedCandidates = candidates
    .map((candidate) => ({
      candidate,
      score: scoreCandidate(candidate, queryTokens)
    }))
    .sort((left, right) => right.score - left.score);

  const topCandidates = rankedCandidates.filter(
    (entry) => entry.score > 0.1 && entry.score >= rankedCandidates[0]?.score - 1.5
  );
  const bestMatch =
    topCandidates[Math.floor(Math.random() * topCandidates.length)] ??
    rankedCandidates[0];

  if (bestMatch && bestMatch.score > 0.1) {
    return bestMatch.candidate.path;
  }

  return (
    candidates.find((candidate) => candidate.fallback)?.path ??
    candidates[0]?.path ??
    ""
  );
}

export function selectAssets(
  input: AssetSelectionInput,
  catalog: AssetCatalog = DEFAULT_CATALOG
): SelectedAssets {
  const sharedTokens = expandTokens(
    tokenize(
      input.category,
      input.backgroundKeyword,
      input.gifKeyword,
      input.musicMood,
      input.emotion ?? ""
    )
  );
  const backgroundTokens = expandTokens(
    tokenize(input.category, input.backgroundKeyword)
  );
  const gifTokens = expandTokens(
    tokenize(input.category, input.gifKeyword, input.emotion ?? "")
  );
  const audioTokens = expandTokens(tokenize(input.category, input.musicMood));

  return {
    background: selectAsset(catalog.background, new Set([...sharedTokens, ...backgroundTokens])),
    gif: selectAsset(catalog.gif, new Set([...sharedTokens, ...gifTokens])),
    audio: selectAsset(catalog.audio, new Set([...sharedTokens, ...audioTokens]))
  };
}

function buildSearchQuery(...values: string[]) {
  return values
    .map(normalize)
    .filter(Boolean)
    .join(" ")
    .trim();
}

async function findPexelsVideo(input: AssetSelectionInput) {
  if (!process.env.PEXELS_API_KEY) {
    return null;
  }

  try {
    const query = buildSearchQuery(input.backgroundKeyword, input.category);
    const response = await axios.get<{
      videos?: Array<{
        video_files?: Array<{
          link?: string;
          width?: number;
          height?: number;
          quality?: string;
        }>;
      }>;
    }>("https://api.pexels.com/videos/search", {
      timeout: 10_000,
      headers: {
        Authorization: process.env.PEXELS_API_KEY
      },
      params: {
        query,
        orientation: "portrait",
        per_page: 3
      }
    });

    const files =
      response.data.videos?.flatMap((video) => video.video_files ?? []) ?? [];
    const bestFile = files
      .filter((file) => file.link)
      .sort((left, right) => {
        const leftScore = Math.abs((left.height ?? 0) - 1920);
        const rightScore = Math.abs((right.height ?? 0) - 1920);

        return leftScore - rightScore;
      })[0];

    return bestFile?.link ?? null;
  } catch (error) {
    console.warn("Pexels asset lookup failed", { error });
    return null;
  }
}

async function findGiphyGif(input: AssetSelectionInput) {
  if (!process.env.GIPHY_API_KEY) {
    return null;
  }

  try {
    const query = buildSearchQuery(input.gifKeyword, input.category);
    const response = await axios.get<{
      data?: Array<{
        images?: {
          original?: { url?: string };
          fixed_height?: { url?: string };
        };
      }>;
    }>("https://api.giphy.com/v1/gifs/search", {
      timeout: 10_000,
      params: {
        api_key: process.env.GIPHY_API_KEY,
        q: query,
        limit: 1,
        rating: "g"
      }
    });

    return (
      response.data.data?.[0]?.images?.original?.url ??
      response.data.data?.[0]?.images?.fixed_height?.url ??
      null
    );
  } catch (error) {
    console.warn("Giphy asset lookup failed", { error });
    return null;
  }
}

export async function selectGenerationAssets(
  input: AssetSelectionInput,
  catalog?: AssetCatalog
): Promise<GenerationAssets> {
  const localAssets = selectAssets(input, catalog);
  const [remoteBackground, remoteGif] = await Promise.all([
    findPexelsVideo(input),
    findGiphyGif(input)
  ]);

  return {
    background: {
      path: remoteBackground ?? localAssets.background,
      source: remoteBackground ? "remote" : "local"
    },
    gif: {
      path: remoteGif ?? localAssets.gif,
      source: remoteGif ? "remote" : "local"
    },
    audio: {
      path: localAssets.audio,
      source: "local"
    },
    website: input.websiteAssets ?? {
      screenshotUrls: [],
      brandColors: []
    }
  };
}
