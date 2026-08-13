import { describe, it, expect, beforeEach } from 'vitest';
import { useDemoAccountStore } from '@/stores/useDemoAccountStore';
import type { Candle, Timeframe } from '@/types/domain';

function candle(
  time: number,
  open: number,
  close: number,
  high: number,
  low: number,
  volume = 100,
): Candle {
  return { time, open, high, low, close, volume };
}

describe('useDemoAccountStore — orphaned trade resolution', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({ autoTradeEnabled: true });
  });

  it('checkExpiries with symbolId B does not resolve trade opened on symbolId A', () => {
    const now = Date.now();

    useDemoAccountStore.setState({
      balance: 990,
      openTrades: {
        'sig-A': {
          signalId: 'sig-A',
          stake: 10,
          profitPercent: 80,
          direction: 'buy',
          openedAt: now - 600000,
          entryPrice: 100,
          expiryAt: now - 300000,
          symbolId: 'A',
          timeframe: '5m',
          candleTime: 1000,
        },
      },
    });

    useDemoAccountStore.getState().checkExpiries(105, now + 1000, 'B', '5m');
    expect(useDemoAccountStore.getState().openTrades['sig-A']).toBeDefined();
    expect(useDemoAccountStore.getState().balance).toBe(990);
  });

  it('orphaned trade resolves using next candle close after switching away and back', () => {
    const now = Date.now();
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const candleTime = Math.floor(now / 1000 / tfSeconds) * tfSeconds - tfSeconds * 3;

    useDemoAccountStore.setState({
      balance: 990,
      consecutiveLosses: 0,
      currentStake: 10,
      openTrades: {
        'sig-A': {
          signalId: 'sig-A',
          stake: 10,
          profitPercent: 80,
          direction: 'buy',
          openedAt: now - tfSeconds * 3 * 1000,
          entryPrice: 100,
          expiryAt: (candleTime + tfSeconds * 2) * 1000,
          symbolId: 'A',
          timeframe: tf,
          candleTime,
        },
      },
    });

    const candles: Candle[] = [
      candle(candleTime - tfSeconds, 99, 100, 101, 98),
      candle(candleTime, 100, 102, 103, 99),
      candle(candleTime + tfSeconds, 102, 101, 103, 100),
      candle(candleTime + tfSeconds * 2, 101, 103, 104, 100),
    ];

    useDemoAccountStore.getState().resolveFromHistory('A', tf, candles);

    expect(useDemoAccountStore.getState().openTrades['sig-A']).toBeUndefined();
    expect(useDemoAccountStore.getState().balance).toBe(1008);
  });
});

describe('useDemoAccountStore — win/loss balance and martingale', () => {
  beforeEach(() => {
    useDemoAccountStore.getState().resetAccount();
    useDemoAccountStore.setState({ autoTradeEnabled: true, baseStake: 10, currentStake: 10 });
  });

  it('win returns stake + profit to balance and resets stake', () => {
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const candleTime = 100000;

    useDemoAccountStore.setState({
      balance: 990,
      consecutiveLosses: 0,
      currentStake: 10,
      openTrades: {
        'sig-win': {
          signalId: 'sig-win',
          stake: 10,
          profitPercent: 80,
          direction: 'buy',
          openedAt: candleTime * 1000,
          entryPrice: 100,
          expiryAt: (candleTime + tfSeconds * 2) * 1000,
          symbolId: 'A',
          timeframe: tf,
          candleTime,
        },
      },
    });

    // price went up → buy wins
    useDemoAccountStore.getState().checkExpiries(105, (candleTime + tfSeconds * 2) * 1000, 'A', tf);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-win']).toBeUndefined();
    expect(state.balance).toBe(1008); // 990 + 10 + 8
    expect(state.consecutiveLosses).toBe(0);
    expect(state.currentStake).toBe(10); // reset to base
    expect(state.history).toHaveLength(1);
    expect(state.history[0].outcome).toBe('win');
    expect(state.history[0].pnl).toBe(8);
  });

  it('loss keeps balance reduced and doubles stake for martingale', () => {
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const candleTime = 100000;

    useDemoAccountStore.setState({
      balance: 990,
      consecutiveLosses: 0,
      currentStake: 10,
      openTrades: {
        'sig-loss': {
          signalId: 'sig-loss',
          stake: 10,
          profitPercent: 80,
          direction: 'buy',
          openedAt: candleTime * 1000,
          entryPrice: 100,
          expiryAt: (candleTime + tfSeconds * 2) * 1000,
          symbolId: 'A',
          timeframe: tf,
          candleTime,
        },
      },
    });

    // price went down → buy loses
    useDemoAccountStore.getState().checkExpiries(95, (candleTime + tfSeconds * 2) * 1000, 'A', tf);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-loss']).toBeUndefined();
    expect(state.balance).toBe(990); // no refund on loss
    expect(state.consecutiveLosses).toBe(1);
    expect(state.currentStake).toBe(20); // doubled for martingale
    expect(state.history).toHaveLength(1);
    expect(state.history[0].outcome).toBe('loss');
    expect(state.history[0].pnl).toBe(-10);
  });

  it('three consecutive losses reset martingale to base stake', () => {
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const candleTime = 100000;

    useDemoAccountStore.setState({
      balance: 1000,
      consecutiveLosses: 2,
      currentStake: 40,
      openTrades: {
        'sig-loss3': {
          signalId: 'sig-loss3',
          stake: 40,
          profitPercent: 80,
          direction: 'buy',
          openedAt: candleTime * 1000,
          entryPrice: 100,
          expiryAt: (candleTime + tfSeconds * 2) * 1000,
          symbolId: 'A',
          timeframe: tf,
          candleTime,
        },
      },
    });

    // price went down → buy loses, 3rd consecutive loss
    useDemoAccountStore.getState().checkExpiries(95, (candleTime + tfSeconds * 2) * 1000, 'A', tf);

    const state = useDemoAccountStore.getState();
    expect(state.consecutiveLosses).toBe(0);
    expect(state.currentStake).toBe(10); // reset to base after 3 losses
  });

  it('trade does not expire before next candle close', () => {
    const tf: Timeframe = '5m';
    const tfSeconds = 300;
    const candleTime = 100000;

    useDemoAccountStore.setState({
      balance: 990,
      consecutiveLosses: 0,
      currentStake: 10,
      openTrades: {
        'sig-early': {
          signalId: 'sig-early',
          stake: 10,
          profitPercent: 80,
          direction: 'buy',
          openedAt: candleTime * 1000,
          entryPrice: 100,
          expiryAt: (candleTime + tfSeconds * 2) * 1000,
          symbolId: 'A',
          timeframe: tf,
          candleTime,
        },
      },
    });

    // nowMs is at the close of the entry candle — should NOT expire yet
    useDemoAccountStore.getState().checkExpiries(105, (candleTime + tfSeconds) * 1000, 'A', tf);

    const state = useDemoAccountStore.getState();
    expect(state.openTrades['sig-early']).toBeDefined();
    expect(state.balance).toBe(990);
    expect(state.history).toHaveLength(0);
  });
});
