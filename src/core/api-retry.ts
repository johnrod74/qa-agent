/**
 * Retry wrapper with exponential backoff and jitter for Anthropic API calls.
 *
 * Handles transient failures such as rate limiting (429), overload (529),
 * and common server errors (500, 502, 503).
 */

import { createLogger } from './logger.js';

const logger = createLogger('api-retry');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 5). */
  maxRetries?: number;
  /** Initial delay in milliseconds before the first retry (default: 1000). */
  initialDelayMs?: number;
  /** Upper bound on delay in milliseconds (default: 60000). */
  maxDelayMs?: number;
  /** HTTP status codes that should trigger a retry (default: [429, 529, 500, 502, 503]). */
  retryableStatuses?: number[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60_000,
  retryableStatuses: [429, 529, 500, 502, 503],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isErrorWithStatus(error: unknown): error is { status: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as Record<string, unknown>).status === 'number'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

/**
 * Execute an async function with automatic retries using exponential backoff
 * and jitter.
 *
 * Only errors whose `.status` property matches one of the configured
 * `retryableStatuses` are retried. All other errors are thrown immediately.
 *
 * @param fn - The async function to execute.
 * @param options - Optional retry configuration overrides.
 * @returns The resolved value of `fn`.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const opts: Required<RetryOptions> = { ...DEFAULT_OPTIONS, ...options };

  let lastError: unknown;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      // If the error doesn't carry a retryable status, throw immediately.
      if (!isErrorWithStatus(error) || !opts.retryableStatuses.includes(error.status)) {
        throw error;
      }

      // If we've exhausted all retries, throw.
      if (attempt === opts.maxRetries) {
        break;
      }

      // Exponential backoff with jitter: delay = min(initialDelay * 2^attempt + jitter, maxDelay)
      const jitter = Math.random() * opts.initialDelayMs;
      const delay = Math.min(
        opts.initialDelayMs * Math.pow(2, attempt) + jitter,
        opts.maxDelayMs,
      );

      logger.warn(
        { attempt: attempt + 1, maxRetries: opts.maxRetries, delayMs: Math.round(delay), status: error.status },
        `Retryable API error (status ${error.status}), retrying in ${Math.round(delay)}ms...`,
      );

      await sleep(delay);
    }
  }

  throw lastError;
}
