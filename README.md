# UGC Video Generator

A production-minded Next.js 15 chat interface for a future UGC video generation workflow.

## Stack

- Next.js 15 App Router
- TypeScript
- TailwindCSS
- shadcn/ui-style reusable primitives
- ESLint
- Feature-based architecture

## Scripts

```bash
npm install
npm run dev
npm run build
npm run lint
npm run typecheck
```

## Environment

Create `.env.local` with:

```bash
ANTHROPIC_API_KEY=your_anthropic_api_key
ANTHROPIC_MODEL=your_supported_anthropic_model
```

`ANTHROPIC_API_KEY` is used only on the server. `ANTHROPIC_MODEL` controls the Claude model used for chat and product analysis. Set it to a supported Anthropic model; the server logs only the configured model name at startup.
