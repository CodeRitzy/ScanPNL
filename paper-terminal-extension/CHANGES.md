# 1.0.0

- Branded the initial public release as ScanPNL and added the ScanPNL icon to the extension banner and P&L cards.
- Replaced the Quick Buy preset dropdown with a directly editable SOL amount that saves automatically.

- Routes every P&L mark through a single freshness- and priority-aware quote gate. Delayed page or network results can no longer overwrite a newer terminal/chart tick, and obvious USD/SOL/market-cap scale jumps are rejected while the prior mark is fresh.
- Adds a one-second live-price watchdog. When an open position's mark stops updating, the extension re-discovers the chart/feed objects, retries the terminal quote, then races the independent market fallback if needed.
- Matches live payloads across every verified mint, pool, curve, and route alias. This fixes new-pair events whose canonical mint and terminal route address appear in different fields.
- Re-checks or rebuilds average lines and fill bubbles after chart remounts, including native chart APIs that cannot report whether a drawing survived.
- Keeps Quick Buy's existing worker-owned commit-before-navigation behavior while using the corrected mint priority for new-pair row feeds.

# 1.3.9

- Instant Trade settings save automatically when valid values change. This includes Quick Buy, PNL mode, delay, active execution preset, display unit, editable buy/sell amounts, slippage, gas and bribe. Done and Enter still close an editor.
- Opening another token chart always restores the expanded Instant Trade main panel instead of carrying an open settings or amount editor across routes.
- Trade/token PNL cards no longer show transaction counts or a Holding row. They show Invested and Position. Time-based day, month, 1D, 7D, 30D and Max cards retain transactions.
- Added a sixth locally bundled Dunes background with a separate light canvas treatment. Existing dark backgrounds and user-uploaded images, GIFs and videos remain unchanged.
- New-pair Quick Buy can retain a clicked market-cap observation for up to three seconds while independently verifying token supply. Expired observations still fail. Supply lookups race the configured read-only RPC endpoints, and explicit mint identity outranks a pool-style token-address field.
- Average-line recovery follows the supplied reference's retry principle without copying its implementation. An in-progress public chart drawing is no longer repeatedly invalidated; rebuilt private scales immediately retry the overlay.
- 276 checks across 24 suites pass, including new automatic-save, new-pair timing, trade-card scope and asynchronous chart-drawing cases. Runtime scripts also pass syntax validation. No authenticated live-terminal pass is claimed.

# 1.3.8

- Bubbles, average buy/sell lines and modeled terminal fees are always enabled; obsolete visibility/fee toggles are removed and ignored on migration.
- Quick Buy settings offer Open in new tab, Jump to chart and Do nothing. Orders execute in the background worker, serialize account commits, deduplicate request IDs, and save before automatic chart navigation. Hover can prefetch token supply. Default execution adds no artificial delay.
- Clicked token snapshots survive row recycling and page navigation. Quotes require matching token identities and fresh observations; unavailable quotes still fail visibly instead of inventing a fill.
- Typed quote fields and matching token detail market caps take priority over unrelated nested statistics. Chart exports require explicit close/time columns and use the newest timestamp. Live chart callbacks update the quote path, with independent detail-cap corroboration against incorrect chart-unit conversions.
- Chart calibration resets on missing references or resolution changes. Object-valued scale references are normalized before coordinate calculation, restoring annotations on that adapter path.
- Existing PNL mode choices, history, dashboard and card features are preserved. Historical fills are not repriced. The account model remains USD-denominated.
- 266 checks across 23 suites pass, plus syntax checks for all 10 runtime scripts. Automated regression verification uses controlled chart, DOM, storage and network fixtures; live authenticated terminal compatibility is not verified.

# 1.3.7

- Compared the supplied Dryflip engine and chart adapter as a behavioral reference. No Dryflip code, artwork, bundles, fonts, or assets are included.
- New fills default to the observed quote, without the old market-cap-based impact multiplier. Slippage checks adverse movement against the requested quote; tolerance is not deducted as a fee. Flat gas/bribe remain separate costs. Terminal percentage fees are optional and automatically selected when enabled.
- Quick Buy races verified supply conversion against launch/market quote acquisition. A usable source can finish while the other is slow. Default execution adds no artificial delay. Custom delay is configurable from 0 to 10000 ms, with a separate opt-in for Quick Buy; delayed orders re-read prices before checking slippage.
- Instant Trade PNL can keep cumulative token profit or reset its display baseline on each buy, including additions to an open position. Both modes preserve cash, realized results and all history. Full exits still split history into separate trades. Switching modes does not rewrite records; older holdings without a saved baseline retain their original PNL until the next buy.
- The cog opens a scrollable settings pane with quick-buy amount, delay, PNL mode, terminal-fee toggle, chart visibility, execution settings shortcuts, and the existing completed-trade card action. Save/Enter persist before closing. Incoming price renders preserve drafts. Settings writes share the worker's trade queue and cannot replace a newly committed fill with stale account data.
- Chart unit selection now requires a unique close match instead of always guessing a unit. Missing candles can use their immutable fill level through the real time/price scale until OHLC arrives. Public drawing APIs provide average lines and candle-verified arrows when private scales are unavailable. Stale asynchronous drawings are removed on navigation; terminal drawings are never saved or added to undo history.
- A fresh calibrated chart quote outranks an unchanged detail snapshot at execution. Late network responses cannot replace a quote observed after their request started. Ignored stale React snapshots are remembered so they cannot roll PNL backward later.
- Existing dashboard, card backgrounds/uploads, calendar, token-cycle history, themes and presets are preserved. Previously recorded fills are not repriced.
- Verification uses controlled DOM, chart and network fixtures. Browser download was blocked, so no new screenshot or authenticated live-terminal pass is claimed. Quote availability, undocumented terminal integrations and the existing USD-denominated account model remain limitations.
- 249 checks across 21 suites pass, including the four new execution-options, chart-fallbacks, settings-pane and quote-race suites.

