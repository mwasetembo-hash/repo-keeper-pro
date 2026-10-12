// Deriv contract catalog, instrument catalog, and per-contract signals.
import { computeSignal, ema } from "./deriv";

export type Kind = "RISE_FALL" | "HIGHER_LOWER" | "TOUCH" | "OVER_UNDER" | "MATCH_DIFF" | "EVEN_ODD" | "ENDS" | "STAYS";

export const CONTRACTS: Record<Kind, { label: string; sides: [string, string]; types: [string, string]; barrier: "none" | "offset" | "digit" | "range"; digits: boolean }> = {
  RISE_FALL: { label: "Rise / Fall", sides: ["▲ Rise", "▼ Fall"], types: ["CALL", "PUT"], barrier: "none", digits: false },
  HIGHER_LOWER: { label: "Higher / Lower", sides: ["▲ Higher", "▼ Lower"], types: ["CALL", "PUT"], barrier: "offset", digits: false },
  TOUCH: { label: "Touch / No Touch", sides: ["Touch", "No Touch"], types: ["ONETOUCH", "NOTOUCH"], barrier: "offset", digits: false },
  OVER_UNDER: { label: "Digits Over / Under", sides: ["Over", "Under"], types: ["DIGITOVER", "DIGITUNDER"], barrier: "digit", digits: true },
  MATCH_DIFF: { label: "Digits Matches / Differs", sides: ["Matches", "Differs"], types: ["DIGITMATCH", "DIGITDIFF"], barrier: "digit", digits: true },
  EVEN_ODD: { label: "Digits Even / Odd", sides: ["Even", "Odd"], types: ["DIGITEVEN", "DIGITODD"], barrier: "none", digits: true },
  ENDS: { label: "Ends Between / Outside", sides: ["Ends Between", "Ends Outside"], types: ["EXPIRYRANGE", "EXPIRYMISS"], barrier: "range", digits: false },
  STAYS: { label: "Stays Between / Goes Outside", sides: ["Stays Between", "Goes Outside"], types: ["RANGE", "UPORDOWN"], barrier: "range", digits: false },
};

export type Inst = { symbol: string; name: string; group: string };

const fx = ["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","USDCHF","NZDUSD","EURGBP","EURJPY","GBPJPY","AUDJPY","EURAUD","EURCAD","EURCHF","EURNZD","GBPAUD","GBPCAD","GBPCHF","GBPNZD","AUDCAD","AUDCHF","AUDNZD","NZDJPY","CADJPY","CHFJPY","USDMXN","USDNOK","USDPLN","USDSEK"];
export const CATALOG: Inst[] = [
  ...fx.map((p) => ({ symbol: `frx${p}`, name: `${p.slice(0, 3)}/${p.slice(3)}`, group: "Forex" })),
  { symbol: "frxXAUUSD", name: "Gold/USD", group: "Gold & Metals" },
  { symbol: "frxXAGUSD", name: "Silver/USD", group: "Gold & Metals" },
  { symbol: "frxXPTUSD", name: "Platinum/USD", group: "Gold & Metals" },
  { symbol: "frxXPDUSD", name: "Palladium/USD", group: "Gold & Metals" },
  { symbol: "frxBROUSD", name: "Oil/USD", group: "Commodities" },
  ...[["OTC_AS51","Australia 200"],["OTC_DJI","Wall Street 30"],["OTC_FCHI","France 40"],["OTC_FTSE","UK 100"],["OTC_GDAXI","Germany 40"],["OTC_HSI","Hong Kong 50"],["OTC_N225","Japan 225"],["OTC_NDX","US Tech 100"],["OTC_SPC","US 500"],["OTC_SSMI","Swiss 20"],["OTC_SX5E","Euro 50"],["OTC_AEX","Netherlands 25"]].map(([s, n]) => ({ symbol: s!, name: n!, group: "Stock Indices" })),
  { symbol: "cryBTCUSD", name: "BTC/USD", group: "Crypto" },
  { symbol: "cryETHUSD", name: "ETH/USD", group: "Crypto" },
  ...["10","25","50","75","100"].flatMap((v) => [
    { symbol: `R_${v}`, name: `Volatility ${v} Index`, group: "Derived" },
    { symbol: `1HZ${v}V`, name: `Volatility ${v} (1s) Index`, group: "Derived" },
  ]),
  ...["300","500","1000"].flatMap((v) => [
    { symbol: `BOOM${v}`, name: `Boom ${v} Index`, group: "Derived" },
    { symbol: `CRASH${v}`, name: `Crash ${v} Index`, group: "Derived" },
  ]),
  { symbol: "stpRNG", name: "Step Index", group: "Derived" },
  ...["10","25","50","75","100"].map((v) => ({ symbol: `JD${v}`, name: `Jump ${v} Index`, group: "Derived" })),
  { symbol: "RDBULL", name: "Bull Market Index", group: "Derived" },
  { symbol: "RDBEAR", name: "Bear Market Index", group: "Derived" },
];

