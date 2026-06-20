import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductAnalysis } from "@/features/chat/types/chat";
import type { AssetReference, GenerationAssets } from "@/lib/assets";

export type GeneratedVideo = {
  videoPath: string;
  duration: number;
  filename: string;
};

type PreparedAsset = {
  input: string;
  inputOptions: string[];
  cleanup?: string;
};

const VIDEO_DURATION_SECONDS = 8;
const OUTPUT_WIDTH = 1080;
const OUTPUT_HEIGHT = 1920;
const OUTPUT_FPS = 30;
const SAFE_X = 86;

export class VideoGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoGenerationError";
  }
}

function resolveFfmpegExecutablePath() {
  const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

  return path.join(
    process.cwd(),
    "node_modules",
    "ffmpeg-static",
    executableName
  );
}

function getFfmpegExecutablePath() {
  const executablePath = resolveFfmpegExecutablePath();

  if (!existsSync(executablePath)) {
    throw new VideoGenerationError(
      `FFmpeg executable was not found at ${executablePath}. Reinstall dependencies with npm install and try again.`
    );
  }

  return executablePath;
}

function publicPathToFilePath(publicPath: string) {
  return path.join(process.cwd(), "public", publicPath.replace(/^\//, ""));
}

function toFfmpegPath(filePath: string) {
  return process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
}

function escapeDrawTextText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/\r?\n|\r/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/&/g, "\\&")
    .replace(/;/g, "\\;")
    .replace(/=/g, "\\=")
    .replace(/%/g, "\\%")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .slice(0, 90);
}

function escapeDrawTextOption(value: string) {
  return value.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function pickRandom<T>(values: T[], fallback: T): T {
  if (values.length === 0) {
    return fallback;
  }

  return values[Math.floor(Math.random() * values.length)] ?? fallback;
}

function limitWords(value: string, maxWords = 8) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .join(" ");
}

function normalizeCaption(value: string, fallback: string) {
  const caption = limitWords(value || fallback);

  return escapeDrawTextText(caption || fallback);
}

function sanitizeHexColor(value: string | undefined, fallback: string) {
  if (value && /^#[0-9a-fA-F]{6}$/.test(value)) {
    return value;
  }

  return fallback;
}

function getVisualTheme(analysis: ProductAnalysis, assets: GenerationAssets) {
  const category = analysis.category.toLowerCase();
  const brandColor = sanitizeHexColor(
    pickRandom(assets.website.brandColors, ""),
    "#22c55e"
  );
  const accentColor =
    category.includes("finance") || category.includes("ai")
      ? "#38bdf8"
      : category.includes("beauty") || category.includes("fashion")
        ? "#f472b6"
        : category.includes("food") || category.includes("fitness")
          ? "#facc15"
          : brandColor;

  return {
    brandColor,
    accentColor,
    darkOverlay: "#09090b"
  };
}

function buildSceneCopy(analysis: ProductAnalysis) {
  const features = [
    ...analysis.featureCaptions,
    ...analysis.mainBenefits,
    analysis.caption
  ].filter(Boolean);

  return {
    hook: normalizeCaption(
      pickRandom(analysis.hookVariations, analysis.viralHook),
      analysis.viralHook
    ),
    featureOne: normalizeCaption(pickRandom(features, analysis.caption), analysis.caption),
    featureTwo: normalizeCaption(
      pickRandom(features, analysis.mainBenefits[0] ?? analysis.productName),
      analysis.productName
    ),
    cta: normalizeCaption(pickRandom(analysis.ctaCaptions, analysis.cta), analysis.cta),
    productName: normalizeCaption(analysis.productName, "This product")
  };
}

function getFontFile() {
  const candidates = [
    "C:\\Windows\\Fonts\\arial.ttf",
    "C:\\Windows\\Fonts\\segoeui.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf"
  ];

  return candidates.find((candidate) => existsSync(candidate));
}

function normalizeRemoteExtension(url: string, fallback: string) {
  const pathname = new URL(url).pathname;
  const extension = path.extname(pathname).split("?")[0];

  return extension || fallback;
}

function isProbablySvgUrl(rawUrl: string | undefined) {
  if (!rawUrl) {
    return false;
  }

  try {
    const url = new URL(rawUrl);
    const href = url.href.toLowerCase();

    return (
      href.includes(".svg") ||
      url.searchParams.get("f")?.toLowerCase() === "svg" ||
      url.searchParams.get("format")?.toLowerCase() === "svg"
    );
  } catch {
    return rawUrl.toLowerCase().includes(".svg");
  }
}