# 1.3.6

- Quick Buy pins the token/route observed at pointer-down. In-site navigation, including immediate chart opening, no longer cancels an already validated order. Same-page recycled/missing rows and Off still cancel. Removed simulated execution sleeps and success/Buying text; failures remain visible. Full browser reload, tab closure, unavailable quotes and insufficient balance are not guaranteed fills.
- The current token's typed React/feed quote is polled every 250ms independently of network requests. Unchanged snapshots do not refresh freshness or undo newer chart prices; old route network responses cannot overwrite a newly opened page.
- Chart quotes can drive P&L after a unique USD/SOL/market-cap unit matches a fresh typed token quote within 2.5%. Historical candle opens detect unit switches. Calibrated unit selection also drives average-line placement. Unknown/unmatched chart units remain excluded from account pricing. Static chart snapshots do not renew freshness.
- A row-prop price materially inconsistent with its displayed market cap (over 5%, allowing rounding) uses that visible cap and known supply. A fresh feed tick still outranks visually frozen cap text. All new fill snapshots use one consistent price/supply pair; older fills are not rewritten.
- Removed the Instant Trade diagnostics control. Cog now opens an in-panel settings pane with a persistent trenches Quick Buy checkbox and a completed-entry P&L card action. The explicit card action opens the existing card editor for that entry; cog itself opens no dashboard tab.
- 218 checks across 17 suites pass. Added immediate/during-quote navigation, a chart tripling with correct positive P&L, USD/SOL cap switches without account changes, stale React snapshot rejection, return-to-page average/bubble recovery, and cog/checkbox/completed-card coverage. These use controlled DOM/chart/network fixtures, not a live terminal pass.

# 1.3.5

- Full exit followed by re-entry creates a new history trade and new round ID. Partial sells and additions to an open position remain in the same trade. Legacy history is split for display at actual full exits, even when an older release reused round IDs; stored fills and cash are not rewritten.
- Chart buy/sell averages and bubbles use only the latest entry cycle. Prior sells no longer appear in a newly opened position's Avg Sell. History rows/cards report each entry's own results; portfolio totals count each realization once.
- Instant Trade still shows cumulative token realized P&L plus the current unrealized result. Its percentage uses cumulative net P&L divided by all buy costs for that token, including costs. Numeric legacy fields cannot concatenate into an incorrect percentage.
- Unlabeled chart/feed prices no longer become account prices through guessed USD/SOL/market-cap conversions. Typed feed, page and market quotes still update P&L. On chart-only/unavailable feeds the last known quote may remain stale until a valid price arrives.
- Fill bubbles require the actual candle interval containing the execution timestamp. Missing new candles wait for data rather than attaching to an older wick. This can temporarily hide a bubble while chart history loads.
- 206 checks across 17 suites pass, including carry-forward profit with rising/falling re-entry prices, numeric percentage fields, same-millisecond cycle boundaries and rejection of unlabeled chart-price contamination. Live-site verification remains pending.

# 1.3.4

- Replaced the gray Padre placeholder with the current green Terminal capsule icon (source in ASSET-SOURCES.md).
- Quick Buy removes the artificial priority-delay timer. A newly acquired quote under 600ms is reused, with a final row-identity check and the newest valid row quote. Older quotes still require refresh. Instant Trade's simulated delay is capped at 120ms. Network/API time is not guaranteed.
- Explicit USD/native prices outrank rounded market-cap text. With known supply, execution market cap is derived from the same price and supply, keeping quantity, fill snapshots and weighted averages consistent. This changes future fills; historical fills are not rewritten.
- Detail pages can request token-address-matched React/feed metadata directly, without a trench button. Cap-only detail pages obtain verified mint supply. Nested base-token identities and metadata are preserved, including names for unindexed launches. Known names cannot be replaced by TOKEN placeholders; holdings display the token name (or an address abbreviation when unavailable).
- Chart discovery accepts widgets with usable internal price/time scales even without public drawing/export methods, fixing missing averages/bubbles on that adapter path. Existing pane/profile clipping remains enabled.
- 203 checks across 17 suites pass, including an unindexed detail-page buy, precise fill cap, name display and visible average line using production code with controlled chart/network data. No live terminal compatibility pass is claimed; new launches still require a valid terminal quote or a supported accessible curve.

