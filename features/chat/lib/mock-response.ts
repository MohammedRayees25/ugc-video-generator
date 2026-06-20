export function createMockAssistantResponse(prompt: string) {
  const trimmedPrompt = prompt.trim();

  return [
    "I can help shape that into a UGC video workflow once AI is connected.",
    "",
    "**For now, here is a production-ready placeholder:**",
    "",
    `- Captured brief: "${trimmedPrompt}"`,
    "- Suggested next step: collect product, audience, platform, and tone.",
    "- Future AI hook: generate hooks, scripts, shot lists, and captions."
  ].join("\n");
}
