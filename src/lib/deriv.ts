// Deriv API client (developers.deriv.com): PAT + App ID over REST, then OTP WebSocket.
// Token is kept in this browser only.

type Handler = (msg: any) => void;

export const DERIV_API = "https://api.derivws.com";

export type DerivAccount = {
  account_id: string;
  balance: number;
  currency: string;
  group: string;
  status: "active" | "inactive";
  account_type: "demo" | "real";
};

async function derivRest(path: string, appId: string, token: string, method = "GET") {
  let res: Response;
  try {
    res = await fetch(`${DERIV_API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Deriv-App-ID": appId },
    });
  } catch {
    throw new Error("Could not reach api.derivws.com. Check your internet or disable ad-blockers for this site.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body?.errors?.[0]?.message || (typeof body === "string" ? body : "");
    if (res.status === 401) throw new Error(`Deriv rejected the App ID or token (401). ${msg}`.trim());
    if (res.status === 403) throw new Error(`Token is missing the "trade" scope (403). ${msg}`.trim());
    throw new Error(`Deriv error ${res.status}. ${msg}`.trim());
  }
  return body;
}

/** Lists the trader's Options accounts (demo + real) using a PAT and App ID. */
export async function fetchAccounts(appId: string, token: string): Promise<DerivAccount[]> {
  const b = await derivRest("/trading/v1/options/accounts", appId, token);
  return (b?.data ?? []) as DerivAccount[];
}

/** Gets a one-time authenticated WebSocket URL for one account (valid 120s, single use). */
export async function fetchOtpUrl(appId: string, token: string, accountId: string): Promise<string> {
  const b = await derivRest(`/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`, appId, token, "POST");
  const url = b?.data?.url;
  if (!url) throw new Error("Deriv did not return a trading connection URL.");
  return url as string;
}

// WebSocket client for the new Deriv API (wss://api.derivws.com/trading/v1/options/ws/...).
export class DerivClient {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, { resolve: (m: any) => void; reject: (e: any) => void }>();
  private subs = new Map<string, Set<Handler>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  onClose: (() => void) | null = null;

  connect(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      const label = url.split("?")[0];
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to ${label}`));
      }, 15000);
      ws.onopen = () => {
        clearTimeout(timer);
        this.pingTimer = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 30000);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Could not open the Deriv trading connection (${label}). An ad-blocker or firewall may be blocking it.`));
      };
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
    if (this.ws) this.ws.onclose = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
  }
}

export type Direction = "CALL" | "PUT";

/** Exponential moving average of the last values. */
export function ema(values: number[], period: number) {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = values[0] ?? 0;
  for (let i = 1; i < values.length; i++) e = (values[i] ?? e) * k + e * (1 - k);
  return e;
}

function rsi(values: number[], period = 14) {
  if (values.length <= period) return 50;
  let gain = 0, loss = 0;
  const s = values.slice(-(period + 1));
  for (let i = 1; i < s.length; i++) {
    const d = (s[i] ?? 0) - (s[i - 1] ?? 0);
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

/** Group ticks into pseudo-candles of n ticks. */
function candles(prices: number[], n = 5) {
  const out: { o: number; h: number; l: number; c: number }[] = [];
  for (let i = 0; i + n <= prices.length; i += n) {
    const s = prices.slice(i, i + n);
    out.push({ o: s[0] ?? 0, c: s[s.length - 1] ?? 0, h: Math.max(...s), l: Math.min(...s) });
  }
  return out;
}

export type SignalPart = { name: string; score: number; bias: Direction | null; detail: string };

/**
 * Multi-signal confluence: Triple EMA trend (35%), RSI momentum (20%),
 * SMC fair value gaps / order blocks (30%), tick velocity (15%).
 * Confidence = weighted agreement with the dominant direction. Not a guarantee.
 */
export function computeSignal(prices: number[]): { dir: Direction | null; confidence: number; note: string; parts: SignalPart[] } {
  if (prices.length < 60) return { dir: null, confidence: 0, note: "Collecting ticks…", parts: [] };
  const recent = prices.slice(-200);
  const last = recent[recent.length - 1] ?? 0;

  // 1. Triple EMA
  const e9 = ema(recent, 9), e21 = ema(recent, 21), e50 = ema(recent, 50);
  let trend: SignalPart;
  if (e9 > e21 && e21 > e50) trend = { name: "Trend EMA 9/21/50", score: 1, bias: "CALL", detail: "Stacked bullish" };
  else if (e9 < e21 && e21 < e50) trend = { name: "Trend EMA 9/21/50", score: 1, bias: "PUT", detail: "Stacked bearish" };
  else trend = { name: "Trend EMA 9/21/50", score: 0.3, bias: e9 > e21 ? "CALL" : "PUT", detail: "Mixed / ranging" };

  // 2. RSI
  const r = rsi(recent, 14);
  let mom: SignalPart;
  if (r > 75) mom = { name: "RSI 14", score: 0.6, bias: "PUT", detail: `${r.toFixed(0)} overbought` };
  else if (r < 25) mom = { name: "RSI 14", score: 0.6, bias: "CALL", detail: `${r.toFixed(0)} oversold` };
  else if (r >= 52) mom = { name: "RSI 14", score: Math.min(1, (r - 50) / 20), bias: "CALL", detail: `${r.toFixed(0)} bullish` };
  else if (r <= 48) mom = { name: "RSI 14", score: Math.min(1, (50 - r) / 20), bias: "PUT", detail: `${r.toFixed(0)} bearish` };
  else mom = { name: "RSI 14", score: 0, bias: null, detail: `${r.toFixed(0)} neutral` };

  // 3. SMC: last unmitigated FVG + order block
  const cs = candles(recent, 5);
  let smc: SignalPart = { name: "SMC FVG / OB", score: 0, bias: null, detail: "No structure" };
  for (let i = cs.length - 1; i >= 2; i--) {
    const a = cs[i - 2]!, c = cs[i]!;
    if (c.l > a.h && last > a.h) { smc = { name: "SMC FVG / OB", score: 0.8, bias: "CALL", detail: "Bullish FVG holding" }; break; }
    if (c.h < a.l && last < a.l) { smc = { name: "SMC FVG / OB", score: 0.8, bias: "PUT", detail: "Bearish FVG holding" }; break; }
  }
  const n = cs.length;
  if (n >= 3) {
    const p = cs[n - 3]!, q = cs[n - 2]!, z = cs[n - 1]!;
    if (p.c < p.o && q.c > q.o && z.c > p.h) smc = { name: "SMC FVG / OB", score: 1, bias: "CALL", detail: "Bullish order block break" };
    else if (p.c > p.o && q.c < q.o && z.c < p.l) smc = { name: "SMC FVG / OB", score: 1, bias: "PUT", detail: "Bearish order block break" };
  }

  // 4. Tick velocity
  const t = prices.slice(-11);
  let ups = 0;
  for (let i = 1; i < t.length; i++) if ((t[i] ?? 0) > (t[i - 1] ?? 0)) ups++;
  const vel: SignalPart = ups >= 6
    ? { name: "Tick velocity", score: (ups - 5) / 5, bias: "CALL", detail: `${ups}/10 up` }
    : ups <= 4 ? { name: "Tick velocity", score: (5 - ups) / 5, bias: "PUT", detail: `${ups}/10 up` }
    : { name: "Tick velocity", score: 0, bias: null, detail: "5/10 flat" };

  const parts = [trend, mom, smc, vel];
  const w = [0.35, 0.2, 0.3, 0.15];
  let up = 0, down = 0;
  parts.forEach((p, i) => { if (p.bias === "CALL") up += p.score * w[i]!; else if (p.bias === "PUT") down += p.score * w[i]!; });
  const dir: Direction = up >= down ? "CALL" : "PUT";
  const confidence = Math.max(0, Math.round((Math.max(up, down) - Math.min(up, down) * 0.5) * 100));
  const agreeing = parts.filter((p) => p.bias === dir).length;
  return { dir, confidence, note: `${agreeing}/4 signals agree`, parts };
}