# 1.3.3

- Average buys and sells retain the original quantity-weighted execution-price formula across every exit and re-entry in the same token history. Alias chains and older round IDs stay connected; imported numeric quantities are added as numbers. Remaining open cost basis stays separate from lifetime averages and realized P&L.
- Each new fill saves its execution-time supply, SOL rate, market cap and native-unit levels. Average chart lines use these saved levels instead of recalculating old fills from the newest quote. Older fills use their own token metadata where available; absent historical SOL rates retain the current-rate fallback.
- Buy and sell bubbles remain separate green B and red S circles. Same-side clusters keep one readable letter; opposite sides on one candle split horizontally without increasing the 4px wick clearance. Wick anchors stay in the chart's actual units and reset when leaving the chart.
- Centered the middle P&L amount and percentage, removed the visible heading, and added green/red translucent gradients for profit/loss with a neutral zero state. Bought, sold and holding values remain below.
- New accounts start with 1 SOL through every entry point. Initial funding follows the first fresh SOL quote once, serialized with trade commits. Existing balances, fills and preferences are preserved.
- 196 checks across 16 suites passed. Chart geometry and network responses are controlled in these tests; no live terminal/browser pass is claimed.

# 1.3.2

- Quick Buy appears only on trenches. Discover, tracker/profile routes and generic page-text activation are excluded. Known GMGN/Padre home trenches remain supported; buttons retain native row hover ancestry.
- New unindexed Pump mints/curve addresses can use direct read-only launch quotes with actual supply/decimals, virtual reserves, owner/PDA validation, processed-slot guards and RPC failover. Terminal and DEX quotes remain available.
- Unchanged DOM/chart snapshots no longer refresh stale quote timestamps; live P&L recovery bypasses tab-published price caches.
- Pool, curve, row and mint aliases persist across fills, positions and chart models. Full exit/re-entry keeps cumulative token history, including older round IDs. Historical fill values and cash remain unchanged.
- Live P&L has a larger section in the middle; bought/sold/holding remain below in green/red/neutral colors.
- Chart OHLC store fallback supports builds whose exportData is unavailable or unready. Existing chart/profile/panel clipping is preserved.
- Calendar days open date-titled P&L cards. Cards use Solana symbols, transaction counts, saved @handles and Univers via installed font or persistent user font upload. No fee row, simulation wording or closed-trade heading is painted.
- Five backgrounds, custom image/GIF/video uploads, and PNG/WebM exports remain supported.

# Trade Terminal 1.3.1

- Removed visible Paper Trading/Paper trade wording from the portfolio dashboard and exported P&L cards. Token cards no longer display Closed trade/Open position headings.
- Removed the Buy/Sell pending toast. Order execution timing, fees and completion/error feedback are unchanged.
- Removed the chart corner fill/market-cap/average summary. Average lines and fill bubbles only use the actual chart scale.
- Average lines retry after the same chart widget finishes rebuilding, after candle export and on repeat model events. One failing average coordinate no longer hides the other side. Existing chart clipping around profiles and Instant Trade remains.
- New-pair Quick Buy now retains cap-only feed updates, reads additional explicit USD/SOL field names and supports compact cap-before-label rows. If a live cap has no token price or supply, it reads the mint's actual supply from Solana RPC, rechecks the row identity/cap, and derives a quote without waiting for market indexers. It never assumes a fixed token supply.
- Added one read-only host permission: https://api.mainnet.solana.com/* for getTokenSupply. Requests are bounded to 3.5 seconds, deduplicated by mint and cached for ten seconds. Public RPC availability/rate limits still apply; if neither a verified supply nor a usable quote exists, the order fails without writing a fill.

Validation: 162 automated checks passed, including full bridge button press through content submission and the real worker commit with controlled RPC responses. A live RPC probe could not complete in this environment; live Axiom verification remains pending. No live terminal or browser compatibility pass is claimed.

Update the SAME unpacked extension folder, click Reload in chrome://extensions, then refresh ALL terminal tabs and reopen Dashboard. Existing scripts and labels remain until those tabs refresh. Do not uninstall.

# Trade Terminal 1.3.0

- One dark, translucent portfolio page with Active positions and History. Settings, Activity and Transfers pages are removed; execution settings remain in Instant Trade.
- P&L calendar with daily profit/loss, buy/sell counts and transaction details; monthly and 1D/7D/30D/Max sharing.
- Per-position and per-sell P&L cards with five bundled photo backgrounds, persistent custom image/GIF/video uploads, PNG copy/download and eight-second WebM export. GIF frames are decoded for animation. No terminal logo is added to cards.
- Instant Trade uses a charcoal translucent theme and a staggered split animation as extra amount buttons appear. Reduced motion preferences are respected.
- Quick Buy recognizes React-backed clickable token cards, compact rows, Discover routes and supported token links. Valid token addresses containing Tx are no longer rejected. Pills remain children of their token rows for native hover behavior; wallet trackers and profiles remain excluded.
- Earlier chart scoping, preset editing, P1 default, automatic fees, gas/bribe defaults and footer colors are retained.

