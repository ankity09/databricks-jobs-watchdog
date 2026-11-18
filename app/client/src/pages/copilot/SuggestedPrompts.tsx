/**
 * The Genie agent's sample questions (resources/watchdog_copilot.genie.yml),
 * in the same order. tests/test_bundle_config.py checks that they match.
 * CopilotWelcome shows them as the starter cards of a new chat.
 */
export const SUGGESTED_QUESTIONS = [
  "What is failing right now?",
  "Which jobs missed their schedule?",
  "What breaks if orders_ingest fails?",
  "Summarize the last 24 hours.",
] as const;
