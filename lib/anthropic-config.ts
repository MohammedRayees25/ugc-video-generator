import Anthropic from "@anthropic-ai/sdk";

export type AnthropicErrorCode =
  | "invalid_api_key"
  | "missing_model"
  | "model_not_found"
  | "rate_limit"
  | "timeout"
  | "network"
  | "unknown";

export type NormalizedAnthropicError = {
  code: AnthropicErrorCode;
  status: number;
  body: {
    error: string;
    configuredModel?: string;
    suggestion?: string;
  };
};

export const anthropicModel = process.env.ANTHROPIC_MODEL?.trim() ?? "";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

console.info(`Using Anthropic model: ${anthropicModel}`);

export function hasAnthropicApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function hasAnthropicModel() {
  return anthropicModel.length > 0;
}

export function getAnthropicConfigurationError():
  | NormalizedAnthropicError
  | null {
  if (!hasAnthropicApiKey()) {
    return {
      code: "invalid_api_key",
      status: 401,
      body: {
        error: "Anthropic API key is invalid or missing.",
        suggestion: "Check ANTHROPIC_API_KEY in .env.local."
      }
    };
  }

  if (!hasAnthropicModel()) {
    return {
      code: "missing_model",
      status: 400,
      body: {
        error: "Anthropic model is not configured.",
        suggestion: "Set ANTHROPIC_MODEL in .env.local to a supported model."
      }
    };
  }

  return null;
}

function readField(error: unknown, field: string) {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[field];

  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

function readNestedField(error: unknown, field: string) {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const nestedError = (error as Record<string, unknown>).error;

  if (!nestedError || typeof nestedError !== "object") {
    return undefined;
  }

  return readField(nestedError, field);
}

function getErrorDetails(error: unknown) {
  const status = Number(readField(error, "status") ?? 0);
  const type = readField(error, "type") ?? readNestedField(error, "type") ?? "";
  const code = readField(error, "code") ?? readNestedField(error, "code") ?? "";
  const message =
    error instanceof Error ? error.message : JSON.stringify(error, null, 2);

  return {
    status,
    type: type.toLowerCase(),
    code: code.toLowerCase(),
    message: message.toLowerCase()
  };
}

export function normalizeAnthropicError(
  error: unknown
): NormalizedAnthropicError {
  const details = getErrorDetails(error);

  if (
    details.status === 401 ||
    details.type === "authentication_error" ||
    details.message.includes("api key")
  ) {
    return {
      code: "invalid_api_key",
      status: 401,
      body: {
        error: "Anthropic API key is invalid or missing.",
        suggestion: "Check ANTHROPIC_API_KEY in .env.local."
      }
    };
  }

  if (
    details.status === 404 ||
    details.type === "not_found_error" ||
    details.message.includes("model")
  ) {
    return {
      code: "model_not_found",
      status: 404,
      body: {
        error: "Configured Anthropic model is unavailable.",
        configuredModel: anthropicModel,
        suggestion:
          "Change ANTHROPIC_MODEL in .env.local to a supported Anthropic model."
      }
    };
  }

  if (details.status === 429 || details.type === "rate_limit_error") {
    return {
      code: "rate_limit",
      status: 429,
      body: {
        error: "Anthropic rate limit reached.",
        suggestion: "Wait a moment and try again."
      }
    };
  }

  if (
    details.code === "etimedout" ||
    details.code === "econnaborted" ||
    details.message.includes("timeout")
  ) {
    return {
      code: "timeout",
      status: 504,
      body: {
        error: "Anthropic request timed out.",
        suggestion: "Try again in a moment."
      }
    };
  }

  if (
    details.code === "enotfound" ||
    details.code === "econnreset" ||
    details.code === "econnrefused" ||
    details.message.includes("network") ||
    details.message.includes("fetch failed")
  ) {
    return {
      code: "network",
      status: 503,
      body: {
        error: "Unable to reach Anthropic.",
        suggestion: "Check network connectivity and try again."
      }
    };
  }

  return {
    code: "unknown",
    status: 502,
    body: {
      error: "Anthropic request failed.",
      suggestion: "Try again or check server logs for details."
    }
  };
}