Update: extract the ZIP, copy the contents of paper-terminal-extension into the SAME unpacked extension folder, click Reload in chrome://extensions, then refresh all terminal tabs. Do not uninstall the extension. Chrome cannot install this ZIP by dragging it into Extensions.

Verification: automated checks cover accounting, dashboard interactions, media persistence/export lifecycle, row discovery, chart scoping and paper trade submission. Live Axiom was blocked by browser verification, and local browser preview was blocked by the browser environment. Live Quick Buy compatibility and browser visual layout still need checking on your terminal.


# Trade Terminal 1.2.12

September 3, 2026. Fixes chart overlays covering native profiles/Instant Trade and restores missing feed Quick Buy buttons.

- Candle bubbles, average lines, and fallback fill rails now belong to the chart's own DOM layer. Their stacking stays within the chart instead of above the entire site. Removal of the chart removes its visible drawings immediately. Original chart layout styles are restored when the extension releases the layer.
- Navigation through pushState, replaceState and browser Back clears drawings synchronously. Models carry their source URL; late updates from a previous page are rejected. Profile/wallet routes and unrelated pages cannot reuse a lingering chart. Malformed models and Off clear all layers.
- Native dialogs/profile panels, native Instant Trade and the extension panel cut holes in the chart layer. Cutouts follow dragging/resizing; overlapping panels cannot accidentally reveal lines in their intersection. Local positioning preserves 20px bubbles and a 4px screen gap across chart/iframe scaling.
- Quick Buy uses verified token rows on Axiom Pulse/trenches without requiring exact column headings. Renamed, decorated, translated and absent headings no longer hide buttons. Wallet tracker panels, wallet/profile routes and dialogs remain excluded; ordinary feed sidebars are allowed. The prior fresh quote pipeline and row-local hover ancestry remain intact.
- Label-free footer values: bought is green, sold is red, holding is neutral. P&L retains its existing positive/negative coloring.

Verification: 108 automated checks passed, including production bridge event wiring for navigation/Off, chart-local layer ownership, native panel cutouts, scaled iframe coordinates, missing feed headings, tracker exclusion and Quick Buy submission. Tests use controlled DOM/chart/storage/network doubles. No live signed-in terminal or browser rendering pass is claimed. See TESTING-AND-NEXT-STEPS.md for the test matrix and installation steps. Reload the existing unpacked extension and refresh terminal tabs after replacing files.

---

# Trade Terminal 1.2.11

September 3, 2026. Updates the 1.2.10 build after the reported live Quick Buy failures.

- Quick Buy can acquire a quote from matching React row records, current terminal list-feed data, or a fresh DEX Screener request. The list-feed listener now runs without an active chart. Arrays and address-keyed row stores are traversed with bounds. A cap-only record no longer hides another matching record's explicit price.
- Fresh market requests bypass the extension's published-price and display caches and request HTTP no-store. Responses must match the token/pair and chain. The token row is rechecked after each network read, and again after the modeled execution delay. A missing/recycled row cancels the order. New listings get a bounded 600ms window for a first list-feed quote if the market service has no quote.
- No price is fabricated when all sources are unavailable. Historical trades, wallet positions and old list-feed data cannot supply a current quote. The included tests exercise the real worker message handler and submission path with controlled HTTP responses, including a no-row-price buy.
- Axiom Quick Buy placement is restricted to recognized token-feed columns such as New Pairs, Final Stretch and Migrated. Wallet tracker panels, dialogs, sidebars and wallet/account/explorer links are excluded. Token rows with only React identities still work inside those feed columns.
- Row buttons retain native hover ancestry. Removed unused per-scan quote extraction, so routine list positioning no longer walks each row's React state every second.
- Removed visible Bought, Sold, Holding and P&L/SOL footer headings. Numeric values remain, with hover/accessibility descriptions.
- P1 is selected by default. Upgrading selects P1 once; a subsequent explicit P2/P3 choice remains saved. Execution costs, custom amounts, positions and trade history are preserved.
- SOL icons use the official vector logomark from https://solana.com/branding, embedded locally with its gradient and proportions. See ASSET-SOURCES.md.
- Button type is 16px in the normal panel, with 36px minimum button height. Other words are 12–14px and icons 16–18px. System fonts and full-size SVG artwork replace the smaller treatment. Backdrop blur is removed; the dark translucent background remains. Footer values no longer compete with headings for space.

Verification: 86 automated checks passed (18 core logic, 10 chart geometry, 21 settings/quotes, 9 editor flow, 17 row placement/feed, 3 quick submission, 8 market-fallback tests). JavaScript syntax, fixture assembly and archive integrity passed. These use controlled DOM/chart/storage/network doubles, not a live signed-in terminal or browser rendering pass. The prior browser connection blocked local preview access. The code fixes are verified under the described fixtures; live terminal compatibility remains a separate check.

