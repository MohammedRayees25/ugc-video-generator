import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductAnalysis } from "@/features/chat/types/chat";
import type { AssetReference, GenerationAssets } from "@/lib/assets";

export type GeneratedVideo = {
  videoPath: string;
  duration: number;
  filename: string;
};

const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const SAFE_X = 80;
const DOWNLOAD_TIMEOUT_MS = 18_000;
// Use generic CSS font families that librsvg/Pango resolves from the system's
// fontconfig even without specific named fonts installed (Vercel Lambda, Docker).
// Caption font — we bundle LiberationSans-Bold.ttf alongside the app so resvg
// can render it identically on every platform (Mac, Linux, Vercel Lambda).
// Do NOT rely on system fonts: their availability varies by OS and server image.
const FONT_FAMILY = "Liberation Sans";

// Candidate directories where the bundled TTFs may live at runtime. On Vercel
// the function bundle layout differs from local dev, so we probe several roots
// instead of assuming a single location. The first directory that actually
// contains the font files wins.
const FONT_DIR_CANDIDATES = [
  path.join(process.cwd(), "public", "fonts"),
  path.join(process.cwd(), ".next", "server", "public", "fonts"),
  path.join(__dirname, "..", "public", "fonts"),
  path.join(__dirname, "public", "fonts"),
  "/var/task/public/fonts",
];

const FONT_FILE_NAMES = ["LiberationSans-Bold.ttf", "LiberationSans-Regular.ttf"];

type LoadedFonts = { buffers: Buffer[]; files: string[] };

/** Lazily loaded fonts for resvg (loaded once, reused across requests). */
let _fonts: LoadedFonts | null = null;
async function getFonts(): Promise<LoadedFonts> {
  if (_fonts) return _fonts;

  const files: string[] = [];
  for (const dir of FONT_DIR_CANDIDATES) {
    const found = FONT_FILE_NAMES
      .map((name) => path.join(dir, name))
      .filter(existsSync);
    if (found.length > 0) {
      files.push(...found);
      break;
    }
  }

  if (files.length === 0) {
    console.warn(
      "  ⚠ No bundled fonts found in any candidate dir — resvg will fall back to system fonts. " +
      `Searched: ${FONT_DIR_CANDIDATES.join(", ")}`
    );
    _fonts = { buffers: [], files: [] };
  } else {
    const buffers = await Promise.all(files.map((f) => readFile(f)));
    console.info(`  ✓ Loaded ${files.length} bundled font(s): ${files.map((f) => path.basename(f)).join(", ")}`);
    _fonts = { buffers, files };
  }
  return _fonts;
}

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm"]);

export class VideoGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoGenerationError";
  }
}

/* -------------------------------------------------------------------------- */
/* FFmpeg discovery                                                           */
/* -------------------------------------------------------------------------- */

function getFfmpegExecutablePath(): string {
  // 1. Honour an explicit override (useful for custom Vercel/Docker setups)
  if (process.env.FFMPEG_PATH) {
    const override = process.env.FFMPEG_PATH;
    console.log("FFmpeg Path (env override):", override);
    console.log("Platform:", process.platform);
    console.log("Architecture:", process.arch);
    console.log("Exists:", existsSync(override));
    if (existsSync(override)) return override;
    console.warn("FFMPEG_PATH override does not exist, continuing search...");
  }

  // 2. Ask ffmpeg-static — this is the canonical resolver and works on Vercel
  //    when outputFileTracingIncludes copies the binary into /var/task.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ffmpegStatic: string | null = require("ffmpeg-static");
  console.log("FFmpeg Path:", ffmpegStatic);
  console.log("Platform:", process.platform);
  console.log("Architecture:", process.arch);
  console.log("Exists:", ffmpegStatic ? existsSync(ffmpegStatic) : false);

  if (ffmpegStatic && existsSync(ffmpegStatic)) {
    console.log("✓ FFmpeg binary found:", ffmpegStatic);
    return ffmpegStatic;
  }

  // 3. Fallback: scan common Linux binary locations (Vercel Lambda layer, PATH)
  const linuxCandidates = [
    "/usr/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/opt/bin/ffmpeg",
    "/tmp/ffmpeg",
  ];
  for (const candidate of linuxCandidates) {
    if (existsSync(candidate)) {
      console.log("✓ FFmpeg binary found (system):", candidate);
      return candidate;
    }
  }

  throw new VideoGenerationError(
    `FFmpeg executable was not found. Searched: ffmpeg-static (${ffmpegStatic ?? "null"}), ${linuxCandidates.join(", ")}. ` +
    `Set the FFMPEG_PATH environment variable to the binary location.`
  );
}

