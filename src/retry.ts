export type ErrorType = "retryable" | "non_retryable" | "auth_required";

export function classifyError(errorMessage: string): ErrorType {
  const m = errorMessage.toLowerCase();

  if (
    m.includes("unsupported url") ||
    m.includes("no video") ||
    m.includes("not found") ||
    m.includes("404") ||
    m.includes("has been removed") ||
    m.includes("deleted") ||
    m.includes("unavailable") ||
    m.includes("copyright") ||
    m.includes("dmca") ||
    m.includes("taken down") ||
    m.includes("format not available") ||
    m.includes("requested format") ||
    m.includes("is not a valid url")
  ) {
    return "non_retryable";
  }

  if (
    m.includes("sign in") ||
    m.includes("login") ||
    m.includes("authenticate") ||
    m.includes("credentials") ||
    m.includes("cookie") ||
    m.includes("session expired") ||
    (m.includes("403") && m.includes("forbidden")) ||
    m.includes("private video") ||
    m.includes("private") ||
    m.includes("restricted") ||
    m.includes("age-restricted") ||
    m.includes("age verification") ||
    (m.includes("[instagram]") && (m.includes(" 47") || m.includes("login_required")))
  ) {
    return "auth_required";
  }

  // Default: retryable — covers explicit network/server errors and unknown failures
  return "retryable";
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 5000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitterMs: 2000,
};

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  onRetry?: (attempt: number, maxAttempts: number, delayMs: number, error: string) => void | Promise<void>
): Promise<T> {
  let lastError: Error = new Error("Unknown error");

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const errorType = classifyError(lastError.message);

      if (errorType === "non_retryable" || errorType === "auth_required") {
        console.log(`[retry] error=${errorType} skip_retry=true msg=${lastError.message.slice(0, 80)}`);
        throw lastError;
      }

      if (attempt < config.maxAttempts) {
        const baseDelay = Math.min(
          config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt - 1),
          config.maxDelayMs
        );
        const jitter = (Math.random() * 2 - 1) * config.jitterMs;
        const delayMs = Math.max(0, Math.round(baseDelay + jitter));

        console.log(`[retry] attempt=${attempt}/${config.maxAttempts} error=${errorType} delay=${delayMs}ms msg=${lastError.message.slice(0, 80)}`);

        if (onRetry) {
          await onRetry(attempt, config.maxAttempts, delayMs, lastError.message);
        }

        await new Promise<void>((r) => setTimeout(r, delayMs));
      } else {
        console.log(`[retry] all ${config.maxAttempts} attempts exhausted msg=${lastError.message.slice(0, 80)}`);
      }
    }
  }

  throw lastError;
}