---

# Trade Terminal 1.2.10

September 3, 2026. Built from the preceding 1.2.9 source in this workspace.

- The top pencil edits SOL buys and sell percentages directly in highlighted amount pills. A checkmark or Enter saves; Escape cancels. Background updates do not replace focused inputs or typed drafts. Explicitly edited sell order is preserved, including the fourth button.
- The per-side execution editor contains only slippage, total gas and bribe. Save or Enter persists the selected side and closes the editor. Buy/sell settings remain independent.
- Requested defaults: 30% slippage; buy 0.002 SOL gas + 0.001 SOL bribe; sell 0.002 SOL gas + 0.008 SOL bribe. Untouched legacy defaults migrate once; identifiable custom values survive. Balances, positions and fills are retained.
- Terminal fees are selected automatically. The manual platform-percentage field is removed from both overlay and dashboard. See PLATFORM-FEES.md for rates, sources and the unverified Padre/Terminal estimate.
- The minimum panel is 310 CSS pixels wide, with larger button/summary text and a 40px header. Its background is darker charcoal at 76–82% opacity; 6px backdrop blur is isolated behind the content. Initial/restored positions use whole pixels. Browser viewport limits and expanded amount rows remain responsive.
- Removed the token price and CHART/source footer row. Quote freshness remains available in diagnostics.
- B/S bubbles are 20px, with a fixed 4px screen gap above the candle wick. Crowded fills still group without stacking upward and separate when zooming in.
- Average lines, their labels and bubbles clip to the chart pane, with a cutout around Instant Trade that follows dragging/resizing. Average badges stay inside the pane. Charts with private scales use the clipped fill rail; unmaskable native canvas drawings are no longer added behind the translucent panel.
- Quick Buy buttons now live inside each token row and remain within its bounds beside its native control. Normal native hover events travel through the row so the terminal can retain its pause-on-hover behavior. Reconciliation preserves the same button during list updates and cleans it up on Off/navigation.
- Fixed Quick Buy construction from detached placeholders without innerText. Current typed USD/SOL quotes are accepted even when supply is missing; additional explicit price/supply field names and plain wrappers around React hosts are supported. No supply is invented. Known supply still converts the freshly displayed market cap to price.
- Pair-address rows can retain their row identity while storing a matching mint. Recycled rows, stale quotes and untyped prices remain rejected. The order rereads the row before and after modeled delay; no cached request price is used as a fallback.
- Failed Quick Buys show a concise reason (e.g. No quote, Low balance or Slippage), with the full reason in the tooltip. Feedback no longer overwrites an in-progress second order.

Verification: **64 automated regression checks passed**: 18 core logic, 10 chart geometry, 19 settings/quote, 8 editor flow, 6 row layout, and 3 Quick Buy submission checks. All production and assembled fixture JavaScript passed syntax checks. Tests use controlled DOM/chart/storage doubles; no live Axiom or other signed-in terminal pass is claimed. The browser connection could not open the local fixture (ERR_BLOCKED_BY_CLIENT). The package includes the tests and a local browser fixture for follow-up.

---

# Trade Terminal 1.2.9

September 3, 2026. Built from the supplied 1.2.8 ZIP. The earlier Windows-only
1.2.9 working directory was not attached; these changes were applied to 1.2.8.
The original 1.2.8 ZIP is preserved.

- Popup power status is exactly **On** / **Off**.
- Instant Trade uses a darker charcoal background at 76–82% opacity with 10px
  backdrop blur. Text/icons keep full opacity, and bribes remain neutral.
- The panel follows the three supplied screenshots: four columns and one row at
  minimum height; an additional row when tall enough; large pill buttons stretching
  across the available space when enlarged. Minimum width is 290 CSS pixels,
  default width is 340; maximum dimensions are the browser viewport minus 8px.
  Size limits use CSS viewport dimensions, not a hardcoded monitor resolution.
- Second-row availability depends on the measured content height, roughly an
  additional 68 CSS pixels for two four-button rows. More than eight custom
  presets remain available when sufficient height allows additional rows.
- Saved amounts remain intact. The view adds supplemental SOL amounts when needed
  to provide eight buttons. Existing USD amounts retain their economic value.
  The compact sell row keeps 100% available; other saved sell amounts remain in
  the expanded view. No zero-percent action buttons are introduced.
- Chart bubbles use a fixed 5px screen gap above their own candle's wick.
  Nearby high spikes no longer lift them. Crowded fills use a counted B, S, or B/S
  circle anchored to the latest actual fill candle within that small group.
  Group width/height are bounded; zooming in separates different candles again.
  Same-candle fills remain grouped. Stored fill history is unchanged.
- Chart coordinates account for pane/iframe scaling and iframe borders. A current
  candle's own high replaces stale converted wick values after quote-unit changes.

Verification: **18 Node logic tests + 10 coordinate tests passed**, and all
extension JavaScript passed syntax checks. Coordinate tests use controlled DOM
and chart-scale doubles, not a browser rendering engine. The engine functions,
order submission, state migration, row quote normalization, background worker,
and dashboard are byte-identical to 1.2.8. Archive contents were compared against
these checked files.

