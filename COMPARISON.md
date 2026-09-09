# Execution and Chart Review

Reviewed the user-supplied Dryflip ZIP against Trade Terminal 1.3.6. Versions 1.3.7–1.4.0 are an independent implementation; no reference source or assets are distributed.

| Area | Reference behavior observed | Change in this project |
| --- | --- | --- |
| Fills | Reads a current price for execution and checks movement separately from fees. | Removes market-cap-scaled synthetic impact. Uses a validated observed price and immutable fill snapshots. |
| Fees | Engine totals priority and bribe, with zero platform/protocol components. | Defaults to configured flat gas and bribe. Terminal fees always use the existing automatic mapping in 1.3.8. |
| Delay | Supports custom delay and a modeled priority-based delay. | Explicit bounded custom delay; default remains immediate for speed. Quick Buy has a separate delay opt-in. |
| Quotes | Integrates terminal-specific price sources. | Retains verified identity, supply and typed-price validation. Races independent launch/market and supply paths instead of waiting sequentially. |
| Chart markers | Uses marks hooks, with public drawing fallbacks on some platforms. | Retains the existing clipped bubbles and adds public drawing fallback when private scales are unavailable. Pending drawings are invalidated on navigation. |
| Average lines | Draws horizontal lines and retries when charts load slowly. | Uses quantity-weighted immutable execution levels, strict unit matching, recurring redraw attempts and public API fallback. |
| Re-entry PNL | Reference tracks investment, proceeds and fees. | Adds a display-only baseline option on each buy while keeping the account ledger and separate trade-cycle history intact. |

## Deliberate Differences

- We do not assume that every token has one billion supply. The reference's average-line path includes a fixed billion-unit conversion; this project requires known supply or a calibrated chart unit.
- Average executions remain weighted by token quantity, not the amount of SOL invested. Fees affect net PNL and basis, not the chart execution price.
- Favorable price movement is allowed; the configured slippage limit rejects adverse movement. A tolerance is not a guaranteed execution cost.
- Chart fallback arrows wait for the correct loaded candle because the public drawing API can snap missing timestamps to a neighbouring bar. The private-scale bubble path can instead use the exact fill level and time bucket.
- Existing USD account denomination is preserved to avoid silently migrating balances and historical monetary records. SOL display values still use the account's current SOL conversion rate; this is not identical to a native-SOL ledger.

Public drawing API behavior was checked against the [TradingView Drawings API](https://www.tradingview.com/charting-library-docs/latest/ui_elements/drawings/drawings-api/) and [shape options](https://www.tradingview.com/charting-library-docs/latest/api/interfaces/Charting_Library.CreateShapeOptions/).

## Verification Boundaries

Automated suites cover exact fee/accounting arithmetic, reset and cumulative PNL, delay/slippage, competing quote sources, simultaneous settings/trade writes, navigation cleanup, chart units, editor persistence, and existing dashboard/card/media features.

Version 1.3.9 independently adopts the reference's useful recovery behavior: missing average lines are retried while a slow chart becomes ready. This implementation also prevents overlapping asynchronous drawing attempts from cancelling one another, while preserving its own scale calibration and clipping rules. The reference's guarded price retries informed the new-pair review; this project continues to require typed token identity and rejects expired observations.

Version 1.4.0 applies that recovery pattern to the live mark itself. Terminal feed, chart, DOM, and network observations now pass through one token-checked freshness gate; a late fallback cannot overwrite a newer terminal tick. A watchdog rebinds chart/feed objects after SPA remounts and retries stale marks, while chart annotations are periodically verified or rebuilt. Multi-identity feed records now match any verified mint/pool alias instead of whichever address field appears first.

The reference ZIP alone does not establish perfect fills on every terminal. No authenticated live Axiom/Padre session or screenshot pass was possible in this environment. Brand-new tokens still require a usable terminal quote or supported read-only quote source; missing or mismatched data is rejected, not converted into an invented fill.
