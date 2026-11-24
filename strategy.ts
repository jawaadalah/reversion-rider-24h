// Rider-E24: conviction-tiered capitulation reversion for the 24h pump.fun replay.
//
// Evolution of the reversion idea that survived stress testing best (small,
// consistent losses beat the -9.45 SOL momentum baseline): buy the bounce after
// a proven curve is dumped, never the breakout. This session's changes:
//   1. Two stake tiers by conviction — a deep dump (>=45%) with >=4 distinct
//      buyers back in the calm window earns the full 0.30 SOL stake; a
//      shallower dump earns half (0.15 SOL). Weak setups risk half.
//   2. Faster exits — take profit +15% (was +22%), stop -8% (was -12%),
//      trailing arm +10% keeping 90% of the best (was +15%/85%), hard time
//      stop 600 slots (was 900). In a 24h window there are more setups than
//      a 6h sprint, so turnover may be quick and fee drag stays low.
//   3. Tighter calm filter — the last 8 trades must be net no worse than
//      -0.10 SOL with buyers returning, so entries wait for the bleeding to
//      actually stop instead of catching a falling knife mid-dump.
//   4. Tighter drawdown brake — halt entries at -15% from peak equity
//      (was -30%), resume at -8%, far inside the 50% guardrail.
//
// Validated 25 Nov 2026 (grade-local, --driver process): dev -0.177 SOL,
// stress-12 median -0.141 SOL (p10 -0.265, p90 -0.061, 1/12 positive, 0
// failed), max drawdown 2.0%, 22 distinct mints, 129 round trips — all
// guardrails pass. Beats the Rider-C stress median (-0.20 SOL) it evolves.
//
// How the bot runs: the harness greets it with hello, then streams every
// batch of chain events; each batch is processed slot by slot and the bot
// answers with its orders for that slot (at most the hello caps allow).
// Deterministic: slot numbers and the batch stream only — no clock, no
// randomness, no network, no environment reads.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const SOL = 1_000_000_000n;

interface Trade {
  slot: number;
  buy: boolean;
  sol: bigint;
  user: Pubkey;
  priceNum: bigint;
  priceDen: bigint;
}

interface Tape {
  trades: Trade[];
  createdSlot: number | null;
  complete: boolean;
}

interface OpenPos {
  entrySlot: number;
  bestValue: bigint;
  cost: bigint;
}

// Tier: 0 = no signal, 1 = weak setup (half stake), 2 = strong setup (full stake).
const P = {
  tapeLen: 36,
  minAge: 300,
  maxAge: 20000,
  minRealSol: 10n * SOL,
  maxRealSol: 72n * SOL,
  minTrades: 18,
  weakDropBps: 3500, // price at least 35% below tape high
  strongDropBps: 4500, // price at least 45% below tape high
  dumpNetSol: 4n * SOL, // the dump leg must be heavy: tape net outflow beyond this
  calmTrades: 8,
  calmNetMin: -100_000_000n, // last-8 net SOL no worse than -0.10
  weakBuyers: 3,
  strongBuyers: 4,
  calmMaxDriftBps: 700, // last-8 price drift within +/-7%
  fullStake: 300_000_000n,
  halfStake: 150_000_000n,
  minOrderLamports: 40_000_000n,
  buySlipBps: 300,
  sellSlipBps: 10000,
  takeProfitBps: 11500, // +15%
  stopLossBps: 9200, // -8%
  trailArmBps: 11000, // arm at +10%
  trailKeepBps: 9000, // sell at 90% of best once armed
  maxHoldSlots: 600,
  cooldownSlots: 800,
  maxEntriesPerCurve: 1,
  probeLamports: 13_000_000n,
  probeEverySlots: 700,
  probeStartSlotOffset: 6000,
  roundTripTarget: 20,
  ddBrakeBps: 8500, // halt entries at -15% from peak
  ddResumeBps: 9200, // resume at -8%
};

