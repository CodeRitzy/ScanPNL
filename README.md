<a id="readme-top"></a>

<div align="center">
  <a href="#about-the-project">
    <img src="paper-terminal-extension/assets/scanpnl-icon.svg" alt="ScanPNL logo" width="96" height="96">
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

ScanPNL adds an Instant Trade overlay to supported Solana terminal pages. It provides editable buy and sell presets, trench-only Quick Buy, live profit and loss, chart buy/sell markers, average entry and exit lines, a portfolio dashboard, a P&amp;L calendar, and shareable trade cards.

The extension uses a local simulated account. It does not connect to a wallet, sign transactions, custody funds, or place live on-chain orders.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

### Built With

- Vanilla JavaScript
- Chrome Extensions Manifest V3
- Chrome Storage API
- HTML and CSS

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Getting Started

### Prerequisites

- Google Chrome or another Chromium-based browser with extension developer mode
- Node.js 24 or newer only if you want to run the automated tests

### Installation

1. Clone the repository.

   ```sh
   git clone https://github.com/YOUR-USERNAME/ScanPNL.git
   ```

2. Open `chrome://extensions` in Chrome and enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `paper-terminal-extension` folder—the folder containing `manifest.json`.
5. Refresh any open supported terminal tabs.

Chrome cannot install the source ZIP by dragging it onto the extensions page. Extract it first, then use **Load unpacked**.

### Run Tests

```sh
npm ci --prefix tests --ignore-scripts
npm test --prefix tests
```

The current release includes 282 automated checks across 25 suites.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Usage

1. Open a supported Solana token chart.
2. Use the Instant Trade panel to select a buy or sell preset and configure execution settings.
3. Open the cog panel to type a Quick Buy SOL amount, choose its post-click behavior, or enable/disable Quick Buy on trenches.
4. Hover a supported trenches row and press its Quick Buy control. Quick Buy can open the chart in a new tab, jump to it, or do nothing after saving the simulated fill.
5. Review active positions and completed history in the dashboard. Use the P&amp;L calendar and cards to share a specific trade or a timeframe summary.

Settings save automatically. Buy/sell bubbles, average buy/sell lines, and terminal fee modeling are always enabled.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [x] Instant Trade overlay with editable buy/sell presets
- [x] Trench-only Quick Buy with typed SOL amount
- [x] Live P&amp;L, chart markers, and average price lines
- [x] Positions, history, calendar summaries, and P&amp;L cards
- [ ] Broader live-terminal compatibility verification
- [ ] Optional custom P&amp;L-card branding

See `paper-terminal-extension/CHANGES.md` for release notes and `COMPARISON.md` for implementation notes and verification limits.

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
