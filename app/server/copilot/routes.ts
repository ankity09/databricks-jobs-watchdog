import { getExecutionContext } from "@databricks/appkit";
import type express from "express";

/**
 * The copilot's own routes under /api/copilot. The chat itself goes through the
 * AppKit genie plugin, at /api/genie/default/messages and
 * /api/genie/default/conversations/:id. Genie keeps each person's
 * conversations, so the app stores none of its own.
 */

/** One of the person's copilot chats, for the Recent chats list. */
export interface ConversationSummary {
  id: string;
  /** The chat's first question. */
  title: string;
  /** When the chat started (ISO 8601). Genie's list carries no later time. */
  updatedAt: string;
}

/** Where the list comes from. The real one asks Genie, as the person asking. */
export interface ConversationSource {
  list(req: express.Request, limit: number): Promise<ConversationSummary[]>;
}

export interface CopilotRouteContext {
  conversations: ConversationSource;
}

/** The Recent chats list returns at most this many chats. */
export const MAX_CONVERSATIONS = 20;

/** A conversation as Genie's listConversations returns it. */
export interface GenieConversationSummary {
  conversation_id: string;
  title?: string;
  created_timestamp?: number;
}

export function toConversationSummary(conversation: GenieConversationSummary): ConversationSummary {
  return {
    id: conversation.conversation_id,
    title: conversation.title?.trim() || "Untitled chat",
    updatedAt: new Date(conversation.created_timestamp ?? 0).toISOString(),
  };
}

function newestFirst(a: ConversationSummary, b: ConversationSummary): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** The slice of the AppKit app the conversation list needs: a caller scope for the person asking. */
export interface UserScopes {
  asUser(req: express.Request): { run<T>(fn: () => Promise<T>): Promise<T> };
}

/**
 * The person's own conversations in the copilot's Genie space, newest first.
 * The call runs in the person's caller scope, so Genie returns only their
 * conversations (the list never asks for everyone's), and a person without
 * access to the space gets Genie's refusal.
 */
export function genieConversations(appkit: UserScopes, spaceId = process.env.DATABRICKS_GENIE_SPACE_ID ?? ""): ConversationSource {
  return {
    list(req, limit) {
      return appkit.asUser(req).run(async () => {
        // getExecutionContext() is the caller's client inside asUser(req).run(). The root
        // getWorkspaceClient export is Lakebase's helper and would use the app's credentials.
        const response = await getExecutionContext().client.genie.listConversations({ space_id: spaceId, page_size: limit });
        return (response.conversations ?? []).map(toConversationSummary).sort(newestFirst);
      });
    },
  };
}

function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;
  const status = "statusCode" in error ? error.statusCode : "status" in error ? error.status : null;
  return typeof status === "number" ? status : null;
}

/** GET /api/copilot/conversations returns { conversations }: the person's own chats, newest first, at most 20. */
export function registerCopilotRoutes(app: express.Application, ctx: CopilotRouteContext): void {
  app.get("/api/copilot/conversations", async (req, res) => {
    try {
      const conversations = await ctx.conversations.list(req, MAX_CONVERSATIONS);
      res.json({ conversations: [...conversations].sort(newestFirst).slice(0, MAX_CONVERSATIONS) });
    } catch (error) {
      const status = statusOf(error);
      if (status === 401 || status === 403) {
        res.status(status).json({ error: "genie", message: "You don't have access to the copilot's Genie space." });
        return;
      }
      console.error("[copilot] Could not list conversations:", error instanceof Error ? error.message : error);
      res.status(502).json({ error: "genie", message: "Recent chats could not be loaded from Genie." });
    }
  });
}
