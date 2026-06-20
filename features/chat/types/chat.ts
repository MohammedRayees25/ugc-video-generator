export type ChatRole = "assistant" | "user";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: Date;
  videoUrl?: string;
};

export type ChatApiMessage = {
  role: ChatRole;
  content: string;
};

export type ChatApiRequest = {
  messages: ChatApiMessage[];
};

export type TextChatApiResponse = {
  type: "message";
  message: string;
};

export type ProductChatApiResponse = {
  type: "product";
  status: "analyzing" | "analyzed";
  message?: "Analyzing your product...";
  analysis?: ProductAnalysis;
};

export type VideoChatApiResponse = {
  type: "video";
  status: "completed";
  videoUrl: string;
};

export type ChatApiResponse =
  | TextChatApiResponse
  | ProductChatApiResponse
  | VideoChatApiResponse;

export type ProductAnalysis = {
  productName: string;
  category: string;
  targetAudience: string;
  mainBenefits: string[];
  painPoints: string[];
  viralHook: string;
  caption: string;
  cta: string;
  hookVariations: string[];
  featureCaptions: string[];
  ctaCaptions: string[];
  emotion: string;
  backgroundKeyword: string;
  gifKeyword: string;
  musicMood: string;
  hashtags: string[];
};