function publicPathToFilePath(publicPath: string) {
  return path.join(process.cwd(), "public", publicPath.replace(/^\//, ""));
}

function toFfmpegPath(filePath: string) {
  return process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function fmt(value: number) {
  return Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
}

function pickRandom<T>(values: T[], fallback: T): T {
  if (values.length === 0) {
    return fallback;
  }

  return values[Math.floor(Math.random() * values.length)] ?? fallback;
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function sanitizeHexColor(value: string | undefined, fallback: string) {
  if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return value;
  }

  return fallback;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Strip characters the bundled fonts cannot render (emoji, pictographs, control
 * characters) while keeping readable Latin copy. This keeps captions clean
 * instead of rendering "tofu" boxes.
 */
function sanitizeCaption(value: string) {
  return value
    .normalize("NFKD")
    .replace(
      /[\u{1F000}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{200D}]/gu,
      ""
    )
    .replace(/\s+/g, " ")
    .trim();
}

function limitWords(value: string, maxWords: number) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function prepareCaption(value: string, fallback: string, maxWords: number) {
  const cleaned = sanitizeCaption(value || "");
  const limited = limitWords(cleaned, maxWords);

  return limited || sanitizeCaption(fallback);
}

function wrapText(text: string, maxChars: number) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    if (!current) {
      current = word;
    } else if (`${current} ${word}`.length <= maxChars) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [text];
}

/**
 * Auto-fit text into a fixed-width box without ever truncating it.
 *
 * Root-cause fix: the previous pipeline used a FIXED font size (e.g. 116px) and
 * a hard `slice(0, maxLines)`. Long hooks like "Me pretending I don't need
 * Notion at 2am" wrapped to 4+ lines and the slice silently dropped the
 * punchline. Here we instead shrink the font until the whole string fits inside
 * `maxLines`, so every word is always visible and readable.
 *
 * Returns the chosen font size plus the wrapped lines.
 */
function fitText(
  text: string,
  boxInnerWidth: number,
  maxLines: number,
  maxFontSize: number,
  minFontSize: number,
  charWidthRatio = 0.56
): { fontSize: number; lines: string[]; lineHeight: number } {
  for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 2) {
    const approxCharWidth = fontSize * charWidthRatio;
    const maxChars = Math.max(4, Math.floor(boxInnerWidth / approxCharWidth));
    const lines = wrapText(text, maxChars);
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    if (lines.length <= maxLines && longest <= maxChars) {
      return { fontSize, lines, lineHeight: Math.round(fontSize * 1.18) };
    }
  }
  // Floor: accept the smallest size and wrap as best we can (still no slicing).
  const approxCharWidth = minFontSize * charWidthRatio;
  const maxChars = Math.max(4, Math.floor(boxInnerWidth / approxCharWidth));
  const lines = wrapText(text, maxChars);
  return { fontSize: minFontSize, lines, lineHeight: Math.round(minFontSize * 1.18) };
}

/* -------------------------------------------------------------------------- */
/* Visual theme + copy                                                        */
/* -------------------------------------------------------------------------- */

type VisualTheme = {
  brandColor: string;
  accentColor: string;
  gradientStart: string;
  gradientEnd: string;
  glowColor: string;
};

// Deep, neutral dark backgrounds — Apple / Notion / Linear palette
const GRADIENT_PRESETS: Array<{ start: string; end: string }> = [
  { start: "#0f172a", end: "#020617" }, // deep navy
  { start: "#111827", end: "#030712" }, // near-black slate
  { start: "#0c1445", end: "#020308" }, // midnight blue
  { start: "#12101f", end: "#050308" }, // deep indigo
  { start: "#0d1a0d", end: "#020702" }, // deep forest
  { start: "#1a1024", end: "#060208" }, // deep plum
  { start: "#141414", end: "#050505" }, // neutral charcoal
];

function getVisualTheme(analysis: ProductAnalysis, assets: GenerationAssets): VisualTheme {
  const category = analysis.category.toLowerCase();
  // Prefer the brand's own color; muted palette fallbacks per category
  const brandColor = sanitizeHexColor(
    pickRandom(assets.website.brandColors, ""),
    "#6366f1"
  );
  // Muted, professional accent colors — no neons
  const accentColor =
    category.includes("finance") || category.includes("ai") || category.includes("tech")
      ? "#60a5fa"  // calm blue
      : category.includes("beauty") || category.includes("fashion")
        ? "#c084fc"  // soft lavender
        : category.includes("food") || category.includes("fitness")
          ? "#34d399"  // soft green
          : sanitizeHexColor(brandColor, "#60a5fa");

  const preset = pickRandom(GRADIENT_PRESETS, GRADIENT_PRESETS[0]);

  return {
    brandColor,
    accentColor,
    gradientStart: preset.start,
    gradientEnd: preset.end,
    glowColor: accentColor
  };
}

type SceneCopy = {
  hook: string;
  productName: string;
  featureOne: string;
  featureTwo: string;
  cta: string;
};

/**
 * Picks the most viral hook for the video.
 * Prefers AI-generated hookVariations, then falls back to 20+ proven UGC templates.
 */
function pickFunnyHook(analysis: ProductAnalysis): string {
  const aiHooks = [...(analysis.hookVariations ?? []), analysis.viralHook].filter(Boolean);
  if (aiHooks.length > 0) return pickRandom(aiHooks, aiHooks[0]);

  const name = sanitizeCaption(analysis.productName) || "this";
  const benefit = sanitizeCaption(analysis.mainBenefits?.[0] ?? "") || "this";
  const audience = sanitizeCaption(analysis.targetAudience ?? "") || "everyone";

  // 20 TikTok/Reels hooks — max 8 words, punchy, covers funny + shocking sentiments
  const templates = [
    // discovery / shocking
    `Nobody told me this existed`,
    `I wish I knew this sooner`,
    `Stop scrolling. You need this`,
    `Wait... this actually works`,
    `Why is nobody talking about ${name}`,
    `This app is actually insane`,
    `This changes everything`,
    `Nobody warned me about ${name}`,
    // POV / relatable
    `POV: You finally found ${name}`,
    `POV: discovering ${name} in 2025`,
    // funny / self-aware
    `Me pretending I don't need ${name}`,
    `Not me finding ${name} at 2am`,
    `I tried ${name} so you don't have to`,
    `Me after discovering ${name}`,
    // benefit-led
    `${name} just saved me hours`,
    `${benefit} and I cannot stop`,
    `Every ${audience} needs to know this`,
    // credibility / trust
    `Honest review of ${name}`,
    `I tested ${name} for 30 days`,
    `This is my honest ${name} review`,
  ];
  return pickRandom(templates, templates[0]);
}

function buildSceneCopy(analysis: ProductAnalysis): SceneCopy {
  const features = [
    ...analysis.featureCaptions,
    ...analysis.mainBenefits,
    analysis.caption
  ].filter(Boolean);
  const featureOne = pickRandom(features, analysis.caption);
  const remainingFeatures = features.filter((f) => f !== featureOne);

  const productNameClean = prepareCaption(analysis.productName, "This product", 5);

  // Creator-style CTAs — short, punchy, TikTok/Reels convention
  const ctaOptions = [
    `Link in bio`,
    `Try ${productNameClean} today`,
    `Get ${productNameClean} now`,
    `Available now`,
    `Start free today`,
    `Download now`,
    `Try it today`,
    ...analysis.ctaCaptions,
  ].filter(Boolean);

  return {
    hook: prepareCaption(pickFunnyHook(analysis), analysis.viralHook, 8),
    productName: productNameClean,
    featureOne: prepareCaption(featureOne, analysis.caption, 8),
    featureTwo: prepareCaption(
      pickRandom(remainingFeatures, analysis.mainBenefits[0] ?? analysis.productName),
      analysis.productName,
      8
    ),
    cta: prepareCaption(pickRandom(ctaOptions, ctaOptions[0]), analysis.cta, 7)
  };
}

/* -------------------------------------------------------------------------- */
/* Hook sentiment → presenter / GIF selection                                 */
/* -------------------------------------------------------------------------- */

type HookSentiment = "funny" | "shocking" | "neutral";

function classifyHookSentiment(hook: string): HookSentiment {
  const lower = hook.toLowerCase();
  const funnySignals = [
    "pretending", "2am", "not me", "me when", "caught me", "lol", "haha",
    "pov:", "me after", "so you don't", "30 days"
  ];
  const shockSignals = [
    "nobody told", "wish i knew", "stop scrolling", "wait...", "wait until",
    "surprised", "nobody talking", "this existed", "nobody warned",
    "actually insane", "changes everything", "actually works"
  ];
  if (funnySignals.some((s) => lower.includes(s))) return "funny";
  if (shockSignals.some((s) => lower.includes(s))) return "shocking";
  return "neutral";
}

/* -------------------------------------------------------------------------- */
/* Sharp-based asset rendering (caption cards, backgrounds, images)           */
/* -------------------------------------------------------------------------- */

type ImageAsset = {
  path: string;
  width: number;
  height: number;
  isVideo?: boolean;
};

/**
 * Render an SVG string to a PNG using @resvg/resvg-js (Rust-based renderer).
 *
 * Why resvg instead of Sharp/librsvg:
 *   • Sharp relies on the system's librsvg + Pango + fontconfig stack. On many
 *     servers (Vercel Lambda, Docker minimal images, non-Linux OSes) this stack
 *     either isn't installed or can't find the requested fonts, causing text to
 *     render as tiny fallback glyphs ("dashes").
 *   • resvg is a pure-Rust SVG renderer bundled as a native Node addon. We
 *     supply font files explicitly via `fontBuffers`, so rendering is identical
 *     on every platform — no system fonts required.
 */
async function svgToPng(svg: string, outputPath: string, debugName?: string): Promise<ImageAsset> {
  const { buffers, files } = await getFonts();

  // Supply fonts to resvg three redundant ways so text ALWAYS renders correctly
  // regardless of platform:
  //   • fontBuffers — honoured by the native addon (verified at runtime), works
  //     even when the TS types for this version omit the field.
  //   • fontFiles   — absolute paths, the documented/stable API.
  //   • defaultFontFamily / sansSerifFamily — map any unresolved family to our
  //     bundled font so a caption can never fall back to an absent system font.
  // `loadSystemFonts` is disabled when we have our own fonts (deterministic) and
  // only enabled as a last resort when nothing bundled was found.
  const haveFonts = buffers.length > 0 || files.length > 0;
  type ResvgFontOpts = {
    fontBuffers?: Buffer[];
    fontFiles?: string[];
    loadSystemFonts?: boolean;
    defaultFontFamily?: string;
    serifFamily?: string;
    sansSerifFamily?: string;
  };
  const fontOpts: ResvgFontOpts = {
    fontBuffers: buffers,
    fontFiles: files,
    loadSystemFonts: !haveFonts,
    defaultFontFamily: FONT_FAMILY,
    sansSerifFamily: FONT_FAMILY,
  };
  const resvg = new Resvg(svg, {
    font: fontOpts as unknown as NonNullable<ConstructorParameters<typeof Resvg>[1]>["font"],
    fitTo: { mode: "original" },
  });

  const rendered = resvg.render();
  const buffer = rendered.asPng();
  const w = rendered.width;
  const h = rendered.height;

  console.info(`  svgToPng[${debugName ?? "card"}]: ${w}×${h} → ${path.basename(outputPath)}`);

  // Save SVG/PNG debug copies in non-production.
  if (debugName && process.env.NODE_ENV !== "production") {
    try {
      const debugDir = path.join(tmpdir(), "ugc-debug");
      await mkdir(debugDir, { recursive: true });
      await writeFile(path.join(debugDir, `${debugName}.svg`), svg);
      await writeFile(path.join(debugDir, `${debugName}.png`), buffer);
    } catch { /* non-fatal */ }
  }

  await writeFile(outputPath, buffer);

  return { path: outputPath, width: w, height: h };
}

type CardStyle = "glass" | "accent" | "outline" | "pill";

type CardOptions = {
  text: string;
  /** Total card width in px. Text auto-fits within this minus horizontal padding. */
  width: number;
  /** Largest font size to try; the renderer shrinks until the text fits maxLines. */
  maxFontSize: number;
  /** Smallest acceptable font size (readability floor). */
  minFontSize: number;
  maxLines: number;
  align: "center" | "left";
  style: CardStyle;
  theme: VisualTheme;
  workDir: string;
};

// Liberation Sans Bold mixed-case advance width ≈ 0.55em. 0.58 leaves a small
// safety margin so lines never clip the card edge.
const BOLD_CHAR_RATIO = 0.58;

async function renderCaptionCard(options: CardOptions): Promise<ImageAsset | null> {
  const text = sanitizeCaption(options.text);
  if (!text) return null;

  const { width, align, style, theme, workDir } = options;
  const padX = style === "outline" ? 20 : style === "pill" ? 44 : 56;
  const padY = style === "outline" ? 14 : style === "pill" ? 24 : 40;
  const innerWidth = width - padX * 2;

  // Auto-fit: shrink the font until the whole caption fits — never truncate.
  const { fontSize, lines, lineHeight } = fitText(
    text,
    innerWidth,
    options.maxLines,
    options.maxFontSize,
    options.minFontSize,
    BOLD_CHAR_RATIO
  );

  const boxHeight = lines.length * lineHeight + padY * 2;
  const boxWidth = width;
  console.info(`  renderCaptionCard: style=${style} fit=${fontSize}px width=${boxWidth} lines=${lines.length} boxH=${boxHeight} text="${text.slice(0, 36)}"`);
  console.info(`    lines: ${JSON.stringify(lines)}`);

  const out = path.join(workDir, `card-${randomUUID().slice(0, 8)}.png`);

  // ── OUTLINE (hook) — TikTok caption: bold white text, thick black outline ──
  // No box: the heavy outline + soft drop-shadow keep it readable on ANY frame.
  if (style === "outline") {
    const strokeW = Math.max(14, Math.round(fontSize * 0.20));
    const margin = strokeW + 28; // keep the thick stroke + shadow inside the viewport
    const svgWidth = boxWidth + margin * 2;
    const svgHeight = boxHeight + margin * 2 + 8;
    const textX = align === "center" ? margin + boxWidth / 2 : margin + padX;
    const anchor = align === "center" ? "middle" : "start";
    const firstBaseline = margin + padY + Math.round(fontSize * 0.80);

    const tspans = lines
      .map((line, i) => `<tspan x="${textX}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
      .join("");

    // Layer order (painter's algorithm — no SVG filters, librsvg-safe):
    //   1) soft drop shadow   2) thick black outline   3) white fill on top.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
  <text x="${textX + 3}" y="${firstBaseline + 6}"
        font-family="${FONT_FAMILY}" font-weight="900" font-size="${fontSize}px"
        fill="#000000" fill-opacity="0.55"
        stroke="#000000" stroke-opacity="0.55" stroke-width="${strokeW}"
        stroke-linejoin="round" stroke-linecap="round" text-anchor="${anchor}">${tspans}</text>
  <text x="${textX}" y="${firstBaseline}"
        font-family="${FONT_FAMILY}" font-weight="900" font-size="${fontSize}px"
        fill="#000000" stroke="#000000" stroke-width="${strokeW}"
        stroke-linejoin="round" stroke-linecap="round" text-anchor="${anchor}">${tspans}</text>
  <text x="${textX}" y="${firstBaseline}"
        font-family="${FONT_FAMILY}" font-weight="900" font-size="${fontSize}px"
        fill="#ffffff" stroke="none" text-anchor="${anchor}">${tspans}</text>
</svg>`;

    try {
      const asset = await svgToPng(svg, out, "hook");
      console.info(`  ✓ Hook card: "${text.slice(0, 40)}" fit=${fontSize} stroke=${strokeW} size=${asset.width}×${asset.height}`);
      return asset;
    } catch (error) {
      console.warn("Hook card rendering failed; skipping", { text, error });
      return null;
    }
  }

  // ── GLASS (feature) / ACCENT (CTA) — rounded card, bold white text ────────
  if (style === "glass" || style === "accent") {
    const margin = 30;
    const svgWidth = boxWidth + margin * 2;
    const svgHeight = boxHeight + margin * 2;
    const textX = align === "center" ? margin + boxWidth / 2 : margin + padX;
    const anchor = align === "center" ? "middle" : "start";
    const firstBaseline = margin + padY + Math.round(fontSize * 0.80);
    const radius = Math.min(48, Math.round(boxHeight / 2.6));

    const tspans = lines
      .map((line, i) => `<tspan x="${textX}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
      .join("");

    const isAccent = style === "accent";
    const bgStop1 = isAccent ? theme.accentColor : "#161a24";
    const bgStop2 = isAccent ? theme.brandColor : "#0a0d14";
    // CTA gets a slightly heavier outline so it pops; feature uses a thin one.
    const stroke = isAccent ? Math.max(6, Math.round(fontSize * 0.07)) : Math.max(3, Math.round(fontSize * 0.04));
    // Accent-colored left accent bar on the feature card for a designed look.
    const accentBar = !isAccent
      ? `<rect x="${margin}" y="${margin + 14}" width="10" height="${boxHeight - 28}" rx="5" ry="5" fill="${theme.accentColor}"/>`
      : "";

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
  <defs>
    <linearGradient id="cardbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${bgStop1}" stop-opacity="${isAccent ? "0.98" : "0.94"}"/>
      <stop offset="1" stop-color="${bgStop2}" stop-opacity="0.98"/>
    </linearGradient>
  </defs>
  <rect x="${margin}" y="${margin}" rx="${radius}" ry="${radius}"
        width="${boxWidth}" height="${boxHeight}" fill="url(#cardbg)"/>
  <rect x="${margin}" y="${margin}" rx="${radius}" ry="${radius}"
        width="${boxWidth}" height="${boxHeight}"
        fill="none" stroke="#ffffff" stroke-width="2" stroke-opacity="0.16"/>
  ${accentBar}
  <text x="${textX}" y="${firstBaseline}"
        font-family="${FONT_FAMILY}" font-weight="900" font-size="${fontSize}px"
        fill="#000000" stroke="#000000" stroke-width="${stroke}"
        stroke-linejoin="round" text-anchor="${anchor}">${tspans}</text>
  <text x="${textX}" y="${firstBaseline}"
        font-family="${FONT_FAMILY}" font-weight="900" font-size="${fontSize}px"
        fill="#ffffff" stroke="none" text-anchor="${anchor}">${tspans}</text>
</svg>`;

    try {
      const asset = await svgToPng(svg, out, isAccent ? "cta" : "feature");
      console.info(`  ✓ Caption card (${style}): "${text.slice(0, 40)}" fit=${fontSize} size=${asset.width}×${asset.height}`);
      return asset;
    } catch (error) {
      console.warn("Caption card rendering failed; skipping", { text, error });
      return null;
    }
  }

  // ── PILL (product name) — accent pill, single line, leading check mark ─────
  if (style === "pill") {
    const margin = 28;
    const svgWidth = boxWidth + margin * 2;
    const svgHeight = boxHeight + margin * 2;
    const textX = margin + boxWidth / 2;
    const firstBaseline = margin + padY + Math.round(fontSize * 0.80);
    const tspan = `<tspan x="${textX}" dy="0">${escapeXml(lines[0])}</tspan>`;

    const pillSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
  <rect x="${margin}" y="${margin}" rx="${Math.round(boxHeight / 2)}" ry="${Math.round(boxHeight / 2)}"
        width="${boxWidth}" height="${boxHeight}" fill="${theme.accentColor}" fill-opacity="0.96"/>
  <text x="${textX}" y="${firstBaseline}"
        font-family="${FONT_FAMILY}" font-weight="900" font-size="${fontSize}px"
        fill="#ffffff" stroke="none" text-anchor="middle">${tspan}</text>
</svg>`;
    try {
      return await svgToPng(pillSvg, out, "pill");
    } catch (error) {
      console.warn("Caption card rendering failed; skipping", { text, error });
      return null;
    }
  }

  return null;
}

async function renderGradientBackground(
  theme: VisualTheme,
  workDir: string
): Promise<ImageAsset> {
  const angle = Math.random();
  const glowX = randomBetween(0.2, 0.8).toFixed(2);
  const glowY = randomBetween(0.15, 0.45).toFixed(2);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${OUTPUT_WIDTH}" height="${OUTPUT_HEIGHT}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="${angle.toFixed(2)}" y2="1">
        <stop offset="0" stop-color="${theme.gradientStart}"/>
        <stop offset="1" stop-color="${theme.gradientEnd}"/>
      </linearGradient>
      <radialGradient id="glow" cx="${glowX}" cy="${glowY}" r="0.7">
        <stop offset="0" stop-color="${theme.glowColor}" stop-opacity="0.5"/>
        <stop offset="1" stop-color="${theme.glowColor}" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
        <stop offset="0.55" stop-color="#000000" stop-opacity="0"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.45"/>
      </radialGradient>
    </defs>
    <rect width="${OUTPUT_WIDTH}" height="${OUTPUT_HEIGHT}" fill="url(#bg)"/>
    <rect width="${OUTPUT_WIDTH}" height="${OUTPUT_HEIGHT}" fill="url(#glow)"/>
    <rect width="${OUTPUT_WIDTH}" height="${OUTPUT_HEIGHT}" fill="url(#vignette)"/>
  </svg>`;

  return svgToPng(svg, path.join(workDir, `bg-${randomUUID().slice(0, 8)}.png`));
}

/* -------------------------------------------------------------------------- */
/* Presenter overlay (loads from absolute file path)                          */
/* -------------------------------------------------------------------------- */

async function renderPresenter(
  presenterPath: string | null,
  workDir: string
): Promise<ImageAsset | null> {
  if (!presenterPath || !existsSync(presenterPath)) return null;
  const ext = path.extname(presenterPath).toLowerCase();
  if (VIDEO_EXTS.has(ext)) {
    // Video presenter (e.g. green-screen MP4): pass straight to FFmpeg.
    // Chromakey + scaling happen in the filter graph, not here.
    // Use target dimensions for overlay position math — actual size set by scale filter.
    console.info(`  ✓ Presenter is a video file (${ext}) — will apply chromakey in FFmpeg`);
    return { path: presenterPath, width: 460, height: 860, isVideo: true };
  }
  try {
    const buffer = await readFile(presenterPath);
    const asset = await rasterizeImageAsset(buffer, {
      maxWidth: 460,
      maxHeight: 860,
      workDir,
      rounded: false
    });
    return asset ? { ...asset, isVideo: false } : null;
  } catch (error) {
    console.warn("Presenter rendering failed; skipping", { error });
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Remote/local image acquisition + rasterization                            */
/* -------------------------------------------------------------------------- */

async function loadAssetBuffer(reference: {
  path: string;
  source: "local" | "remote";
}): Promise<Buffer | null> {
  if (!reference.path || !reference.path.trim()) {
    return null;
  }

  try {
    if (reference.source === "remote") {
      const response = await axios.get<ArrayBuffer>(reference.path, {
        responseType: "arraybuffer",
        timeout: DOWNLOAD_TIMEOUT_MS,
        maxRedirects: 5,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; UGCVideoGenerator/1.0; +https://example.com/bot)"
        }
      });

      return Buffer.from(response.data);
    }

    const filePath = publicPathToFilePath(reference.path);

    if (!existsSync(filePath)) {
      return null;
    }

    return await readFile(filePath);
  } catch (error) {
    console.warn("Asset download failed; continuing without it", {
      path: reference.path,
      source: reference.source,
      error
    });

    return null;
  }
}

async function fetchRemoteImageBuffer(rawUrl: string | undefined): Promise<Buffer | null> {
  if (!rawUrl) {
    return null;
  }

  return loadAssetBuffer({ path: rawUrl, source: "remote" });
}

function firstDefined(values: Array<string | undefined>) {
  return values.find((value) => Boolean(value && value.trim()));
}

/**
 * Convert any downloaded image (SVG, WebP, AVIF, JPEG, ...) into a rounded PNG
 * that FFmpeg can overlay. SVGs are rasterized via librsvg. Returns null on any
 * failure so rendering can continue without the asset.
 */
async function rasterizeImageAsset(
  buffer: Buffer | null,
  options: {
    maxWidth: number;
    maxHeight: number;
    workDir: string;
    rounded?: boolean;
    radius?: number;
  }
): Promise<ImageAsset | null> {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  try {
    const resizedBuffer = await sharp(buffer, { density: 240 })
      .resize(options.maxWidth, options.maxHeight, {
        fit: "inside",
        withoutEnlargement: false
      })
      .png()
      .toBuffer();

    const metadata = await sharp(resizedBuffer).metadata();
    const width = metadata.width ?? options.maxWidth;
    const height = metadata.height ?? options.maxHeight;

    let finalBuffer = resizedBuffer;

    if (options.rounded) {
      const radius = options.radius ?? 36;
      const mask = Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="#fff"/></svg>`
      );

      finalBuffer = await sharp(resizedBuffer)
        .composite([{ input: mask, blend: "dest-in" }])
        .png()
        .toBuffer();
    }

    const outputPath = path.join(
      options.workDir,
      `img-${randomUUID().slice(0, 8)}.png`
    );

    await writeFile(outputPath, finalBuffer);

    return { path: outputPath, width, height };
  } catch (error) {
    console.warn("Image rasterization failed; skipping asset", { error });

    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Background / GIF / audio inputs                                            */
/* -------------------------------------------------------------------------- */

type PreparedInput = {
  input: string;
  inputOptions: string[];
  cleanup?: string;
};

type BackgroundInput = PreparedInput & { isVideo: boolean };

async function prepareBackground(
  asset: AssetReference,
  theme: VisualTheme,
  workDir: string,
  duration: number
): Promise<BackgroundInput> {
  try {
    let filePath: string | null = null;

    if (asset.source === "remote") {
      const buffer = await loadAssetBuffer(asset);

      if (buffer && buffer.length > 0) {
        const extension = path.extname(new URL(asset.path).pathname) || ".mp4";
        filePath = path.join(workDir, `bg-video-${randomUUID().slice(0, 8)}${extension}`);
        await writeFile(filePath, buffer);
      }
    } else if (asset.path) {
      // Guard: only call existsSync when path is non-empty. An empty string resolves
      // to the public/ directory, which exists, causing FFmpeg to fail on a directory.
      const localPath = publicPathToFilePath(asset.path);
      if (existsSync(localPath)) {
        filePath = localPath;
      } else {
        console.warn(`Background file not found on disk: ${localPath}`);
      }
    }

    if (filePath) {
      // Detect whether the resolved file is a video or a static image so we can
      // choose the correct FFmpeg input options and filter graph path.
      const ext = path.extname(filePath).toLowerCase();
      const isVideoFile = VIDEO_EXTS.has(ext);
      // Warn when a static image is suspiciously small — upscaling tiny sources to
      // 1080×1920 produces visible blur. Replace with higher-resolution files.
      if (!isVideoFile && asset.source === "local") {
        try {
          const { statSync } = await import("node:fs");
          const sizeKb = Math.round(statSync(filePath).size / 1024);
          if (sizeKb < 200) {
            console.warn(`⚠ Background image is small (${sizeKb} KB): ${path.basename(filePath)} — consider replacing with a higher-resolution file`);
          }
        } catch { /* non-fatal */ }
      }
      console.info(`✓ Background loaded: ${path.basename(filePath)} (${isVideoFile ? "video" : "image"})`);
      return {
        input: filePath,
        inputOptions: isVideoFile
          ? ["-stream_loop", "-1", "-t", String(duration)]
          : ["-loop", "1"],
        cleanup: asset.source === "remote" ? filePath : undefined,
        isVideo: isVideoFile
      };
    }
  } catch (error) {
    console.warn("Background asset unavailable; using generated gradient", { asset, error });
  }

  console.info("✗ Background: no asset loaded → using gradient fallback");
  const gradient = await renderGradientBackground(theme, workDir);

  // No -t here: zoompan consumes the single looped frame and emits a continuous
  // ken-burns zoom; the global output -t bounds the stream length.
  return {
    input: gradient.path,
    inputOptions: ["-loop", "1"],
    cleanup: gradient.path,
    isVideo: false
  };
}

async function prepareGif(
  asset: AssetReference,
  workDir: string,
  duration: number
): Promise<PreparedInput | null> {
  try {
    let filePath: string | null = null;

    if (asset.source === "remote") {
      const buffer = await loadAssetBuffer(asset);
      if (buffer && buffer.length > 0) {
        // Preserve original extension so FFmpeg picks the correct demuxer
        const ext = path.extname(new URL(asset.path).pathname) || ".gif";
        filePath = path.join(workDir, `gif-${randomUUID().slice(0, 8)}${ext}`);
        await writeFile(filePath, buffer);
      }
    } else if (asset.path) {
      // Guard: empty path resolves to public/ directory — must be skipped.
      const localPath = publicPathToFilePath(asset.path);
      if (existsSync(localPath)) {
        filePath = localPath;
      } else {
        console.warn(`GIF file not found on disk: ${localPath}`);
      }
    }

    if (filePath) {
      const ext = path.extname(filePath).toLowerCase();
      // -ignore_loop is a GIF demuxer option; WebP uses a different demuxer.
      // For both formats -t caps the read length. Only pass -ignore_loop for .gif.
      const inputOptions: string[] = ext === ".gif"
        ? ["-ignore_loop", "0", "-t", String(duration)]
        : ["-t", String(duration)];
      console.info(`✓ GIF loaded: ${path.basename(filePath)} (ext=${ext})`);
      return {
        input: filePath,
        inputOptions,
        cleanup: asset.source === "remote" ? filePath : undefined
      };
    }
  } catch (error) {
    console.warn("GIF unavailable; continuing without it", { asset, error });
  }

  console.info("✗ GIF: no file loaded → skipping GIF overlay");
  return null;
}

/**
 * Returns a real audio input when one exists locally. When audio is missing we
 * render a clean, video-only MP4 instead of depending on the `lavfi` virtual
 * device (which is not reliably available through fluent-ffmpeg). A video
 * without an audio track is still a valid, playable file.
 */
function prepareAudio(asset: AssetReference, duration: number): PreparedInput | null {
  if (asset.source === "local" && asset.path) {
    const filePath = publicPathToFilePath(asset.path);
    if (existsSync(filePath)) {
      console.info(`✓ Audio loaded: ${path.basename(filePath)}`);
      return {
        input: filePath,
        inputOptions: ["-stream_loop", "-1", "-t", String(duration)]
      };
    }
    console.warn(`✗ Audio file not found on disk: ${filePath}`);
  } else if (!asset.path) {
    console.info("✗ Audio: no file selected → video will have no music");
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Timeline + filter graph                                                    */
/* -------------------------------------------------------------------------- */

type Timeline = {
  duration: number;
  scene1End: number;
  scene2End: number;
};

function buildTimeline(): Timeline {
  // 8-10s total: Scene1 ~30%, Scene2 ~38%, Scene3 ~32%
  const duration = fmt(randomBetween(8.0, 10.0));
  const scene1End = fmt(Math.max(2.5, duration * 0.30));
  const scene2End = fmt(Math.max(scene1End + 3.0, duration * 0.68));

  return { duration, scene1End, scene2End };
}

type OverlayItem = {
  inputIndex: number;
  prep: string;
  overlayOptions: string;
};

function alphaFade(start: number, end: number) {
  const fadeIn = 0.3;
  const fadeOut = 0.3;
  const safeOutStart = fmt(Math.max(start + fadeIn, end - fadeOut));

  return `fade=t=in:st=${fmt(start)}:d=${fadeIn}:alpha=1,fade=t=out:st=${safeOutStart}:d=${fadeOut}:alpha=1`;
}

function slideY(baseY: number, start: number, offset = 46) {
  return `${baseY}+${offset}*(1-min(max((t-${fmt(start)})/0.35,0),1))`;
}

/**
 * Bounce easing for the CTA — the card overshoots its resting Y then settles,
 * using a damped cosine. `p` is normalized progress over `dur` seconds.
 */
function bounceY(baseY: number, start: number, dur = 0.6, amp = 70) {
  const s = fmt(start);
  const p = `min(max((t-${s})/${dur},0),1)`;
  // amp * e^(-5p) * cos(3π p) → starts low, springs up, settles at baseY.
  return `${baseY}+${amp}*exp(-5*${p})*cos(3*PI*${p})`;
}

/**
 * Pop easing for the GIF — rises from below with a small overshoot so it
 * "pops" into place. Cheap, alpha-safe alternative to per-frame scaling.
 */
function popY(baseY: number, start: number, offset = 90) {
  const s = fmt(start);
  const p = `min(max((t-${s})/0.4,0),1)`;
  return `${baseY}+${offset}*(1-${p})-18*${p}*(1-${p})*4`;
}

function validateFilters(filters: string[]) {
  for (const filter of filters) {
    if (!filter.trim()) {
      throw new VideoGenerationError("Generated an empty FFmpeg filter.");
    }

    if (filter.includes(";;") || filter.includes("[]")) {
      throw new VideoGenerationError(`Generated malformed FFmpeg filter: ${filter}`);
    }
  }

  return filters;
}

function buildBackgroundFilter(isVideo: boolean, timeline: Timeline) {
  const fadeOutStart = fmt(Math.max(0.4, timeline.duration - 0.5));
  // Subtle, natural color grading — clean commercial/lifestyle look
  const common = `format=rgba,eq=contrast=1.03:saturation=1.06:brightness=0.01,fade=t=in:st=0:d=0.4,fade=t=out:st=${fadeOutStart}:d=0.5`;

  if (isVideo) {
    return `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,fps=${OUTPUT_FPS},${common}[bg]`;
  }

  const frames = Math.round(timeline.duration * OUTPUT_FPS);
  // Randomize Ken Burns motion for variety across videos
  const zoomStyle = Math.floor(Math.random() * 4);
  let zoomExpr: string;
  let xExpr: string;
  let yExpr: string;

  if (zoomStyle === 0) {
    // Zoom in from center
    zoomExpr = "min(zoom+0.0010,1.22)";
    xExpr = "iw/2-(iw/zoom/2)";
    yExpr = "ih/2-(ih/zoom/2)";
  } else if (zoomStyle === 1) {
    // Zoom out from top
    zoomExpr = "if(lte(zoom,1.0),1.22,max(1.001,zoom-0.0010))";
    xExpr = "iw/2-(iw/zoom/2)";
    yExpr = "ih*0.25-(ih/zoom/2)";
  } else if (zoomStyle === 2) {
    // Pan left-to-right + gentle zoom
    // Use literal frames count — `d` is not available in x/y expressions
    zoomExpr = "min(zoom+0.0007,1.15)";
    xExpr = `iw*0.1+iw*0.4*on/${frames}-(iw/zoom/2)`;
    yExpr = "ih/2-(ih/zoom/2)";
  } else {
    // Zoom in from lower-center (good for products/faces in lower half)
    zoomExpr = "min(zoom+0.0009,1.18)";
    xExpr = "iw/2-(iw/zoom/2)";
    yExpr = "ih*0.65-(ih/zoom/2)";
  }

  return `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},setsar=1,zoompan=z='${zoomExpr}':d=${frames}:x='${xExpr}':y='${yExpr}':s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:fps=${OUTPUT_FPS},${common}[bg]`;
}

/* -------------------------------------------------------------------------- */
/* Render plan                                                                */
/* -------------------------------------------------------------------------- */

type RenderPlan = {
  inputs: PreparedInput[];
  background: BackgroundInput;
  overlays: OverlayItem[];
  audioIndex: number | null;
  timeline: Timeline;
};

async function buildRenderPlan(
  analysis: ProductAnalysis,
  assets: GenerationAssets,
  theme: VisualTheme,
  copy: SceneCopy,
  timeline: Timeline,
  workDir: string,
  options: { includeMedia: boolean }
): Promise<RenderPlan> {
  const inputs: PreparedInput[] = [];
  const overlays: OverlayItem[] = [];

  const background = await prepareBackground(
    options.includeMedia ? assets.background : { path: "", source: "remote" },
    theme,
    workDir,
    timeline.duration
  );
  inputs.push(background);

  const audio = prepareAudio(
    options.includeMedia ? assets.audio : { path: "", source: "remote" },
    timeline.duration
  );
  let audioIndex: number | null = null;

  if (audio) {
    audioIndex = inputs.length;
    inputs.push(audio);
  }

  const registerOverlay = (
    inputPath: string,
    cleanup: string | undefined,
    type: "static" | "animated" | "video",
    prep: string,
    overlayOptions: string
  ) => {
    const index = inputs.length;
    const inputOptions =
      type === "animated" ? ["-ignore_loop", "0", "-t", String(timeline.duration)]
      : type === "video"  ? ["-t", String(timeline.duration)]
      : /* static */        ["-loop", "1", "-t", String(timeline.duration)];
    inputs.push({ input: inputPath, inputOptions, cleanup });
    overlays.push({ inputIndex: index, prep, overlayOptions });
  };

  // ─── Presenter (exactly ONE, bottom-right, persistent; fade out at CTA) ─────
  if (options.includeMedia) {
    // Pick a SINGLE presenter by hook sentiment: funny → laughing, else shocked.
    const sentiment = classifyHookSentiment(copy.hook);
    const selectedPresenterPath =
      sentiment === "funny"
        ? (assets.presenterPaths.laughing ?? assets.presenterPaths.shocked)
        : (assets.presenterPaths.shocked ?? assets.presenterPaths.laughing);

    if (selectedPresenterPath) {
      console.info(`  Presenter selected: ${path.basename(selectedPresenterPath)} (sentiment=${sentiment})`);
    } else {
      console.info("  Presenter: none available — add .mp4/.png files to public/assets/presenters/");
    }

    const presenterAsset = await renderPresenter(selectedPresenterPath, workDir);

    if (presenterAsset) {
      // Moderate size (~40% width) so it never dominates or collides with the
      // bottom-left feature caption. 9:16 source → 427×760.
      const PRES_TARGET_H = 760;
      const PRES_TARGET_W = Math.round(PRES_TARGET_H * (9 / 16)); // ≈427
      const presX = OUTPUT_WIDTH - PRES_TARGET_W - 24;            // bottom-right
      const presY = OUTPUT_HEIGHT - PRES_TARGET_H - 24;
      // Visible through scenes 1–2; fades out exactly as the CTA takes over.
      const presFadeOut = fmt(timeline.scene2End + 0.25);

      const presInputOptions = presenterAsset.isVideo
        ? ["-stream_loop", "-1", "-t", String(timeline.duration)]
        : ["-loop", "1", "-t", String(timeline.duration)];

      // Animation: fade only (no slide), per the creative brief. Tighter
      // chromakey (similarity 0.30) removes green spill around the subject.
      const presPrep = presenterAsset.isVideo
        ? `scale=${PRES_TARGET_W}:${PRES_TARGET_H}:flags=lanczos,chromakey=color=0x00FF00:similarity=0.30:blend=0.12,format=rgba,${alphaFade(0.2, presFadeOut)}`
        : `scale=${PRES_TARGET_W}:${PRES_TARGET_H}:flags=lanczos,format=rgba,${alphaFade(0.2, presFadeOut)}`;

      const presIndex = inputs.length;
      console.info(`  ✓ Presenter overlay: ${PRES_TARGET_W}×${PRES_TARGET_H} isVideo=${presenterAsset.isVideo ?? false} fadeOut=${presFadeOut}s`);
      inputs.push({
        input: presenterAsset.path,
        inputOptions: presInputOptions,
        cleanup: presenterAsset.isVideo ? undefined : presenterAsset.path
      });
      overlays.push({
        inputIndex: presIndex,
        prep: presPrep,
        overlayOptions: `x=${presX}:y=${presY}:enable='between(t,0.2,${presFadeOut})'`
      });
    } else if (selectedPresenterPath) {
      console.warn("  ✗ Presenter rendering failed; skipping overlay");
    }

    // GIF reaction — scene 1, left column, pops in. Left of the presenter so the
    // two never overlap.
    const gif = await prepareGif(assets.gif, workDir, timeline.duration);
    if (gif) {
      const gifStart = 0.25;
      const gifEnd = fmt(Math.min(2.9, timeline.scene1End + 0.1));
      const gifLayerIndex = inputs.length;
      const GIF_W = 380;
      const gifX = SAFE_X;                            // left column
      const gifY = Math.round(OUTPUT_HEIGHT * 0.50);  // ≈960, below the hook
      console.info(`  ✓ GIF overlay: ${path.basename(gif.input)} t=${gifStart}–${gifEnd}s w=${GIF_W} y≈${gifY}`);
      inputs.push({ input: gif.input, inputOptions: gif.inputOptions, cleanup: gif.cleanup });
      overlays.push({
        inputIndex: gifLayerIndex,
        // Rounded GIF for a designed look; "pop" rise on entry.
        prep: `scale=${GIF_W}:-1:flags=lanczos,format=rgba,${alphaFade(gifStart, gifEnd)}`,
        overlayOptions: `x=${gifX}:y='${popY(gifY, gifStart, 90)}':enable='between(t,${gifStart},${gifEnd})'`
      });
    } else {
      console.info(`  ✗ GIF: none loaded (gif.path="${assets.gif.path}" gif.source="${assets.gif.source}")`);
    }
  }

  // ─── Scene 2: product image (centered, above the presenter) + logo ─────────
  if (options.includeMedia) {
    const heroUrl = firstDefined([
      assets.website.heroImageUrl,
      assets.website.ogImageUrl,
      ...assets.website.screenshotUrls
    ]);

    if (heroUrl) {
      console.info(`  Fetching hero image: ${heroUrl}`);
    } else {
      console.info("  Hero image: none scraped from website → scene 2 will have no product image");
    }

    const heroBuffer = (await fetchRemoteImageBuffer(heroUrl)) ?? null;

    if (heroBuffer) {
      console.info(`  ✓ Hero image downloaded (${heroBuffer.length} bytes)`);
    } else if (heroUrl) {
      console.warn(`  ✗ Hero image download failed: ${heroUrl}`);
    }

    // Product image: full image, never cropped (fit "inside"), centered in the
    // mid-frame so its bottom edge clears the presenter (top ≈ y1136).
    const productImage = await rasterizeImageAsset(heroBuffer, {
      maxWidth: 760,
      maxHeight: 620,
      workDir,
      rounded: true,
      radius: 40
    });

    const productStart = fmt(timeline.scene1End + 0.15);
    if (productImage) {
      console.info("  ✓ Product image overlay registered");
      registerOverlay(
        productImage.path,
        productImage.path,
        "static",
        `format=rgba,${alphaFade(productStart, timeline.scene2End)}`,
        `x=(W-w)/2:y='${slideY(420, productStart, 50)}':enable='between(t,${productStart},${timeline.scene2End})'`
      );
    } else {
      console.info("  ✗ Product image: none (scene 2 will show background + captions only)");
    }

    // Logo: small brand mark, top-left, persistent through scenes 1–2.
    if (assets.website.logoUrl) {
      console.info(`  Fetching logo: ${assets.website.logoUrl}`);
    } else {
      console.info("  Logo: none scraped from website");
    }

    const logoBuffer = await fetchRemoteImageBuffer(assets.website.logoUrl);
    if (logoBuffer) {
      console.info(`  ✓ Logo downloaded (${logoBuffer.length} bytes)`);
    } else if (assets.website.logoUrl) {
      console.warn(`  ✗ Logo download failed: ${assets.website.logoUrl}`);
    }

    // Small brand element: max 150px wide, never larger than the hook.
    const logoImage = await rasterizeImageAsset(logoBuffer, {
      maxWidth: 150,
      maxHeight: 80,
      workDir,
      rounded: true,
      radius: 14
    });

    if (logoImage) {
      console.info(`  ✓ Logo overlay registered (${logoImage.width}×${logoImage.height}, top-left)`);
      registerOverlay(
        logoImage.path,
        logoImage.path,
        "static",
        `format=rgba,${alphaFade(0.4, timeline.scene2End)}`,
        `x=70:y=70:enable='between(t,0.4,${timeline.scene2End})'`
      );
    }
  }

  // ─── Caption cards ────────────────────────────────────────────────────────
  const cards: Array<{
    card: Promise<ImageAsset | null>;
    start: number;
    end: number;
    placement: (asset: ImageAsset) => string;
  }> = [];

  const pushCard = (
    cardOptions: CardOptions,
    start: number,
    end: number,
    placement: (asset: ImageAsset) => string
  ) => {
    cards.push({
      card: renderCaptionCard(cardOptions),
      start: fmt(start),
      end: fmt(end),
      placement
    });
  };

  // ─── Caption cards (registered LAST — always on top of all media layers) ────
  //
  // Non-overlapping layout contract (1080×1920, TikTok safe areas):
  //   • Hook    → top-center, y≈220, scene 1            (fade + slide)
  //   • Name    → accent pill, top-center, scene 2      (fade + slide)
  //   • Feature → bottom-LEFT (left of presenter), sc.2 (fade + slide-up)
  //   • CTA     → dead-center, scene 3, presenter gone  (fade + bounce)

  // Hook — big white outlined text, centered, auto-fit so it NEVER truncates.
  const HOOK_W = 940;
  const hookStart = 0.15;
  const hookEnd = fmt(timeline.scene1End + 0.25);
  console.info(`  Adding hook card: "${copy.hook.slice(0, 50)}" width=${HOOK_W} t=${hookStart}–${hookEnd}s`);
  pushCard(
    {
      text: copy.hook,
      width: HOOK_W,
      maxFontSize: 100,
      minFontSize: 58,
      maxLines: 3,
      align: "center",
      style: "outline",
      theme,
      workDir
    },
    hookStart,
    hookEnd,
    () => `x=(W-w)/2:y='${slideY(220, hookStart, 44)}'`
  );

  // Scene 2: product name — accent pill, centered near the top.
  const nameStart = fmt(timeline.scene1End + 0.25);
  const nameEnd = timeline.scene2End;
  const nameW = Math.min(660, Math.max(300, copy.productName.length * 46));
  console.info(`  Adding product-name pill: "${copy.productName}" width=${nameW} t=${nameStart}–${nameEnd}s`);
  pushCard(
    {
      text: copy.productName,
      width: nameW,
      maxFontSize: 60,
      minFontSize: 36,
      maxLines: 1,
      align: "center",
      style: "pill",
      theme,
      workDir
    },
    nameStart,
    nameEnd,
    () => `x=(W-w)/2:y='${slideY(150, nameStart, 36)}'`
  );

  // Scene 2: feature — glass card, BOTTOM-LEFT (left of the presenter), rising in.
  const featureStart = fmt(timeline.scene1End + 0.6);
  const featureEnd = fmt(timeline.scene2End - 0.05);
  console.info(`  Adding feature card: "${copy.featureOne.slice(0, 50)}" t=${featureStart}–${featureEnd}s`);
  pushCard(
    {
      text: copy.featureOne,
      width: 500,
      maxFontSize: 56,
      minFontSize: 34,
      maxLines: 3,
      align: "left",
      style: "glass",
      theme,
      workDir
    },
    featureStart,
    featureEnd,
    // Card total width = 500 + 2×30 margin = 560 → right edge 56+560=616 < 629
    // (presenter left), so the feature never overlaps the presenter.
    (asset) => `x=56:y='${slideY(OUTPUT_HEIGHT - asset.height - 70, featureStart, 50)}'`
  );

  // Scene 3: CTA — bold accent card, dead-center, springs in with a bounce.
  const ctaStart = fmt(timeline.scene2End + 0.2);
  const ctaEnd = fmt(timeline.duration - 0.15);
  console.info(`  Adding CTA card: "${copy.cta}" t=${ctaStart}–${ctaEnd}s`);
  pushCard(
    {
      text: copy.cta,
      width: 880,
      maxFontSize: 104,
      minFontSize: 60,
      maxLines: 2,
      align: "center",
      style: "accent",
      theme,
      workDir
    },
    ctaStart,
    ctaEnd,
    (asset) => `x=(W-w)/2:y='${bounceY((OUTPUT_HEIGHT - asset.height) / 2, ctaStart, 0.6, 70)}'`
  );

  const resolvedCards = await Promise.all(cards.map((entry) => entry.card));

  resolvedCards.forEach((asset, index) => {
    if (!asset) {
      console.warn(`  ✗ Caption card[${index}] failed to render — skipping`);
      return;
    }

    const overlay = cards[index];
    const cardIndex = inputs.length;
    const placement = overlay.placement(asset);
    console.info(`  ✓ Caption card[${index}] → FFmpeg input[${cardIndex}] size=${asset.width}×${asset.height} t=${overlay.start}–${overlay.end}s pos=${placement.slice(0, 40)}`);
    inputs.push({
      input: asset.path,
      inputOptions: ["-loop", "1", "-t", String(timeline.duration)],
      cleanup: asset.path
    });
    overlays.push({
      inputIndex: cardIndex,
      prep: `format=rgba,${alphaFade(overlay.start, overlay.end)}`,
      overlayOptions: `${placement}:enable='between(t,${overlay.start},${overlay.end})'`
    });
  });

  return { inputs, background, overlays, audioIndex, timeline };
}

function buildFilterGraph(plan: RenderPlan) {
  console.info(`── Filter graph: ${plan.overlays.length} overlay(s) over ${plan.inputs.length} input(s) ──`);
  plan.overlays.forEach((ov, i) => {
    console.info(`  Layer[${i}] input[${ov.inputIndex}] options=${ov.overlayOptions.slice(0, 60)}`);
  });
  const filters: string[] = [buildBackgroundFilter(plan.background.isVideo, plan.timeline)];
  let previousLabel = "[bg]";

  plan.overlays.forEach((overlay, index) => {
    const preparedLabel = `[ov${index}]`;
    const outputLabel =
      index === plan.overlays.length - 1 ? "[vout]" : `[v${index}]`;

    // Each overlay (media or caption card) embeds its own alpha fades in `prep`.
    filters.push(`[${overlay.inputIndex}:v]${overlay.prep}${preparedLabel}`);
    filters.push(
      `${previousLabel}${preparedLabel}overlay=${overlay.overlayOptions}${outputLabel}`
    );
    previousLabel = outputLabel;
  });

  return { filters: validateFilters(filters), finalLabel: previousLabel };
}

/* -------------------------------------------------------------------------- */
/* FFmpeg execution                                                           */
/* -------------------------------------------------------------------------- */

function addPreparedInput(command: ffmpeg.FfmpegCommand, asset: PreparedInput) {
  command.input(asset.input.includes(path.sep) ? toFfmpegPath(asset.input) : asset.input);

  if (asset.inputOptions.length > 0) {
    command.inputOptions(asset.inputOptions);
  }
}

async function runFfmpeg(
  plan: RenderPlan,
  finalLabel: string,
  filters: string[],
  outputPath: string
) {
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg();
    const stderrLines: string[] = [];

    for (const asset of plan.inputs) {
      addPreparedInput(command, asset);
    }

    console.info("FFmpeg filter_complex", { filterComplex: filters.join(";") });

    const outputOptions = ["-map", finalLabel];

    if (plan.audioIndex !== null) {
      const fadeOutAt = Math.max(0, plan.timeline.duration - 1.2).toFixed(2);
      outputOptions.push(
        "-map",
        `${plan.audioIndex}:a`,
        "-af",
        `afade=t=in:st=0:d=1.0,afade=t=out:st=${fadeOutAt}:d=1.2,volume=0.55`,
        "-c:a",
        "aac",
        "-b:a",
        "128k"
      );
    }

    outputOptions.push(
      "-t",
      String(plan.timeline.duration),
      "-r",
      String(OUTPUT_FPS),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart"
    );

    command
      .complexFilter(filters)
      .outputOptions(outputOptions)
      .on("start", (startedCommandLine) => {
        console.info("Starting FFmpeg render", { commandLine: startedCommandLine });
      })
      .on("stderr", (line) => {
        stderrLines.push(line);
        if (stderrLines.length > 30) {
          stderrLines.shift();
        }
      })
      .on("error", (error) => {
        reject(
          new VideoGenerationError(
            stderrLines.length > 0
              ? `${error.message}\n${stderrLines.join("\n")}`
              : error.message
          )
        );
      })
      .on("end", () => {
        console.info("FFmpeg render completed", { outputPath });
        resolve();
      })
      .save(outputPath);
  });
}

async function cleanupPlan(plan: RenderPlan | null) {
  if (!plan) {
    return;
  }

  await Promise.all(
    plan.inputs
      .map((asset) => asset.cleanup)
      .filter((cleanup): cleanup is string => Boolean(cleanup))
      .map((cleanup) => rm(cleanup, { force: true }).catch(() => undefined))
  );
}

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a public URL for the finished MP4.
 *
 * Strategy (in priority order):
 *  1. BLOB_READ_WRITE_TOKEN set → upload to Vercel Blob, return blob URL.
 *  2. Running on Vercel without Blob token → throw with a clear setup message.
 *     (Vercel's filesystem is read-only; writing to public/generated is impossible.)
 *  3. Local development (not on Vercel, no token) → copy to public/generated/,
 *     return a relative /generated/… path served by Next.js static file handler.
 */
async function publishVideo(tmpOutputPath: string, filename: string): Promise<string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const onVercel = process.env.VERCEL === "1";

  if (token) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { put } = require("@vercel/blob") as typeof import("@vercel/blob");
    const buffer = await readFile(tmpOutputPath);
    const blob = await put(`ugc-videos/${filename}`, buffer, {
      access: "public",
      token,
      contentType: "video/mp4",
    });
    console.info(`✓ Video uploaded to Vercel Blob: ${blob.url}`);
    return blob.url;
  }

  if (onVercel) {
    // Vercel filesystem is read-only — public/generated cannot be created at runtime.
    throw new VideoGenerationError(
      "BLOB_READ_WRITE_TOKEN is not set. " +
      "Create a Vercel Blob store (Storage → Create → Blob) and add the token " +
      "to your project's Environment Variables, then redeploy."
    );
  }

  // Local development: serve from public/generated/ via Next.js static file handler.
  const generatedDir = path.join(process.cwd(), "public", "generated");
  await mkdir(generatedDir, { recursive: true });
  const dest = path.join(generatedDir, filename);
  await copyFile(tmpOutputPath, dest);
  console.info(`✓ Video saved locally: /generated/${filename}`);
  return `/generated/${filename}`;
}

export async function generateUgcVideo(
  analysis: ProductAnalysis,
  assets: GenerationAssets
): Promise<GeneratedVideo> {
  ffmpeg.setFfmpegPath(getFfmpegExecutablePath());

  const filename = `ugc-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
  // Always write FFmpeg output to /tmp — writable on every platform including Vercel.
  const workDir = path.join(tmpdir(), `ugc-${randomUUID()}`);
  const outputPath = path.join(workDir, filename);

  await mkdir(workDir, { recursive: true });

  const theme = getVisualTheme(analysis, assets);
  const copy = buildSceneCopy(analysis);
  const timeline = buildTimeline();

  const attempts: Array<{ includeMedia: boolean; label: string }> = [
    { includeMedia: true, label: "full" },
    { includeMedia: false, label: "safe-fallback" }
  ];

  let lastError: unknown;

  try {
    for (const attempt of attempts) {
      let plan: RenderPlan | null = null;

      try {
        plan = await buildRenderPlan(analysis, assets, theme, copy, timeline, workDir, {
          includeMedia: attempt.includeMedia
        });

        const { filters, finalLabel } = buildFilterGraph(plan);

        await runFfmpeg(plan, finalLabel, filters, outputPath);

        console.info(`✓ Video rendered successfully: ${filename} (${Math.round(timeline.duration)}s, attempt: ${attempt.label})`);

        // Publish (upload to Blob or copy to public/generated) before cleaning up workDir.
        const videoPath = await publishVideo(outputPath, filename);

        return {
          videoPath,
          duration: Math.round(timeline.duration),
          filename
        };
      } catch (error) {
        lastError = error;
        console.error(`FFmpeg render attempt "${attempt.label}" failed`, { error });
      } finally {
        await cleanupPlan(plan);
      }
    }

    throw lastError instanceof Error
      ? new VideoGenerationError(lastError.message)
      : new VideoGenerationError("Video generation failed.");
  } finally {
    // Clean up the entire tmp working directory (includes the output MP4).
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
