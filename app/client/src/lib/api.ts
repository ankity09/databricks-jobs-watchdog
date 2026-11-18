import { z } from "zod";

/** A failed call to the app's own API. `error` is the code from the body (`{ error, message }`), `body` the whole parsed body. */
export class ApiError extends Error {
  status: number;
  error: string;
  body: unknown;

  constructor(status: number, error: string, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
    this.body = body;
  }
}

/** Any thrown value as an ApiError, so hooks can expose one error type. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return new ApiError(0, "unexpected", message, null);
}

const ErrorBody = z.object({ error: z.string(), message: z.string().optional() });

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

/**
 * Calls the app's API and parses the JSON answer with `schema`. Sends JSON
 * when `init.body` is set, with same-origin credentials. Throws an ApiError
 * for a network failure, an error status, or an answer of the wrong shape.
 */
export async function apiFetch<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new ApiError(0, "aborted", "The request was cancelled.", null);
    }
    throw new ApiError(0, "network", "The app server did not answer. Check your connection, then try again.", null);
  }
  const body = await readBody(response);
  if (!response.ok) {
    const parsed = ErrorBody.safeParse(body);
    if (parsed.success) throw new ApiError(response.status, parsed.data.error, parsed.data.message ?? parsed.data.error, body);
    throw new ApiError(response.status, `http_${response.status}`, `The request failed with HTTP ${response.status}.`, body);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError(response.status, "invalid_response", "The server's answer did not have the expected shape.", body);
  }
  return result.data;
}
