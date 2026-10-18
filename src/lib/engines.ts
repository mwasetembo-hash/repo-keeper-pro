// Paper-trading strategy engines (demo comparison) and the phased digit cycle.
// All engines evaluate on tick history only; no real orders are placed.
import { ema } from "./deriv";

export type EngineId = "A" | "B" | "C";
export type EngineStats = { wins: number; losses: number; flat: number; net: number; pending: number; note: string };

export const ENGINES: Record<EngineId, { name: string; desc: string }> = {
  A: { name: "Trend-Confirmed Pattern", desc: "EMA 9/21 alignment + price re-cross of EMA 9" },
  B: { name: "Trendline Breakout-Retest", desc: "Break of recent high/low, then retest that holds" },
  C: { name: "Fib Pullback + Support", desc: "61.8% pullback into the prevailing trend" },
};

const PAYOUT = 0.95; // virtual payout per 1 unit stake
const HORIZON = 5; // ticks ahead used to settle a paper trade

function settle(prices: number[], i: number, dir: 1 | -1): "win" | "loss" | "flat" | null {
  const exit = prices[i + HORIZON];
  if (exit === undefined) return null;
  const d = (exit - prices[i]!) * dir;
  return d > 0 ? "win" : d < 0 ? "loss" : "flat";
}

/** Runs one engine over tick history and returns paper stats. */
export function runEngine(id: EngineId, prices: number[]): EngineStats {
  const st: EngineStats = { wins: 0, losses: 0, flat: 0, net: 0, pending: 0, note: "Collecting ticks…" };
  if (prices.length < 80) return st;
  let lastFire = -999;
  const note = { v: "No setup found" };

  for (let i = 60; i < prices.length; i++) {
    if (i - lastFire < HORIZON) continue; // one open paper trade at a time
    const w = prices.slice(0, i + 1);
    let dir: 1 | -1 | null = null;

    if (id === "A") {
      const e9 = ema(w, 9), e21 = ema(w, 21);
      const p0 = prices[i]!, p1 = prices[i - 1]!, e9p = ema(w.slice(0, -1), 9);
      if (e9 > e21 && p1 <= e9p && p0 > e9) { dir = 1; note.v = "Bull cross above EMA 9"; }
      else if (e9 < e21 && p1 >= e9p && p0 < e9) { dir = -1; note.v = "Bear cross below EMA 9"; }
    } else if (id === "B") {
      const look = prices.slice(i - 30, i - 3);
      const hi = Math.max(...look), lo = Math.min(...look);
      const p = prices[i]!, p1 = prices[i - 1]!, p2 = prices[i - 2]!;
      // breakout happened 2-3 ticks ago, price retested the level and held
      if (p2 > hi && p1 <= hi * 1.0001 && p > hi) { dir = 1; note.v = "Breakout-retest long"; }
      else if (p2 < lo && p1 >= lo * 0.9999 && p < lo) { dir = -1; note.v = "Breakdown-retest short"; }
    } else {
      const swing = prices.slice(i - 40, i);
      const hi = Math.max(...swing), lo = Math.min(...swing);
      const range = hi - lo;
      if (range <= 0) continue;
      const p = prices[i]!;
      const e9 = ema(w, 9), e21 = ema(w, 21);
      const fibUp = hi - range * 0.618, fibDn = lo + range * 0.618;
      if (e9 > e21 && Math.abs(p - fibUp) / range < 0.03) { dir = 1; note.v = "61.8% pullback in uptrend"; }
      else if (e9 < e21 && Math.abs(p - fibDn) / range < 0.03) { dir = -1; note.v = "61.8% pullback in downtrend"; }
    }

    if (dir === null) continue;
    lastFire = i;
    const r = settle(prices, i, dir);
    if (r === null) { st.pending++; continue; }
    if (r === "win") { st.wins++; st.net += PAYOUT; }
    else if (r === "loss") { st.losses++; st.net -= 1; }
    else st.flat++;
  }
  st.note = note.v;
  return st;
}

// ---- Phased digit cycle (Differs → Over 2 → Under 7), one tick each ----
export type BrsPhase = { kind: "DIGITDIFF" | "DIGITOVER" | "DIGITUNDER"; barrier: number; label: string };
export const BRS_PHASES: BrsPhase[] = [
  { kind: "DIGITDIFF", barrier: 5, label: "Differs 5" },
  { kind: "DIGITOVER", barrier: 2, label: "Over 2" },
  { kind: "DIGITUNDER", barrier: 7, label: "Under 7" },
];

export function brsPhaseLabel(step: number) {
  return BRS_PHASES[step % BRS_PHASES.length]!.label;
}

// ---- Performance journal helpers ----
export function journal(trades: { profit: number | null }[]) {
  const s = trades.filter((t) => t.profit !== null).map((t) => t.profit!);
  const wins = s.filter((p) => p > 0);
  const losses = s.filter((p) => p < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  let peak = 0, maxDD = 0, cum = 0, bestWin = 0, bestLoss = 0, cur = 0, lastSign = 0;
  const curve: number[] = [];
  for (const p of [...s].reverse()) {
    cum += p;
    curve.push(cum);
    peak = Math.max(peak, cum);
    maxDD = Math.max(maxDD, peak - cum);
    const sign = p > 0 ? 1 : -1;
    cur = sign === lastSign ? cur + 1 : 1;
    lastSign = sign;
    if (sign > 0) bestWin = Math.max(bestWin, cur);
    else bestLoss = Math.max(bestLoss, cur);
  }
  return {
    winRate: s.length ? (wins.length / s.length) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null,
    maxDrawdown: maxDD,
    bestWin,
    bestLoss,
    curve,
  };
}
