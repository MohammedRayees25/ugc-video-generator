import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
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
const FONT_FAMILY = "DejaVu Sans";

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
 * Picks the funniest/most viral hook. Prefers AI-generated hookVariations,
 * then falls back to proven UGC templates using the product name/benefit.
 */
function pickFunnyHook(analysis: ProductAnalysis): string {
  const aiHooks = [...(analysis.hookVariations ?? []), analysis.viralHook].filter(Boolean);
  if (aiHooks.length > 0) return pickRandom(aiHooks, aiHooks[0]);

  const name = sanitizeCaption(analysis.productName) || "this";
  const benefit = sanitizeCaption(analysis.mainBenefits?.[0] ?? "") || "amazing";
  const audience = sanitizeCaption(analysis.targetAudience ?? "") || "everyone";
  const templates = [
    `POV you just discovered ${name}`,
    `When ${name} does all the work for you`,
    `Nobody told me about ${name} sooner`,
    `Why is nobody talking about ${name}`,
    `I tried ${name} so you don't have to`,
    `Me after finding ${name}`,
    `${benefit} and I cannot stop using it`,
    `The ${name} trick nobody shows you`,
    `This app actually surprised me`,
    `I wish I knew this sooner`,
    `${name} changed everything for me`,
    `Wait until you see what ${name} does`,
    `Every ${audience} needs to know about this`,
    `Stop what you are doing and try ${name}`,
    `The reason I can't stop using ${name}`,
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
  const remainingFeatures = features.filter((feature) => feature !== featureOne);

  const productNameClean = prepareCaption(analysis.productName, "This product", 5);
  // Always end with a direct call-to-action that names the product
  const ctaOptions = [
    `Try ${productNameClean} today`,
    `Get ${productNameClean} now`,
    `Start with ${productNameClean}`,
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
/* Sharp-based asset rendering (caption cards, backgrounds, images)           */
/* -------------------------------------------------------------------------- */

type ImageAsset = {
  path: string;
  width: number;
  height: number;
};

async function svgToPng(svg: string, outputPath: string): Promise<ImageAsset> {
  // No custom density: the SVGs declare explicit pixel dimensions, so the
  // default rendering keeps them 1:1 (a higher density would upscale them).
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  const metadata = await sharp(buffer).metadata();

  await writeFile(outputPath, buffer);

  return {
    path: outputPath,
    width: metadata.width ?? OUTPUT_WIDTH,
    height: metadata.height ?? OUTPUT_HEIGHT
  };
}

type CardStyle = "glass" | "brand" | "accent" | "outline" | "pill";

type CardOptions = {
  text: string;
  width: number;
  fontSize: number;
  align: "center" | "left";
  style: CardStyle;
  theme: VisualTheme;
  workDir: string;
  maxLines?: number;
};

async function renderCaptionCard(options: CardOptions): Promise<ImageAsset | null> {
  const text = sanitizeCaption(options.text);

  if (!text) {
    return null;
  }

  const { width, fontSize, align, style, theme, workDir } = options;
  const margin = 28;
  // outline: extra padding to keep thick stroke inside canvas; glass: generous padding for readability
  const padX = style === "outline" ? 20 : style === "pill" ? 36 : 52;
  const padY = style === "outline" ? 16 : style === "pill" ? 22 : 36;
  const innerWidth = width - padX * 2;
  const approxCharWidth = fontSize * 0.56;
  const maxChars = Math.max(8, Math.floor(innerWidth / approxCharWidth));
  const lines = wrapText(text, maxChars).slice(0, options.maxLines ?? 3);
  const lineHeight = Math.round(fontSize * 1.28);
  const boxHeight = lines.length * lineHeight + padY * 2;
  const boxWidth = width;
  const svgWidth = boxWidth + margin * 2;
  const svgHeight = boxHeight + margin * 2;

  const textX = align === "center" ? margin + boxWidth / 2 : margin + padX;
  const anchor = align === "center" ? "middle" : "start";
  const firstBaseline = margin + padY + Math.round(fontSize * 0.82);

  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight;
      return `<tspan x="${textX}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");

  let fillDef = "";
  let fillRef = "";
  let extraElements = "";

  if (style === "outline") {
    // TikTok-style hook text: thick black outline + white fill for maximum readability
    // over any background. We render TWO overlapping text elements:
    //   1. Black fill + thick black stroke → creates the visible border
    //   2. White fill → sits on top, creating white text with thick black outline
    // This is more reliable than paint-order="stroke" across librsvg versions.
    const strokeW = Math.max(14, Math.round(fontSize * 0.16));
    // Semi-transparent dark scrim behind text so it reads on bright backgrounds too
    const scrimH = boxHeight + padY * 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
      <defs>
        <filter id="txtshadow" x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="3" stdDeviation="6" flood-color="#000000" flood-opacity="0.9"/>
        </filter>
      </defs>
      <rect x="${margin}" y="${margin}" width="${boxWidth}" height="${scrimH}"
            rx="12" ry="12" fill="#000000" fill-opacity="0.35"/>
      <text x="${textX}" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-weight="bold"
            font-size="${fontSize}" fill="#000000" stroke="#000000" stroke-width="${strokeW}"
            stroke-linejoin="round" text-anchor="${anchor}"
            filter="url(#txtshadow)">${tspans}</text>
      <text x="${textX}" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-weight="bold"
            font-size="${fontSize}" fill="#ffffff" text-anchor="${anchor}">${tspans}</text>
    </svg>`;
    try {
      const asset = await svgToPng(svg, path.join(workDir, `card-${randomUUID().slice(0, 8)}.png`));
      console.info(`  ✓ Hook card rendered: "${text.slice(0, 40)}" fontSize=${fontSize} stroke=${strokeW} size=${asset.width}×${asset.height}`);
      return asset;
    } catch (error) {
      console.warn("Caption card rendering failed; skipping caption", { text, error });
      return null;
    }
  }

  if (style === "pill") {
    // Accent pill with checkmark prefix
    fillRef = `fill="${theme.accentColor}" fill-opacity="0.94"`;
    extraElements = `<text x="${margin + 18}" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-size="${fontSize}" fill="white" font-weight="bold">&#x2714;</text>`;
    const pillPadX = padX + fontSize + 8;
    const pillTextX = align === "center" ? margin + boxWidth / 2 : margin + pillPadX;
    const pillTspans = lines
      .map((line, i) => `<tspan x="${pillTextX}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
      .join("");
    const pillSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
      <defs>
        <filter id="cardshadow" x="-30%" y="-30%" width="160%" height="160%">
          <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000000" flood-opacity="0.6"/>
        </filter>
      </defs>
      <rect x="${margin}" y="${margin}" rx="${Math.round(boxHeight / 2)}" ry="${Math.round(boxHeight / 2)}"
            width="${boxWidth}" height="${boxHeight}" ${fillRef} filter="url(#cardshadow)"/>
      ${extraElements}
      <text x="${pillTextX}" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-weight="bold"
            font-size="${fontSize}" fill="#ffffff" text-anchor="${anchor}"
            paint-order="stroke" stroke="#000000" stroke-width="${Math.max(1, Math.round(fontSize * 0.04))}"
            stroke-opacity="0.3">${pillTspans}</text>
    </svg>`;
    try {
      return await svgToPng(pillSvg, path.join(workDir, `card-${randomUUID().slice(0, 8)}.png`));
    } catch (error) {
      console.warn("Caption card rendering failed; skipping caption", { text, error });
      return null;
    }
  }

  if (style === "glass") {
    // Frosted dark glass — high opacity so text is always readable
    fillDef = `<linearGradient id="glassbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12151f" stop-opacity="0.94"/><stop offset="1" stop-color="#080b12" stop-opacity="0.97"/></linearGradient>`;
    fillRef = `fill="url(#glassbg)"`;
  } else if (style === "accent") {
    fillDef = `<linearGradient id="accentbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${theme.accentColor}"/><stop offset="1" stop-color="${theme.brandColor}"/></linearGradient>`;
    fillRef = `fill="url(#accentbg)" fill-opacity="0.95"`;
  } else {
    fillDef = `<linearGradient id="cardgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${theme.brandColor}"/><stop offset="1" stop-color="${theme.accentColor}"/></linearGradient>`;
    fillRef = `fill="url(#cardgrad)" fill-opacity="0.97"`;
  }

  const radius = Math.min(56, Math.round(boxHeight / 2.4));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
    <defs>
      ${fillDef}
      <filter id="cardshadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="14" stdDeviation="20" flood-color="#000000" flood-opacity="0.7"/>
      </filter>
    </defs>
    <rect x="${margin}" y="${margin}" rx="${radius}" ry="${radius}"
          width="${boxWidth}" height="${boxHeight}" ${fillRef} filter="url(#cardshadow)"/>
    <text x="${textX}" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-weight="bold"
          font-size="${fontSize}" fill="#ffffff" text-anchor="${anchor}">${tspans}</text>
  </svg>`;

  try {
    const asset = await svgToPng(svg, path.join(workDir, `card-${randomUUID().slice(0, 8)}.png`));
    console.info(`  ✓ Caption card rendered (${style}): "${text.slice(0, 40)}" fontSize=${fontSize} size=${asset.width}×${asset.height}`);
    return asset;
  } catch (error) {
    console.warn("Caption card rendering failed; skipping caption", {
      text,
      error
    });

    return null;
  }
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
  try {
    const buffer = await readFile(presenterPath);
    // ~40% of frame width and roughly half the frame height so the presenter
    // is a dominant visual element rather than a small corner badge.
    return rasterizeImageAsset(buffer, {
      maxWidth: 540,
      maxHeight: 960,
      workDir,
      rounded: false
    });
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
        filePath = path.join(workDir, `gif-${randomUUID().slice(0, 8)}.gif`);
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
      console.info(`✓ GIF loaded: ${path.basename(filePath)}`);
      return {
        input: filePath,
        inputOptions: ["-ignore_loop", "0", "-t", String(duration)],
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
  // Choose a random Ken Burns direction for variety
  const zoomStyle = Math.floor(Math.random() * 3);
  let zoomExpr: string;
  let xExpr: string;
  let yExpr: string;

  if (zoomStyle === 0) {
    // Zoom in from center
    zoomExpr = "min(zoom+0.0010,1.22)";
    xExpr = "iw/2-(iw/zoom/2)";
    yExpr = "ih/2-(ih/zoom/2)";
  } else if (zoomStyle === 1) {
    // Zoom out from 1.22
    zoomExpr = "if(lte(zoom,1.0),1.22,max(1.001,zoom-0.0010))";
    xExpr = "iw/2-(iw/zoom/2)";
    yExpr = "ih/2-(ih/zoom/2)";
  } else {
    // Pan + zoom (drift across frame)
    zoomExpr = "min(zoom+0.0007,1.15)";
    xExpr = "iw*0.1+iw*0.4*on/frames_total-(iw/zoom/2)";
    yExpr = "ih/2-(ih/zoom/2)";
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
    isAnimated: boolean,
    prep: string,
    overlayOptions: string
  ) => {
    const index = inputs.length;
    inputs.push({
      input: inputPath,
      inputOptions: isAnimated
        ? ["-ignore_loop", "0", "-t", String(timeline.duration)]
        : ["-loop", "1", "-t", String(timeline.duration)],
      cleanup
    });
    overlays.push({ inputIndex: index, prep, overlayOptions });
  };

  // ─── Scene 1: presenter (large, bottom-center) + GIF reaction (0-2.5s) ──
  if (options.includeMedia) {
    const presenterEnd = fmt(timeline.scene1End - 0.1);

    if (assets.presenterPath) {
      console.info(`  Rendering presenter: ${path.basename(assets.presenterPath)}`);
    } else {
      console.info("  Presenter: none available (add files to public/assets/presenters/)");
    }

    const presenterAsset = await renderPresenter(assets.presenterPath, workDir);

    if (presenterAsset) {
      console.info(`  ✓ Presenter overlay registered (${presenterAsset.width}×${presenterAsset.height})`);
      // Center horizontally, anchor to bottom — fills 40%+ of the frame width
      const presX = fmt((OUTPUT_WIDTH - presenterAsset.width) / 2);
      const presY = fmt(OUTPUT_HEIGHT - presenterAsset.height - 40);
      registerOverlay(
        presenterAsset.path,
        presenterAsset.path,
        false,
        `format=rgba,${alphaFade(0.1, presenterEnd)}`,
        `x=${presX}:y='${slideY(presY, 0.1, 80)}':enable='between(t,0.1,${presenterEnd})'`
      );
    } else if (assets.presenterPath) {
      console.warn("  ✗ Presenter rendering failed; skipping overlay");
    }

    // GIF reaction during first 2-3 seconds (overlapping with hook/presenter)
    const gif = await prepareGif(assets.gif, workDir, timeline.duration);
    if (gif) {
      const gifStart = 0.5;
      const gifEnd = fmt(Math.min(2.8, timeline.scene1End - 0.1));
      const gifLayerIndex = inputs.length + 1; // +1 because registerOverlay will push to inputs
      console.info(`  ✓ GIF overlay registered: path=${gif.input} t=${gifStart}–${gifEnd}s size=260px layerIndex=${gifLayerIndex} position=bottom-left`);
      registerOverlay(
        gif.input,
        gif.cleanup,
        true,
        `scale=260:-1:flags=lanczos,format=rgba,${alphaFade(gifStart, gifEnd)}`,
        `x=${SAFE_X}:y=H-h-160:enable='between(t,${gifStart},${gifEnd})'`
      );
    } else {
      console.info(`  ✗ GIF: none loaded (gif.path="${assets.gif.path}" gif.source="${assets.gif.source}")`);
    }
  }

  // ─── Scene 2: product image (full-frame, no phone mockup) + logo ─────────
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

    // Product image displayed directly — no phone frame, large rounded card
    const productImage = await rasterizeImageAsset(heroBuffer, {
      maxWidth: 860,
      maxHeight: 1000,
      workDir,
      rounded: true,
      radius: 48
    });

    if (productImage) {
      console.info("  ✓ Product image overlay registered");
      registerOverlay(
        productImage.path,
        productImage.path,
        false,
        `format=rgba,${alphaFade(timeline.scene1End, timeline.scene2End)}`,
        `x=(W-w)/2:y='${slideY(360, timeline.scene1End, 60)}':enable='between(t,${timeline.scene1End},${timeline.scene2End})'`
      );
    } else {
      console.info("  ✗ Product image: none (scene 2 will show background + captions only)");
    }

    // Logo: persistent from scene 1 through end of scene 2 — small, top-left
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

    const logoImage = await rasterizeImageAsset(logoBuffer, {
      maxWidth: 200,
      maxHeight: 100,
      workDir,
      rounded: true,
      radius: 16
    });

    if (logoImage) {
      console.info("  ✓ Logo overlay registered (persistent scenes 1–2)");
      // Show logo from early in scene 1 through end of scene 2
      registerOverlay(
        logoImage.path,
        logoImage.path,
        false,
        `format=rgba,${alphaFade(0.4, timeline.scene2End)}`,
        `x=${SAFE_X}:y=80:enable='between(t,0.4,${timeline.scene2End})'`
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

  // ─── Caption cards (registered LAST so they render above all media layers) ─
  //
  // Layer order after resolution:
  //   bg → presenter → gif → product-image → logo → hook → name → feature → CTA
  //
  // Scene 1: hook — TikTok-style large white outlined text, top 15% of frame
  const hookStart = 0.15;
  const hookEnd = fmt(timeline.scene1End - 0.1);
  console.info(`  Adding hook card: "${copy.hook.slice(0, 50)}" fontSize=94 t=${hookStart}–${hookEnd}s y≈120`);
  pushCard(
    {
      text: copy.hook,
      width: 1000,
      fontSize: 94,
      align: "center",
      style: "outline",
      theme,
      workDir,
      maxLines: 3
    },
    hookStart,
    hookEnd,
    () => `x=(W-w)/2:y='${slideY(80, hookStart, 40)}'`
  );

  // Scene 2: product name — glass card, upper section (above product image)
  const nameStart = fmt(timeline.scene1End + 0.15);
  const nameEnd = timeline.scene2End;
  console.info(`  Adding product-name card: "${copy.productName}" fontSize=60 t=${nameStart}–${nameEnd}s`);
  pushCard(
    {
      text: copy.productName,
      width: 740,
      fontSize: 60,
      align: "center",
      style: "glass",
      theme,
      workDir,
      maxLines: 1
    },
    nameStart,
    nameEnd,
    () => `x=(W-w)/2:y='${slideY(180, nameStart, 40)}'`
  );

  // Scene 2: feature caption — glass card, lower third
  const featureStart = fmt(timeline.scene1End + 0.5);
  const featureEnd = fmt(timeline.scene2End - 0.05);
  console.info(`  Adding feature card: "${copy.featureOne.slice(0, 50)}" fontSize=68 t=${featureStart}–${featureEnd}s y≈1450`);
  pushCard(
    {
      text: copy.featureOne,
      width: 960,
      fontSize: 68,
      align: "center",
      style: "glass",
      theme,
      workDir,
      maxLines: 2
    },
    featureStart,
    featureEnd,
    () => `x=(W-w)/2:y='${slideY(1450, featureStart, 40)}'`
  );

  // Scene 3: CTA — large glass card, center screen
  const ctaStart = fmt(timeline.scene2End + 0.15);
  const ctaEnd = fmt(timeline.duration - 0.15);
  console.info(`  Adding CTA card: "${copy.cta}" fontSize=80 t=${ctaStart}–${ctaEnd}s y≈820`);
  pushCard(
    {
      text: copy.cta,
      width: 900,
      fontSize: 80,
      align: "center",
      style: "glass",
      theme,
      workDir,
      maxLines: 2
    },
    ctaStart,
    ctaEnd,
    () => `x=(W-w)/2:y='${slideY(820, ctaStart, 70)}'`
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