function selectRasterWebsiteImage(
  candidates: Array<string | undefined>
) {
  return candidates.find((candidate) => candidate && !isProbablySvgUrl(candidate));
}

async function downloadRemoteAsset(asset: AssetReference, fallbackExtension: string) {
  const extension = normalizeRemoteExtension(asset.path, fallbackExtension);
  const filename = `ugc-asset-${randomUUID()}${extension}`;
  const outputPath = path.join(tmpdir(), filename);
  const response = await axios.get<ArrayBuffer>(asset.path, {
    responseType: "arraybuffer",
    timeout: 20_000
  });

  await writeFile(outputPath, Buffer.from(response.data));

  return outputPath;
}

async function prepareVideoInput(asset: AssetReference): Promise<PreparedAsset> {
  try {
    const filePath =
      asset.source === "remote"
        ? await downloadRemoteAsset(asset, ".mp4")
        : publicPathToFilePath(asset.path);

    if (existsSync(filePath)) {
      return {
        input: filePath,
        inputOptions: ["-stream_loop", "-1"],
        cleanup: asset.source === "remote" ? filePath : undefined
      };
    }
  } catch (error) {
    console.warn("Background asset preparation failed; using generated fallback", {
      asset,
      error
    });
  }

  return {
    input: `color=c=#111827:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${OUTPUT_FPS}:d=${VIDEO_DURATION_SECONDS}`,
    inputOptions: ["-f", "lavfi"]
  };
}

async function prepareGifInput(asset: AssetReference): Promise<PreparedAsset> {
  try {
    const filePath =
      asset.source === "remote"
        ? await downloadRemoteAsset(asset, ".gif")
        : publicPathToFilePath(asset.path);

    if (existsSync(filePath)) {
      return {
        input: filePath,
        inputOptions: ["-stream_loop", "-1"],
        cleanup: asset.source === "remote" ? filePath : undefined
      };
    }
  } catch (error) {
    console.warn("GIF asset preparation failed; using generated fallback", {
      asset,
      error
    });
  }

  return {
    input: `testsrc2=size=420x420:rate=15:duration=${VIDEO_DURATION_SECONDS}`,
    inputOptions: ["-f", "lavfi"]
  };
}

async function prepareImageInput(
  rawUrl: string | undefined,
  fallbackExtension = ".png"
): Promise<PreparedAsset> {
  if (rawUrl) {
    if (isProbablySvgUrl(rawUrl)) {
      console.warn("Skipping SVG website visual; using generated fallback", {
        rawUrl
      });
      return {
        input: `color=c=white@0.0:s=720x720:r=${OUTPUT_FPS}:d=${VIDEO_DURATION_SECONDS}`,
        inputOptions: ["-f", "lavfi"]
      };
    }

    try {
      const filePath = await downloadRemoteAsset(
        { path: rawUrl, source: "remote" },
        fallbackExtension
      );

      if (existsSync(filePath)) {
        return {
          input: filePath,
          inputOptions: ["-loop", "1", "-t", String(VIDEO_DURATION_SECONDS)],
          cleanup: filePath
        };
      }
    } catch (error) {
      console.warn("Website visual preparation failed; using generated fallback", {
        rawUrl,
        error
      });
    }
  }

  return {
    input: `color=c=white@0.0:s=720x720:r=${OUTPUT_FPS}:d=${VIDEO_DURATION_SECONDS}`,
    inputOptions: ["-f", "lavfi"]
  };
}

function prepareAudioInput(asset: AssetReference): PreparedAsset {
  const filePath = publicPathToFilePath(asset.path);

  if (existsSync(filePath)) {
    return {
      input: filePath,
      inputOptions: ["-stream_loop", "-1"]
    };
  }

  console.warn("Audio asset missing; using silent fallback", { asset });

  return {
    input: "anullsrc=channel_layout=stereo:sample_rate=44100",
    inputOptions: ["-f", "lavfi"]
  };
}

function addPreparedInput(command: ffmpeg.FfmpegCommand, asset: PreparedAsset) {
  command.input(asset.input.includes(path.sep) ? toFfmpegPath(asset.input) : asset.input);

  if (asset.inputOptions.length > 0) {
    command.inputOptions(asset.inputOptions);
  }
}

