// Minimal Deriv WebSocket API client (browser-side).
// Docs: https://api.deriv.com — token is kept in this browser only.

type Handler = (msg: any) => void;

export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (m: any) => void; reject: (e: any) => void }>();
  private subs = new Map<string, Set<Handler>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  onClose: (() => void) | null = null;

  connect(appId: string, endpoint = "ws.derivws.com"): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`wss://${endpoint}/websockets/v3?app_id=${encodeURIComponent(appId)}&l=EN`);
      this.ws = ws;
      ws.onopen = () => {
        this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 25000);
        resolve();
      };
      ws.onerror = () => reject(new Error("Could not reach Deriv. Check the App ID."));
      ws.onclose = () => {
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pending.forEach((p) => p.reject(new Error("Connection closed")));
        this.pending.clear();
        this.onClose?.();
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        const id = msg.req_id as number | undefined;
        if (id && this.pending.has(id)) {
          const p = this.pending.get(id)!;
          this.pending.delete(id);
          msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg);
        }
        const set = this.subs.get(msg.msg_type);
        if (set && !msg.error) set.forEach((h) => h(msg));
      };
    });
  }

  send(payload: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error("Not connected"));
      const req_id = this.reqId++;
      this.pending.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  on(type: string, h: Handler) {
    if (!this.subs.has(type)) this.subs.set(type, new Set());
    this.subs.get(type)!.add(h);
    return () => this.subs.get(type)?.delete(h);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

export type Direction = "CALL" | "PUT";

/** Exponential moving average of the last values. */
export function ema(values: number[], period: number) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/**
 * Tick-trend signal: fast/slow EMA alignment + recent tick direction ratio.
 * Returns direction and confidence 0-100. Not a guarantee of results.
 */
export function computeSignal(prices: number[]): { dir: Direction | null; confidence: number; note: string } {
  if (prices.length < 30) return { dir: null, confidence: 0, note: "Collecting ticks…" };
  const recent = prices.slice(-60);
  const fast = ema(recent, 5);
  const slow = ema(recent, 21);
  const last10 = prices.slice(-11);
  let ups = 0;
  for (let i = 1; i < last10.length; i++) if (last10[i] > last10[i - 1]) ups++;
  const upRatio = ups / 10;
  const spread = Math.abs(fast - slow) / (Math.abs(slow) || 1);
  const strength = Math.min(1, spread * 4000);
  const bullish = fast > slow;
  const agree = bullish ? upRatio : 1 - upRatio;
  const confidence = Math.round((0.55 * strength + 0.45 * agree) * 100);
  return {
    dir: bullish ? "CALL" : "PUT",
    confidence,
    note: `EMA5 ${bullish ? ">" : "<"} EMA21 · ${ups}/10 up ticks`,
  };
}
