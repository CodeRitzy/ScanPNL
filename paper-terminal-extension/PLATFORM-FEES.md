# Automatic platform fees

As of 1.3.8, terminal fees are always applied. The simulator selects the modeled rate below from the current site. There is no user-editable Platform % field. Gas and bribe are always separate SOL costs; slippage is a tolerance, not an extra fee. The rates below are retained from the prior release, not newly verified in 1.3.8.

| Terminal | Modeled platform fee | Source / scope |
| --- | --- | --- |
| Axiom | 1% gross | [Official fee table](https://docs.axiom.trade/getting-started/fees/axiom-fees). The Wood tier lists 0.95% net with 0.05% cashback. The simulator charges the gross amount and does not model account-specific cashback. |
| GMGN | 1% | [Official fee settings](https://docs.gmgn.ai/index/gmgn-fees-settings). |
| Photon | 1% | [Official Photon on SOL fees](https://pies-organization.gitbook.io/photon-trading/photon-on-sol/photon-fees-sol). |
| BullX | 1% | [Official fees and gas](https://bullx.gitbook.io/bullx-neo-docs/fees-and-gas). |
| Padre / Terminal | 1% estimate | Legacy baseline. Current official documentation could not be retrieved during this update; this rate is not newly verified. |
| Dexscreener | 0% additional terminal fee | This extension's own paper execution on the analytics site. This does not imply underlying DEX swaps have no fees. |

Source review: September 3, 2026. Terminal fees, account rewards and referral discounts can change. The implementation is a paper-trading model, not a live account fee quote. Underlying DEX/protocol fees, rebates and fee tiers are not separately modeled.

The mapping lives in `trade-settings.js`. Existing manual platform percentages no longer control execution. Explicit custom gas, bribe and slippage values are preserved; untouched legacy profile defaults migrate once to the requested defaults.

| Side | Gas total | Bribe | Slippage |
| --- | --- | --- | --- |
| Buy | 0.002 SOL | 0.001 SOL | 30% |
| Sell | 0.002 SOL | 0.008 SOL | 30% |

Gas total is stored as 0.000005 SOL base plus 0.001995 SOL priority. All three profiles use these defaults until edited.
