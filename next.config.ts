import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Prevent webpack from bundling native Node.js packages that rely on
  // binary files or native addons — they must be required at runtime from
  // node_modules, not inlined into the JS bundle.
  serverExternalPackages: ["sharp", "ffmpeg-static", "fluent-ffmpeg"],

  // Force Next.js output-file-tracing to include the ffmpeg binary.
  // Without this, the native executable is invisible to the static-import
  // tracer and gets omitted from the Vercel serverless-function bundle.
  outputFileTracingIncludes: {
    "/api/chat": [
      "./node_modules/ffmpeg-static/ffmpeg",
      "./node_modules/ffmpeg-static/ffmpeg.exe",
    ],
  },
};

export default nextConfig;