function buildDrawTextFilter({
  inputLabel,
  outputLabel,
  text,
  fontFile,
  fontSize,
  boxColor,
  boxBorderWidth,
  x,
  y,
  enable
}: {
  inputLabel: string;
  outputLabel: string;
  text: string;
  fontFile: string | undefined;
  fontSize: number;
  boxColor: string;
  boxBorderWidth: number;
  x: string;
  y: string | number;
  enable: string;
}) {
  const options = [
    `text=${text}`,
    fontFile ? `fontfile=${escapeDrawTextOption(fontFile)}` : "",
    "fontcolor=white",
    `fontsize=${fontSize}`,
    "line_spacing=14",
    "shadowcolor=black@0.75",
    "shadowx=4",
    "shadowy=5",
    "box=1",
    `boxcolor=${boxColor}`,
    `boxborderw=${boxBorderWidth}`,
    `x=${x}`,
    `y=${y}`,
    `enable='${enable}'`,
    "expansion=none"
  ].filter(Boolean);

  return `${inputLabel}drawtext=${options.join(":")}${outputLabel}`;
}

function validateFilterString(filter: string) {
  if (!filter.trim()) {
    throw new VideoGenerationError("Generated an empty FFmpeg filter.");
  }

  if (filter.includes("::")) {
    throw new VideoGenerationError(
      `Generated invalid FFmpeg filter with duplicate option separator: ${filter}`
    );
  }

  if (/enable='[^']*\+[^']*between/.test(filter)) {
    throw new VideoGenerationError(
      `Generated invalid FFmpeg enable expression with plus operator: ${filter}`
    );
  }

  if (/drawtext=[^;]*[\r\n]/.test(filter)) {
    throw new VideoGenerationError(
      `Generated invalid FFmpeg drawtext filter with a newline: ${filter}`
    );
  }

  if (/drawtext=.*text='/.test(filter)) {
    throw new VideoGenerationError(
      `Generated invalid FFmpeg drawtext filter with a quoted text value: ${filter}`
    );
  }
}

function validateFilters(filters: string[]) {
  for (const filter of filters) {
    validateFilterString(filter);
  }

  return filters;
}

function buildFilters(analysis: ProductAnalysis, assets: GenerationAssets) {
  const fontFile = getFontFile();
  const copy = buildSceneCopy(analysis);
  const theme = getVisualTheme(analysis, assets);
  const hookY = 250 + Math.floor(Math.random() * 90);
  const featureY = 1170 + Math.floor(Math.random() * 80);
  const ctaY = 1430 + Math.floor(Math.random() * 80);
  const gifY = 1030 + Math.floor(Math.random() * 160);
  const productY = 430 + Math.floor(Math.random() * 80);

  return validateFilters([
    `[0:v]scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT},fps=${OUTPUT_FPS},format=rgba,eq=contrast=1.08:saturation=1.22,fade=t=in:st=0:d=0.22,fade=t=out:st=7.65:d=0.35[bg]`,
    `[3:v]scale=760:760:force_original_aspect_ratio=decrease,format=rgba,fade=t=in:st=2:d=0.25:alpha=1,fade=t=out:st=5.25:d=0.25:alpha=1[product]`,
    "[4:v]scale=190:190:force_original_aspect_ratio=decrease,format=rgba[logo]",
    "[1:v]scale=330:-1,format=rgba[gif]",
    `[bg]drawbox=x=0:y=0:w=${OUTPUT_WIDTH}:h=${OUTPUT_HEIGHT}:color=${theme.darkOverlay}@0.22:t=fill[base]`,
    `[base][product]overlay=x=(W-w)/2:y=${productY}:enable='between(t,2,5.6)'[withproduct]`,
    `[withproduct][logo]overlay=x=${SAFE_X}:y=92:enable='between(t,2,5.8)'[withlogo]`,
    `[withlogo][gif]overlay=x=W-w-${SAFE_X}:y=${gifY}:enable='between(t,0.65,6.2)'[withgif]`,
    `[withgif]drawbox=x=0:y=630:w=${OUTPUT_WIDTH}:h=18:color=${theme.accentColor}@0.8:t=fill:enable='if(between(t,1.85,2.08),1,between(t,4.95,5.18))'[cuts]`,
    buildDrawTextFilter({
      inputLabel: "[cuts]",
      outputLabel: "[hook]",
      text: copy.hook,
      fontFile,
      fontSize: 78,
      boxColor: `${theme.darkOverlay}@0.72`,
      boxBorderWidth: 34,
      x: "(w-text_w)/2",
      y: hookY,
      enable: "between(t,0.12,2.05)"
    }),
    buildDrawTextFilter({
      inputLabel: "[hook]",
      outputLabel: "[name]",
      text: copy.productName,
      fontFile,
      fontSize: 58,
      boxColor: `${theme.brandColor}@0.82`,
      boxBorderWidth: 24,
      x: "(w-text_w)/2",
      y: 310,
      enable: "between(t,2.08,5.25)"
    }),
    buildDrawTextFilter({
      inputLabel: "[name]",
      outputLabel: "[feature1]",
      text: copy.featureOne,
      fontFile,
      fontSize: 56,
      boxColor: "black@0.58",
      boxBorderWidth: 22,
      x: String(SAFE_X),
      y: featureY,
      enable: "between(t,2.45,4.0)"
    }),
    buildDrawTextFilter({
      inputLabel: "[feature1]",
      outputLabel: "[feature2]",
      text: copy.featureTwo,
      fontFile,
      fontSize: 56,
      boxColor: `${theme.accentColor}@0.78`,
      boxBorderWidth: 22,
      x: String(SAFE_X),
      y: featureY + 112,
      enable: "between(t,3.55,5.25)"
    }),
    buildDrawTextFilter({
      inputLabel: "[feature2]",
      outputLabel: "[cta]",
      text: copy.cta,
      fontFile,
      fontSize: 76,
      boxColor: `${theme.brandColor}@0.88`,
      boxBorderWidth: 32,
      x: "(w-text_w)/2",
      y: ctaY,
      enable: "between(t,5.1,7.72)"
    }),
    `[cta]drawbox=x=${SAFE_X}:y=1650:w=${OUTPUT_WIDTH - SAFE_X * 2}:h=10:color=white@0.85:t=fill:enable='between(t,5.25,7.72)'[vout]`
  ]);
}

