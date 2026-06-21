import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function buildSceneCopy(analysis: ProductAnalysis): SceneCopy {
  const features = [
    ...analysis.featureCaptions,
    ...analysis.mainBenefits,
    analysis.caption
  ].filter(Boolean);
  const featureOne = pickRandom(features, analysis.caption);
  const remainingFeatures = features.filter((feature) => feature !== featureOne);

  return {
    hook: prepareCaption(
      pickRandom(analysis.hookVariations, analysis.viralHook),
      analysis.viralHook,
      7
    ),
    productName: prepareCaption(analysis.productName, "This product", 5),
    featureOne: prepareCaption(featureOne, analysis.caption, 8),
    featureTwo: prepareCaption(
      pickRandom(remainingFeatures, analysis.mainBenefits[0] ?? analysis.productName),
      analysis.productName,
      8
    ),
    cta: prepareCaption(pickRandom(analysis.ctaCaptions, analysis.cta), analysis.cta, 6)
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
  const margin = 24;
  const padX = style === "outline" ? 0 : style === "pill" ? 36 : 48;
  const padY = style === "outline" ? 8 : style === "pill" ? 22 : 32;
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
    // Clean subtitle style: white text, thin outline, soft shadow — Apple/Instagram look
    const strokeW = Math.max(3, Math.round(fontSize * 0.05));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
      <defs>
        <filter id="txtshadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="4" stdDeviation="8" flood-color="#000000" flood-opacity="0.7"/>
        </filter>
      </defs>
      <text x="${textX}" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-weight="bold"
            font-size="${fontSize}" fill="#ffffff" text-anchor="${anchor}"
            paint-order="stroke" stroke="#000000" stroke-width="${strokeW}"
            stroke-linejoin="round" filter="url(#txtshadow)">${tspans}</text>
    </svg>`;
    try {
      return await svgToPng(svg, path.join(workDir, `card-${randomUUID().slice(0, 8)}.png`));
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
    // Frosted dark glass — Notion / Linear card aesthetic
    fillDef = `<linearGradient id="glassbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e2333" stop-opacity="0.92"/><stop offset="1" stop-color="#0d1117" stop-opacity="0.96"/></linearGradient>`;
    fillRef = `fill="url(#glassbg)"`;
  } else if (style === "accent") {
    fillDef = `<linearGradient id="accentbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${theme.accentColor}"/><stop offset="1" stop-color="${theme.brandColor}"/></linearGradient>`;
    fillRef = `fill="url(#accentbg)" fill-opacity="0.95"`;
  } else {
    fillDef = `<linearGradient id="cardgrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${theme.brandColor}"/><stop offset="1" stop-color="${theme.accentColor}"/></linearGradient>`;
    fillRef = `fill="url(#cardgrad)" fill-opacity="0.97"`;
  }

  const radius = Math.min(52, Math.round(boxHeight / 2.8));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}">
    <defs>
      ${fillDef}
      <filter id="cardshadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="12" stdDeviation="18" flood-color="#000000" flood-opacity="0.6"/>
      </filter>
    </defs>
    <rect x="${margin}" y="${margin}" rx="${radius}" ry="${radius}"
          width="${boxWidth}" height="${boxHeight}" ${fillRef} filter="url(#cardshadow)"/>
    <text x="${textX}" y="${firstBaseline}" font-family="${FONT_FAMILY}" font-weight="bold"
          font-size="${fontSize}" fill="#ffffff" text-anchor="${anchor}"
          paint-order="stroke" stroke="#000000" stroke-width="${Math.max(2, Math.round(fontSize * 0.05))}"
          stroke-opacity="0.4">${tspans}</text>
  </svg>`;

  try {
    return await svgToPng(svg, path.join(workDir, `card-${randomUUID().slice(0, 8)}.png`));
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
/* Phone mockup renderer                                                      */
/* -------------------------------------------------------------------------- */

function buildPhoneFrameSvg(phoneW: number, phoneH: number): string {
  const c = 56; // outer corner radius
  const sx = 28, sy = 66;
  const sw = phoneW - 56;  // screen width
  const sh = phoneH - 132; // screen height
  const sr = 40; // screen corner radius

  const diW = 108, diH = 28, diR = 14;
  const diX = (phoneW - diW) / 2;
  const diY = sy + 10;

  // even-odd path: outer phone body MINUS screen hole = bezel only
  const outerPath =
    `M${c},0 H${phoneW - c} A${c},${c} 0 0 1 ${phoneW},${c}` +
    ` V${phoneH - c} A${c},${c} 0 0 1 ${phoneW - c},${phoneH}` +
    ` H${c} A${c},${c} 0 0 1 0,${phoneH - c}` +
    ` V${c} A${c},${c} 0 0 1 ${c},0 Z`;
  const screenPath =
    `M${sx + sr},${sy} H${sx + sw - sr} A${sr},${sr} 0 0 1 ${sx + sw},${sy + sr}` +
    ` V${sy + sh - sr} A${sr},${sr} 0 0 1 ${sx + sw - sr},${sy + sh}` +
    ` H${sx + sr} A${sr},${sr} 0 0 1 ${sx},${sy + sh - sr}` +
    ` V${sy + sr} A${sr},${sr} 0 0 1 ${sx + sr},${sy} Z`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${phoneW}" height="${phoneH}">
    <defs>
      <filter id="phoneshadow" x="-30%" y="-10%" width="160%" height="120%">
        <feDropShadow dx="0" dy="20" stdDeviation="32" flood-color="#000000" flood-opacity="0.8"/>
      </filter>
      <linearGradient id="phoneluster" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#1e2035"/>
        <stop offset="0.5" stop-color="#13162a"/>
        <stop offset="1" stop-color="#0b0d1e"/>
      </linearGradient>
      <linearGradient id="edgesheen" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#3a3d5e"/>
        <stop offset="0.5" stop-color="#1e2035"/>
        <stop offset="1" stop-color="#2a2d4a"/>
      </linearGradient>
    </defs>
    <path fill-rule="evenodd" fill="url(#phoneluster)" filter="url(#phoneshadow)"
      d="${outerPath} ${screenPath}"/>
    <path fill="none" stroke="url(#edgesheen)" stroke-width="2.5" fill-rule="evenodd"
      d="M${c + 1},1 H${phoneW - c - 1} A${c - 1},${c - 1} 0 0 1 ${phoneW - 1},${c + 1}
         V${phoneH - c - 1} A${c - 1},${c - 1} 0 0 1 ${phoneW - c - 1},${phoneH - 1}
         H${c + 1} A${c - 1},${c - 1} 0 0 1 1,${phoneH - c - 1}
         V${c + 1} A${c - 1},${c - 1} 0 0 1 ${c + 1},1 Z"/>
    <rect x="${diX}" y="${diY}" width="${diW}" height="${diH}" rx="${diR}" ry="${diR}" fill="#06070f"/>
    <circle cx="${diX + diW - 18}" cy="${diY + diH / 2}" r="7" fill="#101220"/>
    <circle cx="${diX + diW - 18}" cy="${diY + diH / 2}" r="3.5" fill="#1a1c30" opacity="0.8"/>
    <rect x="${diX + 12}" y="${diY + 10}" width="5" height="8" rx="2.5" fill="#0d0e1a"/>
    <rect x="${(phoneW - 104) / 2}" y="${phoneH - 16}" width="104" height="5" rx="2.5" fill="#2e3155"/>
    <rect x="-4" y="${Math.round(phoneH * 0.22)}" width="7" height="38" rx="3.5" fill="#1a1c30"/>
    <rect x="-4" y="${Math.round(phoneH * 0.32)}" width="7" height="38" rx="3.5" fill="#1a1c30"/>
    <rect x="${phoneW - 3}" y="${Math.round(phoneH * 0.27)}" width="7" height="54" rx="3.5" fill="#1a1c30"/>
    <rect x="${sx}" y="${sy}" width="${sw}" height="${sh}" rx="${sr}" ry="${sr}" fill="none" stroke="#202340" stroke-width="1"/>
    <text x="${sx + 16}" y="${sy + 52}" font-family="sans-serif" font-size="11" font-weight="700" fill="#c0c4e0">9:41</text>
    <rect x="${sx + sw - 34}" y="${sy + 40}" width="22" height="11" rx="3" fill="none" stroke="#707090" stroke-width="1.5"/>
    <rect x="${sx + sw - 33}" y="${sy + 41.5}" width="16" height="8" rx="2" fill="#4ade80"/>
    <rect x="${sx + sw - 11}" y="${sy + 43}" width="3" height="6" rx="1.5" fill="#707090"/>
    <rect x="${sx + sw - 64}" y="${sy + 42}" width="4" height="10" rx="1" fill="#c0c4e0" opacity="0.5"/>
    <rect x="${sx + sw - 58}" y="${sy + 40}" width="4" height="12" rx="1" fill="#c0c4e0" opacity="0.75"/>
    <rect x="${sx + sw - 52}" y="${sy + 38}" width="4" height="14" rx="1" fill="#c0c4e0"/>
  </svg>`;
}

async function renderPhoneMockup(
  contentBuffer: Buffer | null,
  workDir: string,
  theme: VisualTheme
): Promise<ImageAsset | null> {
  const phoneW = 500;
  const phoneH = 960;
  const sx = 28, sy = 66, sw = 444, sh = 828, sr = 40;

  try {
    let screenPng: Buffer;
    if (contentBuffer) {
      screenPng = await sharp(contentBuffer)
        .resize(sw, sh, { fit: "cover", position: "top" })
        .png()
        .toBuffer();
    } else {
      const gradSvg = `<svg width="${sw}" height="${sh}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${theme.gradientStart}"/>
            <stop offset="1" stop-color="${theme.gradientEnd}"/>
          </linearGradient>
        </defs>
        <rect width="${sw}" height="${sh}" fill="url(#sg)"/>
        <text x="${sw / 2}" y="${sh / 2}" font-family="sans-serif" font-size="32"
              fill="rgba(255,255,255,0.15)" text-anchor="middle">App</text>
      </svg>`;
      screenPng = await sharp(Buffer.from(gradSvg)).png().toBuffer();
    }

    const clipMask = Buffer.from(
      `<svg width="${sw}" height="${sh}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${sw}" height="${sh}" rx="${sr}" ry="${sr}" fill="white"/>
      </svg>`
    );
    const clippedScreen = await sharp(screenPng)
      .composite([{ input: clipMask, blend: "dest-in" }])
      .png()
      .toBuffer();

    const framePng = await sharp(Buffer.from(buildPhoneFrameSvg(phoneW, phoneH)))
      .png()
      .toBuffer();

    const final = await sharp({
      create: { width: phoneW, height: phoneH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } }
    })
      .composite([
        { input: clippedScreen, left: sx, top: sy },
        { input: framePng, left: 0, top: 0 }
      ])
      .png()
      .toBuffer();

    const outputPath = path.join(workDir, `phone-${randomUUID().slice(0, 8)}.png`);
    await writeFile(outputPath, final);

    return { path: outputPath, width: phoneW, height: phoneH };
  } catch (error) {
    console.warn("Phone mockup rendering failed; skipping", { error });
    return null;
  }
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
    return rasterizeImageAsset(buffer, {
      maxWidth: 300,
      maxHeight: 480,
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

  // ─── Scene 1: optional presenter (video/image, bottom-right) ────────────
  if (options.includeMedia) {
    const presenterScene1End = fmt(timeline.scene1End - 0.1);

    if (assets.presenterPath) {
      console.info(`  Rendering presenter: ${path.basename(assets.presenterPath)}`);
    } else {
      console.info("  Presenter: none available (add files to public/assets/presenters/)");
    }

    const presenterAsset = await renderPresenter(assets.presenterPath, workDir);

    if (presenterAsset) {
      console.info("  ✓ Presenter overlay registered");
      const presX = fmt(OUTPUT_WIDTH - presenterAsset.width - SAFE_X);
      const presY = fmt(OUTPUT_HEIGHT - presenterAsset.height - 120);
      registerOverlay(
        presenterAsset.path,
        presenterAsset.path,
        false,
        `format=rgba,${alphaFade(0.1, presenterScene1End)}`,
        `x=${presX}:y='${slideY(presY, 0.1, 60)}':enable='between(t,0.1,${presenterScene1End})'`
      );
    } else if (assets.presenterPath) {
      console.warn("  ✗ Presenter rendering failed; skipping overlay");
    }
  }

  // ─── Scene 2: Phone mockup + logo + GIF ──────────────────────────────────
  if (options.includeMedia) {
    const heroUrl = firstDefined([
      assets.website.heroImageUrl,
      assets.website.ogImageUrl,
      ...assets.website.screenshotUrls
    ]);

    if (heroUrl) {
      console.info(`  Fetching hero image: ${heroUrl}`);
    } else {
      console.info("  Hero image: none scraped from website → phone will show gradient screen");
    }

    const heroBuffer = (await fetchRemoteImageBuffer(heroUrl)) ?? null;

    if (heroBuffer) {
      console.info(`  ✓ Hero image downloaded (${heroBuffer.length} bytes)`);
    } else if (heroUrl) {
      console.warn(`  ✗ Hero image download failed: ${heroUrl}`);
    }

    // Render phone mockup (product screenshot inside phone frame)
    const phoneMockup = await renderPhoneMockup(heroBuffer, workDir, theme);

    if (phoneMockup) {
      console.info("  ✓ Phone mockup created");
      // Scale phone to ~460px wide so it fits the 1080-wide frame nicely
      const phoneTargetW = 460;
      const phoneTargetH = Math.round(phoneMockup.height * (phoneTargetW / phoneMockup.width));
      const phoneY = Math.max(280, Math.round((OUTPUT_HEIGHT - phoneTargetH) / 2) - 80);
      registerOverlay(
        phoneMockup.path,
        phoneMockup.path,
        false,
        `scale=${phoneTargetW}:-1:flags=lanczos,format=rgba,${alphaFade(timeline.scene1End, timeline.scene2End)}`,
        `x=(W-w)/2:y='${slideY(phoneY, timeline.scene1End, 80)}':enable='between(t,${timeline.scene1End},${timeline.scene2End})'`
      );
    } else {
      console.warn("  ✗ Phone mockup rendering failed; falling back to flat product image");
      // Fallback: rasterized product image with rounded corners
      const productImage = await rasterizeImageAsset(heroBuffer, {
        maxWidth: 840,
        maxHeight: 1000,
        workDir,
        rounded: true,
        radius: 48
      });
      if (productImage) {
        registerOverlay(
          productImage.path,
          productImage.path,
          false,
          `format=rgba,${alphaFade(timeline.scene1End, timeline.scene2End)}`,
          `x=(W-w)/2:y='${slideY(440, timeline.scene1End)}':enable='between(t,${timeline.scene1End},${timeline.scene2End})'`
        );
      }
    }

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
      maxWidth: 240,
      maxHeight: 140,
      workDir,
      rounded: true,
      radius: 20
    });

    if (logoImage) {
      console.info("  ✓ Logo overlay registered");
      registerOverlay(
        logoImage.path,
        logoImage.path,
        false,
        `format=rgba,${alphaFade(timeline.scene1End, timeline.scene2End)}`,
        `x=${SAFE_X}:y=100:enable='between(t,${timeline.scene1End},${timeline.scene2End})'`
      );
    }

    // GIF: small, tasteful, bottom-left corner — 2-3s visible
    const gif = await prepareGif(assets.gif, workDir, timeline.duration);

    if (gif) {
      const gifStart = fmt(timeline.scene1End + 0.3);
      const gifEnd = fmt(Math.min(timeline.scene1End + 3.0, timeline.scene2End - 0.2));
      registerOverlay(
        gif.input,
        gif.cleanup,
        true,
        `scale=200:-1:flags=lanczos,format=rgba,${alphaFade(gifStart, gifEnd)}`,
        `x=${SAFE_X}:y=H-h-${SAFE_X}:enable='between(t,${gifStart},${gifEnd})'`
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

  // Scene 1: hook — top section, clean white text, soft outline
  const hookStart = 0.15;
  const hookEnd = fmt(timeline.scene1End - 0.1);
  pushCard(
    {
      text: copy.hook,
      width: 940,
      fontSize: 76,
      align: "center",
      style: "outline",
      theme,
      workDir,
      maxLines: 2
    },
    hookStart,
    hookEnd,
    () => `x=(W-w)/2:y='${slideY(160, hookStart, 50)}'`
  );

  // Scene 2: product name — glass card, upper area
  const nameStart = fmt(timeline.scene1End + 0.15);
  const nameEnd = timeline.scene2End;
  pushCard(
    {
      text: copy.productName,
      width: 680,
      fontSize: 48,
      align: "center",
      style: "glass",
      theme,
      workDir,
      maxLines: 1
    },
    nameStart,
    nameEnd,
    () => `x=(W-w)/2:y='${slideY(200, nameStart, 40)}'`
  );

  // Scene 2: one feature caption — glass card, below phone mockup
  const featureStart = fmt(timeline.scene1End + 0.6);
  const featureEnd = fmt(timeline.scene2End - 0.05);
  pushCard(
    {
      text: copy.featureOne,
      width: 920,
      fontSize: 46,
      align: "center",
      style: "glass",
      theme,
      workDir,
      maxLines: 2
    },
    featureStart,
    featureEnd,
    () => `x=(W-w)/2:y='${slideY(1380, featureStart, 40)}'`
  );

  // Scene 3: CTA — clean glass card, center screen
  const ctaStart = fmt(timeline.scene2End + 0.15);
  const ctaEnd = fmt(timeline.duration - 0.15);
  pushCard(
    {
      text: copy.cta,
      width: 860,
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
      return;
    }

    const overlay = cards[index];
    const cardIndex = inputs.length;
    inputs.push({
      input: asset.path,
      inputOptions: ["-loop", "1", "-t", String(timeline.duration)],
      cleanup: asset.path
    });
    overlays.push({
      inputIndex: cardIndex,
      prep: `format=rgba,${alphaFade(overlay.start, overlay.end)}`,
      overlayOptions: `${overlay.placement(asset)}:enable='between(t,${overlay.start},${overlay.end})'`
    });
  });

  return { inputs, background, overlays, audioIndex, timeline };
}

function buildFilterGraph(plan: RenderPlan) {
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

export async function generateUgcVideo(
  analysis: ProductAnalysis,
  assets: GenerationAssets
): Promise<GeneratedVideo> {
  ffmpeg.setFfmpegPath(getFfmpegExecutablePath());

  const generatedDirectory = path.join(process.cwd(), "public", "generated");
  const workDir = path.join(tmpdir(), `ugc-${randomUUID()}`);
  const filename = `ugc-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
  const outputPath = path.join(generatedDirectory, filename);

  await mkdir(generatedDirectory, { recursive: true });
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

        console.info(`✓ Video rendered successfully: /generated/${filename} (${Math.round(timeline.duration)}s, attempt: ${attempt.label})`);

        return {
          videoPath: `/generated/${filename}`,
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
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