Browser preview access was blocked with ERR_BLOCKED_BY_CLIENT. **No visual or
signed-in terminal pass is claimed for 1.2.9.** The included browser fixture is
runnable locally and covers viewport sizing, dragging, extra rows, markers, and
Off cleanup. Prior release test results below are historical, not a new run.

Reference reviewed: supplied PaperTrench price-bridge.js, DOM bubble layer and
chart-scale handling. This extension keeps its own UI and implementation.

---

# Previous: Trade Terminal 1.2.8

Compared with 1.2.7 and PaperTrench 3.18.0's chart-scale, navigation and
transient chart-rebuild handling. Existing balances, fills and customized
execution costs remain in the same extension storage.

- Instant Trade has a 380px minimum width and a content-based minimum height.
  Opening the fee editor increases the minimum automatically. Old small saved
  sizes are clamped, and live content growth stays within the viewport. Only a
  viewport shorter than the contents requires scrolling.
- The arrows beside Sell now switch Bought, Sold, Holding and P&L between USD
  and SOL. Buy presets and available balance always remain SOL, as does the value
  beside the token count. SOL logos survive live updates.
- New presets default to 30% slippage. Inputs accept whole percentages from 0
  through 100; pasted fractional values round to the nearest integer. Untouched
  old defaults migrate to 30%; customized values are rounded, not reset, and
  independent buy/sell fees and bribes are preserved.
- B/S markers retain an actual candle time and wick anchor across in-page token
  navigation. Gaps between candles no longer require a bar at the exact fill
  second. Every frame re-projects onto the active time/price scales; temporary
  scale errors hide stale positions and the positioning loop recovers. Detached
  chart instances are discarded and partial exports retain older candle data.
- The overlay, popup and dashboard use light white/silver gradients and graphite
  controls. The popup is a compact single-column terminal list with local logos
  and an original header. Bribes have neutral styling, with no yellow emphasis.

Verification: 33 engine/bridge/worker checks and 44 controlled browser integration
checks, including gaps, both-axis pan, zoom, pane movement, chart remount/re-entry,
minimum sizing, integer slippage, currency switching and prior Quick Buy/Off/P&L
regressions. Browser-assisted visual review covers the popup, dashboard and panel.
These are controlled local tests, not signed-in live-terminal verification.

## Previous: Trade Terminal 1.2.7

Compared with 1.2.6 and PaperTrench 3.18.0's row/action-quote handling.
Balances, positions, fills, execution presets and saved panel geometry are preserved.

- Quick Buy re-reads the exact row on click, at submission and after the execution
  delay. A displayed USD market cap is converted using known token supply, rather
  than allowing an older price to override that cap. Metadata requests are followed
  by another row read. Missing/recycled rows fail without a cached-price fill.
- Closest valid React quote records are preferred; provably committed alternate
  fibers are used when available. Nested records for other tokens are excluded.
- B/S markers use explicitly centered SVG text. Their bottom edge sits eight pixels
  above the highest candle wick beneath them; nearby markers stack upward. Average
  Buy/Sell lines retain their actual quantity-weighted execution prices.
- Candle geometry comes from chart exports and live bars. Markers wait when wick
  geometry is unavailable instead of guessing a location over the candles.
- Instant Trade has a neutral charcoal/white/gray treatment with teal buy pills,
  pink sell pills, slippage/gas/coin icons and gold bribe values.
- Buy amounts, available balance, bought/sold amounts and position value always
  display in SOL. SOL icons remain intact during live numeric updates. The arrows
  beside Sell change only the P&L amount between SOL and dollars. Existing USD
  presets retain their economic size and are shown as their SOL equivalent.
- Quote/fill prices and market caps are included in the diagnostics (no account
  amounts), to distinguish stale quotes from configured execution impact.

Verification: 26 engine/bridge/worker checks and 35 browser integration checks,
including 28K displayed vs 24K stale quote, re-pricing to 29K before fill, deleted
row cancellation, wick clearance, currency isolation, Off cleanup and live P&L.
Manual browser checks cover drag, resize, saved geometry and narrow-panel overflow.
These are controlled local tests, not a claim of signed-in live-terminal verification.

## Previous: Trade Terminal 1.2.6

Compared against the supplied 1.2.5 ZIP and PaperTrench 3.18.0. Existing balances,
presets, fills and panel positions remain in the same storage key. The 1.2.5
panel size format is migrated when rendered.

- Instant Trade is no longer rebuilt on market ticks or ordinary host DOM mutations.
  Four explicit corner resize handles save dimensions per terminal. Dragging saves
  the position. The panel mounts before waiting for a quote.
- Trench Quick Buy reconciles existing controls instead of removing them during a
  click. It uses the same order queue and fill store as Instant Trade. Axiom only
  shows these controls on Pulse/trenches, never Discover.
