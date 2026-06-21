import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Prevent webpack from bundling native Node.js packages that rely on
  // binary files or native addons — they must be required at runtime from
  // node_modules, not inlined into the JS bundle.
  serverExternalPackages: ["sharp", "ffmpeg-static", "fluent-ffmpeg", "@resvg/resvg-js"],

  // Force Next.js output-file-tracing to include the ffmpeg binary AND the
  // bundled caption fonts. Without this the native executable and the .ttf
  // files are invisible to the static-import tracer and get omitted from the
  // Vercel serverless-function bundle — which is THE root cause of captions
  // rendering as invisible/blank text in production (resvg finds no font and,
  // with no system fonts on Lambda, draws nothing).
  //
  // The key is matched against the route. We list several patterns so the
  // include applies regardless of how this Next version normalises the App
  // Router route handler path (/api/chat vs the source file glob).
  outputFileTracingIncludes: {
    "/api/chat": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
      "./public/fonts/**",
    ],
    "/api/**": ["./public/fonts/**"],
    "app/api/chat/route": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./public/fonts/**",
    ],
  },
};

export default nextConfig;
