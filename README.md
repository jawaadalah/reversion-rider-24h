# reversion-rider-24h

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jawaadalah/reversion-rider-24h/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/jawaadalah/reversion-rider-24h/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A conviction-tiered capitulation-reversion paper-trading bot for pump.fun bonding curves, built for the 24-hour replay window. It waits for a proven curve to be dumped hard, buys only once the tape stabilizes and buyers return — full stake for deep dumps with buyers back, half stake for shallower ones — and exits fast with mechanical take-profit, stop-loss and trailing stops. Probe round trips keep it above the sprint's 20-coin guardrail, and a drawdown brake halts entries long before the 50% limit. Fully deterministic: slot numbers and the event stream only, no clock, no randomness, no network.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 protocol on stdin/stdout (newline-delimited JSON) and needs Node 22.18 or later, which runs its TypeScript as-is.

---

<sub>Entered on [make.fun](https://make.fun/?ref=9h3tmt5h&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