- Off removes the content panel, quick controls, chart bubbles, average lines and
  fallback rail. It cancels pending orders and prevents late async chart work from
  re-creating surfaces. Reload all existing terminal tabs after an extension update.
- Active chart closes and token-scoped site feeds update numeric P&L without a full
  render. CSV chart exports read Close, not Volume. Historical position/holder
  values cannot become live ticks. Dashboard receives the same live quotes.
- Avg Buy and Avg Sell use quantity-weighted execution prices in the current round
  (or the last closed round). Partial sells preserve the original invested basis
  for round P&L percentages. A new entry after closing begins a new round.
- Where chart scales are accessible, filled teal B/red S circles and dotted average
  lines with right-axis value labels follow the actual time/price coordinates,
  including pan/zoom and USD, market-cap or native-unit changes. Standalone
  TradingView builds can use horizontal line tools when broker APIs throw.
- P1/P2/P3 store independent buy and sell settings, editable inside Instant Trade.
  Slippage is a 0–100% adverse-price tolerance, not an automatic haircut. The local
  execution model estimates price impact separately. Higher priority gas + bribe
  reduce modeled delay: 150 + 1850 / (1 + (prioritySOL + bribeSOL) / 0.001) ms.
  This is a bounded local model, not an exact validator-latency prediction.
- The platform fee is taken out of gross buy size, with network/priority/bribe
  costs on top. No invented token price is used when a real quote is unavailable.
- Dashboard renders before quote requests finish. The popup retains the terminal
  picker and local logos. Neither opens Axiom automatically on install.

Verification: engine and bridge regression tests; local browser integration tests
for buying, partial selling, averages, live P&L updates, route gating, pending-order
cancellation and Off cleanup; manual drag/resize and chart-unit checks. Axiom's
signed-in live chart was NOT available in the connected browser. Site compatibility
is therefore not claimed as fully live-verified. See TROUBLESHOOTING.md.

## Earlier build history (1.2.0–1.2.4)

## Important context first

The zip you sent me was a **production build** (Vite output — hashed
filenames, minified single-letter variables), not your editable source. I
couldn't safely hand-patch that file, so I read through it, reconstructed
what it does, and rewrote `background.js`, `content.js`, and `page-bridge.js`
as clean, readable, equivalent-behavior source with the specific bugs fixed
(diffs described below). If you have the actual source repo (the pre-build
project with a `src/` folder, `package.json`, etc.), send that over and I can
work directly in it instead of reverse-engineering the bundle next time.

## The big one: your dashboard wasn't wired to anything

I checked `dashboard.js` for every place it could persist data —
`chrome.storage`, `chrome.runtime`, `localStorage`, `indexedDB`,
`postMessage` — and it uses **none of them**. It's a self-contained React
app rendering from in-memory data. Any setting you changed there (slippage,
fees, gas, presets, enabled sites) was never written to the
`paperTerminalState` object that `content.js` actually reads, and the
"positions"/charts it showed weren't your real trades. This is almost
certainly why slippage/fee/gas settings felt like they weren't doing
anything — they weren't reaching the trade engine at all.

I replaced it with a plain (no build step, no framework) dashboard that
reads and writes the exact same `paperTerminalState` object as `content.js`
and `popup.js`. Settings you save there now actually apply — including live,
via the existing `chrome.storage.onChanged` listener in `content.js`, to any
trading tab you already have open. The trade-off: it's visually simpler than
the old charts-heavy dashboard. If you liked that look and have its source,
I can re-skin this version to match rather than rebuilding chart components
blind.

## Quick buys not aligning with trenches tokens

Two separate bugs in `page-bridge.js`'s row-scanning:

1. **Row-boundary detection was Axiom-specific and fragile.** It looked for
   the nearest ancestor with Tailwind's `.group` class and treated that as
   "the row." `.group` is a generic hover-state utility class used all over
   these UIs, not exclusively on row containers — if it matched a wrapper
   shared by multiple rows, every quick-buy pill under that wrapper resolved
   to the same token. I replaced this with a check that requires the chosen
   row container to be **exclusive** to the pill it was found for (it must
   not also enclose any other candidate pill), which prevents that collapse.

2. **React-fiber address extraction preferred the wrong field.** When a row
   had no direct link to scrape a token address from, the fallback fiber
   walk scored a `mint` prop higher than `pairAddress`/`tokenAddress`-style
   props. But these sites route to a token's own page using the pool/pair
   address, not the raw mint — so a row resolved via `mint` could end up
   with a different identifier than the one the token's detail page URL
   uses, silently splitting one token into two "different" positions. I
   reordered the scoring to prefer address/pair-style prop names.

3. **Root-cause fix, not just a patch:** both the trenches quick-buy path
   and the detail-page resolver now overwrite the token's address with
   Dexscreener's `baseToken.address` once a quote comes back (previously
   the code fetched that data but never actually used the canonical
   address it contains). Since both paths hit the same Dexscreener
   endpoint, this makes the two ways of finding "this token" agree with
   each other regardless of which DOM heuristic ran first — this is the
   most durable fix of the three.