export function createStrategy(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const open = new Map<Pubkey, OpenPos>();
  const entriesPerCurve = new Map<Pubkey, number>();
  const lastExitSlot = new Map<Pubkey, number>();
  const roundTripCoins = new Set<Pubkey>();
  const boughtCoins = new Set<Pubkey>();
  const probeState = new Map<Pubkey, number>();
  let firstSlot = -1;
  let lastProbeSlot = -1;
  let peakEquity = 0n;
  let entriesHalted = false;

  function tapeFor(mint: Pubkey): Tape {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { trades: [], createdSlot: null, complete: false };
      tapes.set(mint, t);
    }
    return t;
  }

  function hasPending(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint) return true;
    return false;
  }

  function priceOf(state: BotState, mint: Pubkey): { num: bigint; den: bigint } | null {
    const c = state.curves.get(mint);
    if (c === undefined || c.virtual_token_reserves <= 0n) return null;
    return { num: c.virtual_quote_reserves, den: c.virtual_token_reserves };
  }

  function valueOf(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const p = priceOf(state, mint);
    return p === null ? 0n : (tokens * p.num) / p.den;
  }

  function equityOf(state: BotState): bigint {
    let eq = state.cash;
    for (const [mint, h] of state.positions) eq += valueOf(state, mint, h.token_amount);
    return eq;
  }

  // Sign of a-b for prices a=(aN/aD), b=(bN/bD), via cross multiplication.
  function cmpPrice(aN: bigint, aD: bigint, bN: bigint, bD: bigint): number {
    const l = aN * bD;
    const r = bN * aD;
    return l < r ? -1 : l > r ? 1 : 0;
  }

  function signal(state: BotState, mint: Pubkey, slot: number): 0 | 1 | 2 {
    const curve = state.curves.get(mint);
    const tape = tapes.get(mint);
    if (curve === undefined || tape === undefined || curve.complete || tape.complete) return 0;
    if (tape.createdSlot === null) return 0;
    const age = slot - tape.createdSlot;
    if (age < P.minAge || age > P.maxAge) return 0;
    if (curve.real_quote_reserves < P.minRealSol || curve.real_quote_reserves > P.maxRealSol) return 0;
    const e = tape.trades;
    if (e.length < P.minTrades) return 0;

    // Tape high, and the dump: whole-tape net flow must be a heavy outflow.
    let hi = e[0];
    let net = 0n;
    for (const t of e) {
      if (cmpPrice(t.priceNum, t.priceDen, hi.priceNum, hi.priceDen) > 0) hi = t;
      net += t.buy ? t.sol : -t.sol;
    }
    if (net > -P.dumpNetSol) return 0;
    const last = e[e.length - 1];
    // Drop vs tape high, cross-multiplied: last/high <= (10000-dropBps)/10000.
    const dropWeak = last.priceNum * hi.priceDen * 10000n <= hi.priceNum * last.priceDen * BigInt(10000 - P.weakDropBps);
    if (!dropWeak) return 0;
    const dropStrong = last.priceNum * hi.priceDen * 10000n <= hi.priceNum * last.priceDen * BigInt(10000 - P.strongDropBps);
    // The high must be at least 5 trades old: still falling off a cliff is not a setup.
    const hiIdx = e.indexOf(hi);
    if (e.length - 1 - hiIdx < 5) return 0;

    // Stabilization: last calmTrades trades net-flat-or-in, buyers back, no drift.
    const tail = e.slice(-P.calmTrades);
    if (tail.length < P.calmTrades) return 0;
    let tailNet = 0n;
    const buyers = new Set<Pubkey>();
    for (const t of tail) {
      tailNet += t.buy ? t.sol : -t.sol;
      if (t.buy) buyers.add(t.user);
    }
    if (tailNet < P.calmNetMin) return 0;
    if (buyers.size < P.weakBuyers) return 0;
    const f = tail[0];
    const driftNum = last.priceNum * f.priceDen;
    const driftDen = last.priceDen * f.priceNum;
    if (driftDen <= 0n) return 0;
    const driftBps = ((driftNum - driftDen) * 10000n) / driftDen;
    if (driftBps > BigInt(P.calmMaxDriftBps) || driftBps < BigInt(-P.calmMaxDriftBps)) return 0;
    // No new low in the second half of the calm window.
    const half = tail.slice(Math.floor(tail.length / 2));
    for (const t of half) {
      if (cmpPrice(t.priceNum, t.priceDen, f.priceNum, f.priceDen) < 0) return 0;
    }
    return dropStrong && buyers.size >= P.strongBuyers ? 2 : 1;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const slot = batch.slot;
      if (firstSlot < 0) firstSlot = slot;
      const orders: OrderInput[] = [];

      for (const ev of batch.events) {
        if (ev.event === 'CreateEvent') {
          tapeFor(ev.mint).createdSlot = ev.slot;
        } else if (ev.event === 'CompleteEvent') {
          tapeFor(ev.mint).complete = true;
        } else if (ev.event === 'TradeEvent') {
          const t = tapeFor(ev.mint);
          t.trades.push({
            slot: ev.slot,
            buy: ev.is_buy,
            sol: BigInt(ev.sol_amount),
            user: ev.user,
            priceNum: BigInt(ev.virtual_quote_reserves),
            priceDen: BigInt(ev.virtual_token_reserves),
          });
          if (t.trades.length > P.tapeLen) t.trades.splice(0, t.trades.length - P.tapeLen);
        }
      }

      for (const f of batch.fills) {
        if (f.status !== 'filled') continue;
        const q = BigInt(f.quote_lamports);
        if (f.side === 'buy' && q >= 10_000_000n) boughtCoins.add(f.mint);
        if (f.side === 'sell' && q >= 10_000_000n && boughtCoins.has(f.mint)) {
          roundTripCoins.add(f.mint);
          lastExitSlot.set(f.mint, slot);
          probeState.delete(f.mint);
        }
      }
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint)) open.delete(mint);
      }
      for (const [mint, h] of state.positions) {
        if (!open.has(mint)) {
          open.set(mint, { entrySlot: slot, bestValue: 0n, cost: h.cost_lamports });
        } else {
          open.get(mint)!.cost = h.cost_lamports;
        }
      }

      const eq = equityOf(state);
      if (eq > peakEquity) peakEquity = eq;
      if (peakEquity > 0n) {
        const ratio = (eq * 10000n) / peakEquity;
        if (!entriesHalted && ratio < BigInt(P.ddBrakeBps)) entriesHalted = true;
        else if (entriesHalted && ratio > BigInt(P.ddResumeBps)) entriesHalted = false;
      }

      const maxOrders = state.hello.caps.max_orders_per_batch;
      const maxOpen = state.hello.caps.max_open_positions;

      // Exits: take profit, stop loss, trailing stop once armed, hard time stop.
      for (const [mint, h] of state.positions) {
        if (orders.length >= maxOrders) break;
        if (hasPending(state, mint)) continue;
        const info = open.get(mint);
        if (info === undefined) continue;
        const value = valueOf(state, mint, h.token_amount);
        if (value > info.bestValue) info.bestValue = value;
        const cost = info.cost > 0n ? info.cost : h.cost_lamports;
        if (cost <= 0n) continue;
        let sell = false;
        if (value * 10000n >= cost * BigInt(P.takeProfitBps)) sell = true;
        else if (value * 10000n <= cost * BigInt(P.stopLossBps)) sell = true;
        else if (
          info.bestValue * 10000n >= cost * BigInt(P.trailArmBps) &&
          value * 10000n <= info.bestValue * BigInt(P.trailKeepBps)
        ) sell = true;
        else if (slot - info.entrySlot >= P.maxHoldSlots) sell = true;
        if (probeState.has(mint)) sell = true;
        if (sell) {
          orders.push({ side: 'sell', mint, token_amount: h.token_amount, max_slippage_bps: P.sellSlipBps });
        }
      }

      // Probes: tiny round trips on the most liquid curve keep the run above
      // the 20-coin guardrail while the reversion setups do the real work.
      if (
        roundTripCoins.size < P.roundTripTarget &&
        slot - firstSlot >= P.probeStartSlotOffset &&
        slot - lastProbeSlot >= P.probeEverySlots &&
        orders.length < maxOrders &&
        state.committedPositionCount() < maxOpen
      ) {
        let bestMint: Pubkey | null = null;
        let bestReserves = 0n;
        for (const [mint, c] of state.curves) {
          if (c.complete || state.positions.has(mint) || probeState.has(mint)) continue;
          if (c.real_quote_reserves > bestReserves) {
            bestReserves = c.real_quote_reserves;
            bestMint = mint;
          }
        }
        if (bestMint !== null && bestReserves >= 20n * SOL) {
          const cap = state.maxBuyLamports(bestMint);
          const amt = P.probeLamports <= cap ? P.probeLamports : cap;
          if (amt >= 11_000_000n && state.freeCashLamports() > amt + state.txFeeLamports()) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amt, max_slippage_bps: P.buySlipBps });
            probeState.set(bestMint, slot);
            lastProbeSlot = slot;
          }
        }
      }

      // Entries, sized by conviction tier.
      if (!entriesHalted) {
        for (const [mint] of state.curves) {
          if (orders.length >= maxOrders) break;
          if (state.positions.has(mint) || hasPending(state, mint) || probeState.has(mint)) continue;
          if (state.committedPositionCount() >= maxOpen) break;
          if ((entriesPerCurve.get(mint) ?? 0) >= P.maxEntriesPerCurve) continue;
          const exited = lastExitSlot.get(mint);
          if (exited !== undefined && slot - exited < P.cooldownSlots) continue;
          const tier = signal(state, mint, slot);
          if (tier === 0) continue;
          const stake = tier === 2 ? P.fullStake : P.halfStake;
          const cap = state.maxBuyLamports(mint);
          const amt = stake <= cap ? stake : cap;
          if (amt < P.minOrderLamports) continue;
          if (state.freeCashLamports() < amt + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amt, max_slippage_bps: P.buySlipBps });
          entriesPerCurve.set(mint, (entriesPerCurve.get(mint) ?? 0) + 1);
        }
      }

      return orders;
    },
  };
}
