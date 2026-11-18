import { z } from "zod";
import { type ApiError, apiFetch } from "../lib/api";
import { cachedRequest, useCachedRequest } from "./useCachedRequest";
import { useRefreshKey } from "./useRefreshKey";

const WhoAmISchema = z.object({ user: z.string().nullable(), email: z.string().nullable() });

export type WhoAmI = z.infer<typeof WhoAmISchema>;

/** GET /api/whoami, fetched once per page. */
export const whoAmIRequest = cachedRequest(() => apiFetch("/api/whoami", WhoAmISchema));

export interface WhoAmIState {
  whoami: WhoAmI | null;
  loading: boolean;
  error: ApiError | null;
}

/** The signed-in person, as the Databricks Apps proxy reports them. A failed load is tried again when the page refreshes. */
export function useWhoAmI(): WhoAmIState {
  const { refresh } = useRefreshKey();
  const { value, loading, error } = useCachedRequest(whoAmIRequest, refresh);
  return { whoami: value, loading, error };
}
