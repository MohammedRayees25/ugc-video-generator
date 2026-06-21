# 🎬 UGC Video Generator

A Next.js application that converts a product URL into a short-form UGC (User Generated Content) marketing video using AI-powered product analysis and FFmpeg video composition.

Built as part of a Founding Engineer technical assessment.

---

## 🚀 Features

- 💬 ChatGPT-style conversational interface
- 🌐 Automatic product URL detection
- 🔍 Website scraping and metadata extraction
- 🧠 Claude-powered product analysis
- 🎯 AI-generated marketing hooks, feature highlights, and CTAs
- 🖼️ Dynamic asset selection
- 🎥 FFmpeg-powered vertical UGC video generation
- 🏷️ Logo and hero image extraction
- 🖌️ SVG to PNG conversion for rendering
- 🎨 Brand-aware visual composition
- 📱 1080×1920 vertical video output
- 🔄 Randomized captions and layouts for varied results
- 🛡️ Graceful fallbacks for missing assets

---

## 🏗️ Tech Stack

### Frontend
- Next.js 15
- React
- TypeScript
- Tailwind CSS

### Backend
- Next.js Route Handlers
- Anthropic SDK (Claude)

### Video Processing
- FFmpeg
- Sharp

### Web Scraping
- Axios
- Cheerio

---

## 📂 Project Structure

```
app/
 ├── api/chat
 ├── layout.tsx
 └── page.tsx

features/
 └── chat/

lib/
 ├── anthropic-config.ts
 ├── scraper.ts
 ├── product-analysis.ts
 ├── assets.ts
 └── video-generator.ts

public/
 ├── assets/
 └── generated/
```

---

# ⚙️ How It Works

```
User Message
      │
      ▼
URL Detection
      │
      ▼
Website Scraping
      │
      ▼
Claude Product Analysis
      │
      ▼
Asset Selection
      │
      ▼
FFmpeg Video Rendering
      │
      ▼
Generated MP4
      │
      ▼
Returned in Chat
```

---

## 🧠 Product Analysis

The application uses Claude to generate:

- Product summary
- Marketing hooks
- Feature highlights
- Call-to-action captions
- Product category
- Visual style suggestions

---

## 🎬 Video Generation

Each generated video contains:

- Background image/video
- Animated marketing captions
- Product logo
- Hero image
- GIF overlay
- CTA section
- Brand-aware styling
- Vertical 1080×1920 format

Videos are rendered using FFmpeg and saved to:

```
public/generated/
```

---

## 📦 Installation

Clone the repository

```bash
git clone https://github.com/MohammedRayees25/ugc-video-generator.git

cd ugc-video-generator
```

Install dependencies

```bash
npm install
```

---

## 🔑 Environment Variables

Create a `.env.local` file in the project root.

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
ANTHROPIC_MODEL=claude-sonnet-4-6
PEXELS_API_KEY=your_pexels_api_key
GIPHY_API_KEY=your_giphy_api_key
```

---

## ▶️ Run the Application

Development

```bash
npm run dev
```

Open:

```
http://localhost:3000
```

---

## ✅ Verification

The project has been verified using:

```bash
npm run lint

npm run typecheck

npm run build
```

All commands complete successfully.

---

## 💬 Example Prompt

```
I'm building CalAI.

https://calai.app
```

The application will:

- Detect the URL
- Scrape the website
- Analyze the product using Claude
- Select visual assets
- Generate a UGC marketing video
- Return the MP4 directly in the chat

---

## 🎯 Assignment Goals Covered

- ✅ Natural conversational chat
- ✅ Website understanding
- ✅ Product analysis
- ✅ Dynamic asset organization
- ✅ UGC video generation
- ✅ End-to-end automation
- ✅ Robust error handling
- ✅ Production-ready architecture

---

## 👨‍💻 Author

**Mohammed Rayees**

GitHub:
https://github.com/MohammedRayees25

Email:
krmdrayees25@gmail.com

---

## 📄 License

This project was developed as part of a Founding Engineer technical assessment and is intended for evaluation purposes.
