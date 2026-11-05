import { z } from "zod";
import { type ApiError, apiFetch } from "../lib/api";
import { cachedRequest, useCachedRequest } from "./useCachedRequest";

const WhoAmISchema = z.object({ user: z.string().nullable(), email: z.string().nullable() });

export type WhoAmI = z.infer<typeof WhoAmISchema>;

/** GET /api/whoami, fetched once per page. */
export const whoAmIRequest = cachedRequest(() => apiFetch("/api/whoami", WhoAmISchema));

export interface WhoAmIState {
  whoami: WhoAmI | null;
  loading: boolean;
  error: ApiError | null;
}

/** The signed-in person, as the Databricks Apps proxy reports them. */
export function useWhoAmI(): WhoAmIState {
  const { value, loading, error } = useCachedRequest(whoAmIRequest);
  return { whoami: value, loading, error };
}