async function cleanupAssets(assets: PreparedAsset[]) {
  await Promise.all(
    assets
      .map((asset) => asset.cleanup)
      .filter((cleanup): cleanup is string => Boolean(cleanup))
      .map((cleanup) => rm(cleanup, { force: true }))
  );
}

export async function generateUgcVideo(
  analysis: ProductAnalysis,
  assets: GenerationAssets
): Promise<GeneratedVideo> {
  ffmpeg.setFfmpegPath(getFfmpegExecutablePath());

  const generatedDirectory = path.join(process.cwd(), "public", "generated");
  const filename = `ugc-${Date.now()}-${randomUUID().slice(0, 8)}.mp4`;
  const outputPath = path.join(generatedDirectory, filename);
  const ffmpegOutputPath = `public/generated/${filename}`;
  const preparedAssets = await Promise.all([
    prepareVideoInput(assets.background),
    prepareGifInput(assets.gif),
    Promise.resolve(prepareAudioInput(assets.audio)),
    prepareImageInput(
      selectRasterWebsiteImage([
        assets.website.heroImageUrl,
        assets.website.ogImageUrl,
        ...assets.website.screenshotUrls
      ])
    ),
    prepareImageInput(selectRasterWebsiteImage([assets.website.logoUrl]))
  ]);

  await mkdir(generatedDirectory, { recursive: true });

  try {
    await new Promise<void>((resolve, reject) => {
      const command = ffmpeg();
      const stderrLines: string[] = [];

      for (const asset of preparedAssets) {
        addPreparedInput(command, asset);
      }

      const filterComplex = buildFilters(analysis, assets);
      const printedFilterComplex = filterComplex.join(";");

      console.info("FFmpeg filter_complex", { filterComplex: printedFilterComplex });

      command
        .complexFilter(filterComplex)
        .outputOptions([
          "-map",
          "[vout]",
          "-map",
          "2:a",
          "-t",
          String(VIDEO_DURATION_SECONDS),
          "-r",
          String(OUTPUT_FPS),
          "-c:v",
          "libx264",
          "-c:a",
          "aac",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          "-shortest"
        ])
        .on("start", (startedCommandLine) => {
          console.info("Starting FFmpeg render", {
            commandLine: startedCommandLine
          });
        })
        .on("stderr", (line) => {
          stderrLines.push(line);
          if (stderrLines.length > 24) {
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
        .save(ffmpegOutputPath);
    });

    return {
      videoPath: `/generated/${filename}`,
      duration: VIDEO_DURATION_SECONDS,
      filename
    };
  } finally {
    await cleanupAssets(preparedAssets);
  }
}
