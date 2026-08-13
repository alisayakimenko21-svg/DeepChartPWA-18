import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Signal, SignalDirection, Timeframe, Candle } from '@/types/domain';
import { TIMEFRAME_SECONDS } from '@/data/symbols';

export interface DemoTrade {
  signalId: string;
  stake: number;
  profitPercent: number;
  direction: SignalDirection;
  openedAt: number;
  entryPrice: number;
  expiryAt: number;
  symbolId: string;
  timeframe: Timeframe;
  candleTime: number;
}

export interface DemoTradeHistoryEntry {
  signalId: string;
  outcome: 'win' | 'loss';
  pnl: number;
  balanceAfter: number;
  closedAt: number;
}

interface DemoAccountState {
  balance: number;
  baseStake: number;
  profitPercent: number;
  autoTradeEnabled: boolean;
  consecutiveLosses: number;
  currentStake: number;
  openTrades: Record<string, DemoTrade>;
  history: DemoTradeHistoryEntry[];
  openTrade: (signal: Signal) => void;
  checkExpiries: (currentPrice: number, nowMs: number, symbolId: string, timeframe: Timeframe) => void;
  resolveFromHistory: (symbolId: string, timeframe: Timeframe, candles: Candle[]) => void;
  setBaseStake: (v: number) => void;
  setProfitPercent: (v: number) => void;
  setAutoTradeEnabled: (v: boolean) => void;
  setBalance: (v: number) => void;
  resetAccount: () => void;
}

const DEFAULT_BALANCE = 1000;
const DEFAULT_BASE_STAKE = 10;
const DEFAULT_PROFIT_PERCENT = 80;
const MAX_HISTORY = 30;

function resolveTrade(
  trade: DemoTrade,
  closePrice: number,
  closedAtMs: number,
  state: { balance: number; consecutiveLosses: number; currentStake: number; baseStake: number },
): { pnl: number; balanceAfter: number; consecutiveLosses: number; currentStake: number } {
  const isWin =
    trade.direction === 'buy'
      ? closePrice > trade.entryPrice
      : closePrice < trade.entryPrice;

  let newBalance = state.balance;
  let newConsecutiveLosses = state.consecutiveLosses;
  let newCurrentStake = state.currentStake;
  let pnl: number;

  if (isWin) {
    pnl = trade.stake * trade.profitPercent / 100;
    newBalance += trade.stake + pnl;
    newConsecutiveLosses = 0;
    newCurrentStake = state.baseStake;
  } else {
    pnl = -trade.stake;
    newConsecutiveLosses += 1;
    if (newConsecutiveLosses >= 3) {
      newConsecutiveLosses = 0;
      newCurrentStake = state.baseStake;
    } else {
      newCurrentStake = trade.stake * 2;
    }
  }

  return { pnl, balanceAfter: newBalance, consecutiveLosses: newConsecutiveLosses, currentStake: newCurrentStake };
}