## Quick buys not filling the chart

This was mostly downstream of the alignment bug above (a fill recorded
under one address, chart markers filtered by a different address, so
nothing matched) — the canonical-address fix resolves the common case.
I also added a fallback: fills now match a token by a stored
`altAddress` too, so even a one-off resolution mismatch degrades to
"still shows up" instead of "silently missing."

## PnL not live-updating on chart

`page-bridge.js`'s price polling only looked for a chart inside
`<iframe id="tradingview_...">`. Several of the supported sites (Axiom,
Padre, Photon, BullX in particular) self-host the TradingView Advanced
Charting Library and render it straight into a `<div>` — no iframe, no
`tradingview_`-prefixed id — so that lookup could find nothing, and the
overlay's price (and therefore PnL) would freeze after the initial load.

Two changes:
- Chart-API discovery (`findChartApis` in `page-bridge.js`) now also checks
  common self-hosted globals (`window.tvWidget`, `window.widget`, etc.) and
  scans for chart-shaped containers by id/class, not just the iframe case.
- More importantly, **live price no longer depends on finding a chart API
  at all.** `content.js` now has its own independent poller
  (`pollPageDisplayedPrice`, every 1.5s) that re-reads the page's own
  displayed price using the same CSS-selector scraping already used for
  initial detection. The TradingView integration is now a bonus (order
  lines + execution-shape markers on the chart itself) rather than a
  dependency for the PnL number being correct.

## Slippage / fees / gas

The trade math itself (`executeBuy` / `executeSell` in `content.js`) was
already computing these correctly — bps-based slippage, platform fee, and a
gas estimate (network + priority + MEV-bribe-on-buys) in SOL, priced in USD
via `settings.solPrice`. Two real problems on top of that:

1. **`settings.solPrice` was a hardcoded default that never updated.**
   Nothing in the extension ever refreshed it, so every gas/fee dollar
   figure was priced off whatever SOL cost at the moment you installed the
   extension. `background.js` now fetches SOL's price from Dexscreener on
   a `chrome.alarms` timer (every 5 minutes) and keeps `settings.solPrice`
   current; the dashboard also shows when it last updated and has a manual
   "Refresh now" button.
2. **The settings that control all of this were unreachable** — see the
   dashboard section above. Now that the dashboard actually saves, you can
   tune slippage/fee/gas per your own risk model and it'll take effect
   immediately.

I also made price impact scale with trade size relative to the token's
market cap when that's known (small buys on a $2M-mcap token slip less than
the same buy on a $5k-mcap token), instead of a flat bps regardless of size
— using the existing `priceImpactBps` setting as the base rather than adding
a new one, so it stays configurable from the same field.

## What I deliberately left alone

- `popup.js` / `popup.html` — already correctly wired to the same storage
  (verified: it imports load/save/summary helpers and uses them), left as-is.
- The overlay's visual design/CSS — copied verbatim from your build so the
  look doesn't change.
- Everything under `tools/recon` in the reference repo you sent — not
  used or copied.

## If something still doesn't line up

I worked from the compiled bundle and a written understanding of how Axiom/
GMGN/Padre/Photon/BullX render their pages — I don't have live access to
those sites to click through and verify pixel-for-pixel. If quick-buy
alignment or chart markers are still off on a specific site after loading
this build, tell me exactly which site/page and what happened (ideally with
the row's outer HTML or a screenshot) and I'll adjust the row-detection
heuristic for that site specifically.
# 1.2.2

- Finds trench token cards from address-bearing links, including cards whose native buy control is an unlabeled icon.
- Resolves both token-mint and pool/pair-address routes through Dexscreener.
- Adds a chart-attached fill rail when a terminal does not expose its native chart API.
- Initializes storage from the dashboard and always exposes the dashboard from the popup.
# 1.2.3

- Moves trench quick-buy controls after the native action or to the card edge so they do not cover token tickers.
- Centers Instant Trade by default and saves its dragged position per terminal.
- Makes P1/P2/P3 editable execution profiles for slippage, platform fee, network gas, priority gas, and buy bribe.
- Keeps live P&L pinned to the exact chart pair and displays both percentage and dollar P&L.
- Expands detail-page detection and token aliases so trench quick buys appear in Instant Trade when the chart opens.
# 1.2.4

- Replaces the single default-terminal popup with a DryFlip-style supported-platform chooser, packaged terminal logos, on/off toggle, and top-left settings cog.
- Adds a PaperTrench-style live feed hierarchy: terminal feed first, chart ticks second, exact-pair network quote fallback, and DOM text only when fresher sources are stale.
- Makes the active execution profile editable inside Instant Trade for slippage, fee, gas, and validator bribe/tip.
- Adds a saved SOL/USD display toggle and dual-unit buy amounts using the refreshed SOL/USD rate.
- Aligns fresh P1/P2/P3 costs with PaperTrench's bot, aggressive, and zero-cost starting profiles while preserving customized profiles.
- Charges flat gas and validator bribe/tip on both buys and sells, matching PaperTrench's per-transaction cost model.
