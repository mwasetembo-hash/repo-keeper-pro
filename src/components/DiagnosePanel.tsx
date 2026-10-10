import { useRef, useState } from "react";

const redact = (s: string) =>
  s.replace(/\b[A-Za-z0-9_-]{15,}\b/g, (m) => (/^\d+$/.test(m) ? m : "[redacted]"));

export function DiagnosePanel({ error, log, appId }: { error: string; log: string[]; appId: string }) {
  const [note, setNote] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState("");
  const ctrl = useRef<AbortController | null>(null);

  const report = redact(
    `App ID: ${appId} (numeric: ${/^\d+$/.test(appId.trim())})\nBrowser: ${typeof navigator !== "undefined" ? navigator.userAgent : ""}\nError: ${error || "(none)"}\nTrader notes: ${note || "(none)"}\nRecent logs:\n${log.slice(0, 40).join("\n")}`,
  );

  async function run() {
    setBusy(true); setAnswer(""); setFail("");
    ctrl.current = new AbortController();
    try {
      const res = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ report }),
        signal: ctrl.current.signal,
      });
      if (!res.ok || !res.body) throw new Error((await res.text()) || `Error ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        setAnswer((a) => a + dec.decode(value, { stream: true }));
      }
    } catch (e: any) {
      if (e.name !== "AbortError") setFail(e.message || "Could not get a diagnosis.");
    } finally { setBusy(false); }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-4 lg:col-span-3">
      <h2 className="mb-1 font-semibold">AI connection doctor</h2>
      <p className="mb-2 text-xs text-muted-foreground">Sends your error and recent logs (tokens are hidden automatically) for an explanation and safe fixes.</p>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional: describe what happened (device, network, VPN, etc.)"
        className="mb-2 h-20 w-full rounded-md border border-border bg-background p-2 text-sm"
      />
      <details className="mb-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">Preview what will be sent</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{report}</pre>
      </details>
      <div className="flex gap-2">
        <button onClick={run} disabled={busy} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {busy ? "Diagnosing…" : "Diagnose my connection"}
        </button>
        {busy && <button onClick={() => ctrl.current?.abort()} className="rounded-md border border-border px-4 py-2 text-sm">Stop</button>}
      </div>
      {fail && <p className="mt-2 text-sm text-down">{fail}</p>}
      {answer && <div className="mt-3 whitespace-pre-wrap rounded-md bg-background p-3 text-sm">{answer}</div>}
    </section>
  );
}