export const useDemoAccountStore = create<DemoAccountState>()(
  persist(
    (set, get) => ({
      balance: DEFAULT_BALANCE,
      baseStake: DEFAULT_BASE_STAKE,
      profitPercent: DEFAULT_PROFIT_PERCENT,
      autoTradeEnabled: true,
      consecutiveLosses: 0,
      currentStake: DEFAULT_BASE_STAKE,
      openTrades: {},
      history: [],

      openTrade: (signal) => {
        const state = get();
        if (!state.autoTradeEnabled) return;
        if (state.openTrades[signal.id]) return;
        const trade: DemoTrade = {
          signalId: signal.id,
          stake: state.currentStake,
          profitPercent: state.profitPercent,
          direction: signal.direction,
          openedAt: Date.now(),
          entryPrice: signal.entryPrice,
          expiryAt: (signal.time + TIMEFRAME_SECONDS[signal.timeframe] * 2) * 1000,
          symbolId: signal.symbolId,
          timeframe: signal.timeframe,
          candleTime: signal.time,
        };
        set({
          balance: state.balance - state.currentStake,
          openTrades: { ...state.openTrades, [signal.id]: trade },
        });
      },

      checkExpiries: (currentPrice, nowMs, symbolId, timeframe) => {
        const state = get();
        const expired = Object.values(state.openTrades)
          .filter((t) => t.symbolId === symbolId && t.timeframe === timeframe && nowMs >= t.expiryAt)
          .sort((a, b) => a.expiryAt - b.expiryAt);

        if (expired.length === 0) return;

        let newBalance = state.balance;
        let newConsecutiveLosses = state.consecutiveLosses;
        let newCurrentStake = state.currentStake;
        const remainingTrades = { ...state.openTrades };
        const newEntries: DemoTradeHistoryEntry[] = [];

        for (const trade of expired) {
          const result = resolveTrade(trade, currentPrice, nowMs, {
            balance: newBalance,
            consecutiveLosses: newConsecutiveLosses,
            currentStake: newCurrentStake,
            baseStake: state.baseStake,
          });
          newBalance = result.balanceAfter;
          newConsecutiveLosses = result.consecutiveLosses;
          newCurrentStake = result.currentStake;

          delete remainingTrades[trade.signalId];
          newEntries.push({
            signalId: trade.signalId,
            outcome: result.pnl > 0 ? 'win' : 'loss',
            pnl: result.pnl,
            balanceAfter: newBalance,
            closedAt: nowMs,
          });
        }

        const newHistory = [...newEntries.reverse(), ...state.history].slice(0, MAX_HISTORY);

        set({
          balance: newBalance,
          consecutiveLosses: newConsecutiveLosses,
          currentStake: newCurrentStake,
          openTrades: remainingTrades,
          history: newHistory,
        });
      },

      resolveFromHistory: (symbolId, timeframe, candles) => {
        const state = get();
        const orphans = Object.values(state.openTrades)
          .filter((t) => t.symbolId === symbolId && t.timeframe === timeframe);

        if (orphans.length === 0) return;

        const lastCandleTime = candles.length > 0 ? candles[candles.length - 1].time : -1;

        let newBalance = state.balance;
        let newConsecutiveLosses = state.consecutiveLosses;
        let newCurrentStake = state.currentStake;
        const remainingTrades = { ...state.openTrades };
        let resolved = false;
        const newEntries: DemoTradeHistoryEntry[] = [];

        for (const trade of orphans) {
          const nextCandleTime = trade.candleTime + TIMEFRAME_SECONDS[timeframe];
          const candle = candles.find((c) => c.time === nextCandleTime);
          if (!candle) continue;
          if (candle.time === lastCandleTime) continue;

          const closedAtMs = (candle.time + TIMEFRAME_SECONDS[timeframe]) * 1000;
          const result = resolveTrade(trade, candle.close, closedAtMs, {
            balance: newBalance,
            consecutiveLosses: newConsecutiveLosses,
            currentStake: newCurrentStake,
            baseStake: state.baseStake,
          });
          newBalance = result.balanceAfter;
          newConsecutiveLosses = result.consecutiveLosses;
          newCurrentStake = result.currentStake;

          delete remainingTrades[trade.signalId];
          resolved = true;
          newEntries.push({
            signalId: trade.signalId,
            outcome: result.pnl > 0 ? 'win' : 'loss',
            pnl: result.pnl,
            balanceAfter: newBalance,
            closedAt: closedAtMs,
          });
        }

        if (!resolved) return;

        const newHistory = [...newEntries.reverse(), ...state.history].slice(0, MAX_HISTORY);

        set({
          balance: newBalance,
          consecutiveLosses: newConsecutiveLosses,
          currentStake: newCurrentStake,
          openTrades: remainingTrades,
          history: newHistory,
        });
      },

      setBaseStake: (v) => set({ baseStake: v, currentStake: v, consecutiveLosses: 0 }),
      setProfitPercent: (v) => set({ profitPercent: v }),
      setAutoTradeEnabled: (v) => set({ autoTradeEnabled: v }),
      setBalance: (v) => set((s) => ({ balance: v, consecutiveLosses: 0, currentStake: s.baseStake })),
      resetAccount: () => set((s) => ({
        balance: DEFAULT_BALANCE,
        baseStake: s.baseStake,
        profitPercent: s.profitPercent,
        autoTradeEnabled: s.autoTradeEnabled,
        consecutiveLosses: 0,
        currentStake: s.baseStake,
        openTrades: {},
        history: [],
      })),
    }),
    {
      name: 'demo-account',
      storage: createJSONStorage(() => localStorage),
    },
  ),
);
