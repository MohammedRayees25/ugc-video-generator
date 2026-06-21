/**
 * Direct pipeline QA — bypasses Claude API.
 * Calls generateUgcVideo() with 5 mock product scenarios.
 */
import { statSync, existsSync } from "node:fs";
import path from "node:path";

import { generateUgcVideo } from "../lib/video-generator";
import type { ProductAnalysis } from "../features/chat/types/chat";
import type { GenerationAssets } from "../lib/assets";

const ASSETS_ROOT = path.join(process.cwd(), "public", "assets");

// Resolve absolute paths for local assets
const presenterLaughing = path.join(
  ASSETS_ROOT,
  "presenters",
  "vidssave.com Green Screen Guy Laughing On Another Meme _ Dr. Reasons Laughing Meme 720p.mp4"
);
const presenterShocked = path.join(
  ASSETS_ROOT,
  "presenters",
  "vidssave.com iShowSpeed Shocking - Green Screen 720P.mp4"
);
const gif = path.join(ASSETS_ROOT, "gifs", "giphy.gif");
const audio = path.join(ASSETS_ROOT, "audio", "Aetheric - Edge of Motion (freetouse.com).mp3");
const bg = path.join(ASSETS_ROOT, "backgrounds", "pexels-cottonbro-6804606.jpg");

const baseAssets: GenerationAssets = {
  background: { path: "/assets/backgrounds/pexels-cottonbro-6804606.jpg", source: "local" },
  gif: { path: "/assets/gifs/giphy.gif", source: "local" },
  audio: { path: "/assets/audio/Aetheric - Edge of Motion (freetouse.com).mp3", source: "local" },
  website: { screenshotUrls: [], brandColors: ["#6366f1"] },
  presenterPaths: {
    laughing: existsSync(presenterLaughing) ? presenterLaughing : null,
    shocked: existsSync(presenterShocked) ? presenterShocked : null,
  },
};

const SCENARIOS: Array<{ name: string; analysis: ProductAnalysis; assets: GenerationAssets }> = [
  {
    name: "Notion (productivity / funny hook)",
    analysis: {
      productName: "Notion",
      category: "productivity",
      targetAudience: "productivity enthusiasts",
      mainBenefits: ["organizes everything", "team collaboration", "customizable"],
      painPoints: ["scattered notes", "too many apps"],
      viralHook: "Me pretending I don't need Notion at 2am",
      caption: "All your notes, tasks & docs in one place",
      cta: "Start free today",
      hookVariations: ["Me pretending I don't need Notion at 2am", "Not me finding Notion at 2am"],
      featureCaptions: ["All your notes, tasks & docs in one place"],
      ctaCaptions: ["Start free today"],
      emotion: "excited",
      backgroundKeyword: "workspace",
      gifKeyword: "productive",
      musicMood: "upbeat",
      hashtags: ["#notion", "#productivity"],
    },
    assets: baseAssets,
  },
  {
    name: "Figma (design / shocking hook)",
    analysis: {
      productName: "Figma",
      category: "design",
      targetAudience: "designers and developers",
      mainBenefits: ["real-time collaboration", "prototyping", "free to start"],
      painPoints: ["slow handoff", "version conflicts"],
      viralHook: "Nobody told me this existed for design teams",
      caption: "Design, prototype & hand off in one tool",
      cta: "Try Figma free",
      hookVariations: ["Nobody told me this existed for design teams"],
      featureCaptions: ["Design, prototype & hand off in one tool"],
      ctaCaptions: ["Try Figma free"],
      emotion: "amazed",
      backgroundKeyword: "creative studio",
      gifKeyword: "amazed",
      musicMood: "cool",
      hashtags: ["#figma", "#design"],
    },
    assets: {
      ...baseAssets,
      website: { screenshotUrls: [], brandColors: ["#a259ff"] },
    },
  },
  {
    name: "Duolingo (education / funny hook)",
    analysis: {
      productName: "Duolingo",
      category: "education",
      targetAudience: "language learners",
      mainBenefits: ["gamified lessons", "5 minutes a day", "50+ languages"],
      painPoints: ["boring textbooks", "expensive classes"],
      viralHook: "POV: You finally started learning Spanish",
      caption: "Learn a new language in just 5 min/day",
      cta: "Download Duolingo free",
      hookVariations: ["POV: You finally started learning Spanish"],
      featureCaptions: ["Learn a new language in just 5 min/day"],
      ctaCaptions: ["Download Duolingo free"],
      emotion: "happy",
      backgroundKeyword: "learning",
      gifKeyword: "excited",
      musicMood: "fun",
      hashtags: ["#duolingo", "#learnspanish"],
    },
    assets: {
      ...baseAssets,
      website: { screenshotUrls: [], brandColors: ["#58cc02"] },
    },
  },
  {
    name: "Linear (SaaS / neutral hook)",
    analysis: {
      productName: "Linear",
      category: "saas",
      targetAudience: "software engineers",
      mainBenefits: ["blazing fast", "keyboard-first", "clean UI"],
      painPoints: ["slow issue trackers", "Jira fatigue"],
      viralHook: "I wish I knew this sooner",
      caption: "Ship faster with Linear's issue tracker",
      cta: "Try Linear free",
      hookVariations: ["I wish I knew this sooner"],
      featureCaptions: ["Ship faster with Linear's issue tracker"],
      ctaCaptions: ["Try Linear free"],
      emotion: "impressed",
      backgroundKeyword: "tech office",
      gifKeyword: "mind blown",
      musicMood: "focused",
      hashtags: ["#linear", "#devtools"],
    },
    assets: {
      ...baseAssets,
      background: { path: "/assets/backgrounds/Streamlined-Productivity-Zone.webp", source: "local" },
      website: { screenshotUrls: [], brandColors: ["#5e6ad2"] },
    },
  },
  {
    name: "Calm (wellness / neutral hook)",
    analysis: {
      productName: "Calm",
      category: "wellness",
      targetAudience: "stressed adults",
      mainBenefits: ["guided meditation", "sleep stories", "breathing exercises"],
      painPoints: ["poor sleep", "daily stress"],
      viralHook: "Stop scrolling. You need this",
      caption: "Meditate, sleep better & reduce stress",
      cta: "Try Calm free for 7 days",
      hookVariations: ["Stop scrolling. You need this"],
      featureCaptions: ["Meditate, sleep better & reduce stress"],
      ctaCaptions: ["Try Calm free for 7 days"],
      emotion: "peaceful",
      backgroundKeyword: "nature relax",
      gifKeyword: "relaxed",
      musicMood: "calm",
      hashtags: ["#calm", "#meditation"],
    },
    assets: {
      ...baseAssets,
      website: { screenshotUrls: [], brandColors: ["#4a90d9"] },
    },
  },
];

