// US-063 — Transient error classification for Supabase edge-function and
// PostgREST errors. Two shapes live in the wild:
//   * FunctionsHttpError (from .functions.invoke) wraps the HTTP Response
//     in `error.context` — Codebase Pattern #98.
//   * PostgrestError (from .from/.rpc under the postgrest client) surfaces
//     the HTTP status on `error.status` directly; there's no context.
// We check both so transient 429/5xx can drive a toast regardless of which
// supabase-js sub-client threw.
//
// 429 + 5xx are treated as transient (worth retrying). 4xx other than 429
// are caller-fault and handled by the call-site's application-specific
// error-code switches (e.g. USERNAME_TAKEN, NOT_ELIGIBLE).

import { formatRetryAfter } from './time';

export type TransientErrorInfo = {
  isTransient: boolean;
  status?: number;
  retryAfterSec?: number;
};

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export async function classifySupabaseError(
  error: unknown,
): Promise<TransientErrorInfo> {
  if (!error || typeof error !== 'object') return { isTransient: false };

  // Edge-function path: error.context is the HTTP Response. We can also
  // parse its body for a `retry_after_sec` hint (rate-limit edge function).
  const ctx = (error as { context?: unknown }).context;
  if (ctx && typeof ctx === 'object' && 'status' in ctx) {
    const res = ctx as Response;
    const status = typeof res.status === 'number' ? res.status : undefined;
    if (status === undefined) return { isTransient: false };
    if (!isTransientStatus(status)) return { isTransient: false, status };

    let retryAfterSec: number | undefined;
    try {
      const body = (await res.json()) as { retry_after_sec?: number };
      if (typeof body?.retry_after_sec === 'number') {
        retryAfterSec = body.retry_after_sec;
      }
    } catch {
      // non-JSON body — leave retryAfterSec undefined
    }
    return { isTransient: true, status, retryAfterSec };
  }

  // PostgREST path: status is a plain numeric field on the error object.
  const directStatus = (error as { status?: unknown }).status;
  if (typeof directStatus === 'number') {
    if (!isTransientStatus(directStatus)) {
      return { isTransient: false, status: directStatus };
    }
    return { isTransient: true, status: directStatus };
  }

  return { isTransient: false };
}

// Build the user-facing toast message for a transient error.
// 429 with a `retry_after_sec` hint reads "Try again in 4m".
// 429 without a hint + 5xx read "Servers are busy — try again shortly".
export function transientErrorMessage(info: TransientErrorInfo): string {
  if (info.status === 429 && typeof info.retryAfterSec === 'number') {
    return `Try again in ${formatRetryAfter(info.retryAfterSec)}`;
  }
  return 'Servers are busy — try again shortly';
}