export function groupOf(symbol: string, market: string): string {
  if (/XAU|XAG|XPT|XPD/.test(symbol)) return "Gold & Metals";
  if (market === "forex") return "Forex";
  if (market === "commodities") return "Commodities";
  if (market === "indices") return "Stock Indices";
  if (market.startsWith("crypto")) return "Crypto";
  return "Derived";
}

export function lastDigit(p: number, decimals: number) {
  const s = p.toFixed(decimals);
  return Number(s[s.length - 1]);
}

export function digitStats(prices: number[], decimals: number, n = 200) {
  const counts = Array(10).fill(0) as number[];
  const s = prices.slice(-n);
  s.forEach((p) => counts[lastDigit(p, decimals)]!++);
  return { counts, total: s.length };
}

function stdevMoves(prices: number[]) {
  const s = prices.slice(-120);
  const d = s.slice(1).map((p, i) => p - s[i]!);
  if (!d.length) return 0;
  const m = d.reduce((a, b) => a + b, 0) / d.length;
  return Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length);
}

export type KindSignal = { side: 0 | 1 | null; confidence: number; note: string };

/** Per-contract statistical signal. Probabilities are historical estimates, not guarantees. */
export function kindSignal(kind: Kind, prices: number[], decimals: number, opts: { digit: number; offset: number; hi: number; lo: number; ticks: number }): KindSignal {
  if (prices.length < 60) return { side: null, confidence: 0, note: "Collecting ticks…" };
  const base = computeSignal(prices);
  if (kind === "RISE_FALL" || kind === "HIGHER_LOWER") {
    return { side: base.dir === "CALL" ? 0 : base.dir === "PUT" ? 1 : null, confidence: base.confidence, note: base.note };
  }
  const sd = stdevMoves(prices) || 1e-9;
  const expected = sd * Math.sqrt(Math.max(1, opts.ticks));
  if (kind === "TOUCH") {
    const toward = (opts.offset > 0 && base.dir === "CALL") || (opts.offset < 0 && base.dir === "PUT");
    const ratio = Math.abs(opts.offset) / expected;
    if (toward && ratio < 1.2) return { side: 0, confidence: Math.round(Math.min(95, base.confidence * (1.3 - ratio / 2))), note: `Barrier ${ratio.toFixed(1)}σ, trend toward it` };
    return { side: 1, confidence: Math.round(Math.min(95, 50 + ratio * 15)), note: `Barrier ${ratio.toFixed(1)}σ away` };
  }
  if (kind === "ENDS" || kind === "STAYS") {
    const w = (Math.abs(opts.hi) + Math.abs(opts.lo)) / 2;
    const ratio = w / (kind === "STAYS" ? expected * 1.6 : expected);
    if (ratio > 1.3) return { side: 0, confidence: Math.round(Math.min(95, 45 + ratio * 15)), note: `Range ${ratio.toFixed(1)}× expected move` };
    if (ratio < 0.7) return { side: 1, confidence: Math.round(Math.min(95, 45 + (1 / ratio) * 12)), note: `Range only ${ratio.toFixed(1)}× expected move` };
    return { side: null, confidence: 40, note: "Range ≈ expected move — no edge" };
  }
  const { counts, total } = digitStats(prices, decimals);
  const pct = (k: number) => (counts[k]! / total) * 100;
  if (kind === "EVEN_ODD") {
    const even = [0, 2, 4, 6, 8].reduce((a, k) => a + pct(k), 0);
    const recent = digitStats(prices, decimals, 20);
    const re = [0, 2, 4, 6, 8].reduce((a, k) => a + recent.counts[k]!, 0) / 20 * 100;
    const side = even >= 50 ? 0 : 1;
    const agree = side === 0 ? re >= 50 : re < 50;
    return { side, confidence: Math.round(Math.max(even, 100 - even) + (agree ? 10 : -10)), note: `Even ${even.toFixed(0)}% (last 20: ${re.toFixed(0)}%)` };
  }
  if (kind === "OVER_UNDER") {
    let over = 0, under = 0;
    for (let k = 0; k < 10; k++) { if (k > opts.digit) over += pct(k); if (k < opts.digit) under += pct(k); }
    return over >= under
      ? { side: 0, confidence: Math.round(over), note: `Over ${opts.digit}: ${over.toFixed(0)}% historical` }
      : { side: 1, confidence: Math.round(under), note: `Under ${opts.digit}: ${under.toFixed(0)}% historical` };
  }
  // MATCH_DIFF
  const p = pct(opts.digit);
  if (p >= 16) return { side: 0, confidence: Math.round(p * 4), note: `Digit ${opts.digit} hot: ${p.toFixed(0)}%` };
  return { side: 1, confidence: Math.round(100 - p), note: `Digit ${opts.digit} at ${p.toFixed(0)}% (Differs pays little)` };
}

/** Trend strength 0-100 from EMA spread relative to tick volatility. */
export function trendStrength(prices: number[]) {
  if (prices.length < 60) return 0;
  const sd = stdevMoves(prices) || 1e-9;
  const spread = Math.abs(ema(prices, 9) - ema(prices, 50)) / (sd * 10);
  return Math.round(Math.min(100, spread * 100));
}
