import { createFileRoute } from "@tanstack/react-router";
import { createOpenAI } from "@ai-sdk/openai";
import { streamText } from "ai";

const RUN = "X-Lovable-AIG-Run-ID";

const INSTRUCTIONS = `You are a support engineer for a browser-based Deriv trading bot that connects via WebSocket to wss://ws.derivws.com/websockets/v3?app_id=<APP_ID> (fallbacks ws.deriv.com, ws.binaryws.com), sends {time:1}, then {authorize: token}.
Given the trader's error and logs, explain the most likely causes ranked by likelihood, then give concrete, safe step-by-step fixes.
Known causes: non-numeric or unregistered App ID (OAuth client IDs like "34ARk..." are not App IDs; must be a number from api.deriv.com), ad-blockers/privacy extensions or corporate/ISP firewalls blocking WebSockets, VPN or region blocks, Deriv maintenance, token missing Read/Trade scopes, expired/revoked token, demo vs real token mismatch.
Safety rules: never ask the user to paste their API token, never suggest disabling antivirus entirely or installing unknown software, recommend revoking any token that was shared publicly. Keep it concise, use short headings and bullet lists in plain markdown.`;

export const Route = createFileRoute("/api/diagnose")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) return new Response("AI is not configured.", { status: 500 });
        const body = (await request.json().catch(() => null)) as { report?: string } | null;
        const report = (body?.report ?? "").slice(0, 12000).trim();
        if (!report) return new Response("Please describe the error.", { status: 400 });

        let runId: string | undefined;
        const provider = createOpenAI({
          baseURL: "https://ai.gateway.lovable.dev/v1",
          apiKey,
          headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
          fetch: async (input, init) => {
            const res = await fetch(input, init);
            runId ??= res.headers.get(RUN) ?? undefined;
            if (!res.ok) {
              const msg = await res.clone().text().catch(() => "");
              throw Object.assign(new Error(msg || `AI error ${res.status}`), { status: res.status });
            }
            return res;
          },
        });

        const result = streamText({
          model: provider.responses("openai/gpt-6-astra"),
          system: INSTRUCTIONS,
          messages: [{ role: "user", content: report }],
          abortSignal: request.signal,
          maxRetries: 0,
          providerOptions: {
            openai: {
              forceReasoning: true,
              reasoningEffort: "low",
              reasoningSummary: "auto",
              store: false,
              include: ["reasoning.encrypted_content"],
            },
          },
          onError: ({ error }) => console.error("diagnose error", error),
        });

        const res = result.toTextStreamResponse({
          headers: { "Cache-Control": "no-cache, no-transform" },
        });
        if (runId) res.headers.set(RUN, runId);
        return res;
      },
    },
  },
});