async function runQA() {
  console.log(`\nAsset check:`);
  console.log(`  Presenter (laughing): ${existsSync(presenterLaughing) ? "✓" : "✗ MISSING"} ${path.basename(presenterLaughing)}`);
  console.log(`  Presenter (shocked):  ${existsSync(presenterShocked) ? "✓" : "✗ MISSING"} ${path.basename(presenterShocked)}`);
  console.log(`  GIF:                  ${existsSync(gif) ? "✓" : "✗ MISSING"}`);
  console.log(`  Audio:                ${existsSync(audio) ? "✓" : "✗ MISSING"}`);
  console.log(`  Background:           ${existsSync(bg) ? "✓" : "✗ MISSING"}`);
  console.log();

  const results: Array<{ name: string; passed: boolean; checks: string[]; issues: string[] }> = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];
    console.log("=".repeat(70));
    console.log(`[${i + 1}/5] ${scenario.name}`);
    console.log("=".repeat(70));

    const checks: string[] = [];
    const issues: string[] = [];

    try {
      const started = Date.now();
      const result = await generateUgcVideo(scenario.analysis, scenario.assets);
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);

      console.log(`\n  ✓ Generated in ${elapsed}s → ${result.videoPath}`);

      // Check duration
      if (result.duration >= 5 && result.duration <= 12) {
        checks.push(`Duration: ${result.duration}s ✓`);
      } else {
        issues.push(`Duration: ${result.duration}s (expected 5–12s)`);
      }

      // Check file exists and has reasonable size
      // videoPath may be a URL (/generated/...) or absolute path
      const fsPath = result.videoPath.startsWith("/")
        ? result.videoPath.startsWith("/generated/")
          ? path.join(process.cwd(), "public", result.videoPath)
          : result.videoPath
        : result.videoPath;
      if (existsSync(fsPath)) {
        const sizeMb = (statSync(fsPath).size / 1024 / 1024).toFixed(1);
        if (parseFloat(sizeMb) > 0.5) {
          checks.push(`File size: ${sizeMb} MB ✓`);
        } else {
          issues.push(`File size too small: ${sizeMb} MB`);
        }
      } else {
        issues.push(`Output file not found at ${fsPath}`);
      }

      checks.push(`Filename: ${result.filename} ✓`);

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      issues.push(`RENDER FAILED: ${msg}`);
      console.error(`\n  ✗ Failed: ${msg}`);
    }

    const passed = issues.length === 0;
    results.push({ name: scenario.name, passed, checks, issues });

    for (const c of checks) console.log(`  ✓ ${c}`);
    for (const iss of issues) console.log(`  ✗ ${iss}`);
    console.log();
  }

  // Final summary
  console.log("=".repeat(70));
  console.log("QA SUMMARY");
  console.log("=".repeat(70));
  const passed = results.filter((r) => r.passed).length;
  for (const r of results) {
    console.log(`  ${r.passed ? "✓" : "✗"} ${r.name}`);
    if (!r.passed) {
      for (const iss of r.issues) console.log(`      ↳ ${iss}`);
    }
  }
  console.log();
  console.log(`Result: ${passed}/${results.length} scenarios passed`);

  if (passed === results.length) {
    console.log("\n✅ Pipeline is ready for submission.");
  } else {
    console.log("\n⚠️  Some scenarios failed — see issues above.");
    process.exit(1);
  }
}

runQA().catch((err) => {
  console.error("QA script crashed:", err);
  process.exit(1);
});
