<a id="readme-top"></a>

<div align="center">
  <a href="#about-the-project">
    <img src="ScanPNL/assets/scanpnl-icon.svg" alt="ScanPNL logo" width="96" height="96">
  </a>

  <h3 align="center">ScanPNL</h3>

  <p align="center">
    A Chrome extension for simulated memecoin terminal workflows with instant controls, live P&amp;L, and chart-level trade context.
    <br />
    <a href="#getting-started"><strong>Get started »</strong></a>
    <br />
    <br />
    <a href="#usage">Usage</a>
    ·
    <a href="#roadmap">Roadmap</a>
    ·
    <a href="#contributing">Contributing</a>
  </p>
</div>

<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li><a href="#built-with">Built With</a></li>
    <li><a href="#getting-started">Getting Started</a></li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#contact">Contact</a></li>
  </ol>
</details>

## About The Project

ScanPNL turns Axiom's own trading interface into a paper-trading terminal. Buys and sells from Axiom's Instant Trade panel and its Quick Buy buttons on Pulse, Discover, and the wallet tracker fill against a simulated SOL balance at Axiom's live price, with Axiom's fees, presets, and quick-buy behavior. Positions, balances, the P&amp;L tracker, the portfolio, chart buy/sell markers, average entry and exit lines, and Share P&amp;L cards all show the simulated account inside Axiom's own interface.

The extension uses a local simulated account. It does not connect to a wallet, sign transactions, custody funds, or place live on-chain orders. While ScanPNL is on, Axiom's real order and signing requests are blocked; switching it off in the popup removes it from Axiom entirely.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

- Vanilla JavaScript
- Chrome Extensions Manifest V3
- Chrome Storage API
- Chrome declarativeNetRequest API
- HTML and CSS

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

### Prerequisites

- Google Chrome or another Chromium-based browser (version 125 or newer) with extension developer mode
- Node.js 24 or newer only if you want to run the automated tests
- `@playwright/cli` installed globally only if you want to run the browser tests

### Installation

1. Clone the repository.

   ```sh
   git clone https://github.com/YOUR-USERNAME/ScanPNL.git
   ```

2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `ScanPNL` folder—the folder containing `manifest.json`.
5. Refresh any open Axiom tabs.

Chrome cannot install the source ZIP by dragging it onto the extensions page. Extract it first, then use **Load unpacked**.

### Run Tests

```sh
node --test ScanPNL/tests/*.test.mjs
node ScanPNL/tests/e2e/run.mjs
node ScanPNL/tests/e2e/lag.mjs
```

The current release includes 84 automated checks: 28 unit tests, 55 browser checks against a stand-in Axiom page, and a page-lag check.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

1. Open the ScanPNL popup and switch it on. Open Axiom tabs reload into paper mode.
2. Open a Solana token on Axiom. The ScanPNL chip sits on Axiom's Instant Trade panel, and its buy and sell buttons and presets place simulated orders.
3. Press Quick Buy on Pulse, Discover, or the wallet tracker. The simulated buy uses your Axiom quick-buy preset and follows Axiom's quick-buy behavior (stay, go to the token, or open it in a new tab).
4. Review simulated positions in Axiom's positions table, ticker bar, P&amp;L tracker, and portfolio (select the ScanPNL wallet). Use Share P&amp;L to make a card for a position.
5. Use the popup to see the balance and open positions, set the starting balance, P&amp;L currency, and fill delay, export or import a backup, or reset the P&amp;L or the whole account.

Settings save automatically. Fees follow Axiom: the 1% platform fee, the token's tax, and your preset's priority fee and bribe.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [x] Simulated trading through Axiom's own Instant Trade panel
- [x] Quick Buy on Pulse, Discover, and the wallet tracker
- [x] Live P&amp;L, chart markers, and average price lines
- [x] Positions, portfolio, P&amp;L tracker, and Share P&amp;L cards
- [x] Real-order blocking while ScanPNL is on
- [ ] Broader live-terminal compatibility verification
- [ ] Optional custom P&amp;L-card branding
- [ ] Adding other chains for trading

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contributing

Contributions and bug reports are welcome. Please open an issue describing the terminal, route, expected behavior, and a reproducible example before submitting a large change.

1. Fork the project.
2. Create a feature branch: `git checkout -b feature/your-feature`.
3. Run the test suite.
4. Commit your changes and open a pull request.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## License

This github repository is distributed under the GNU License.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Contact

For questions, feedback, or bug reports, open a GitHub issue in this repository.

<p align="right">(<a href="#readme-top">back to top</a>)</p>
