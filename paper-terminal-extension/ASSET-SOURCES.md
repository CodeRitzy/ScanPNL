# Artwork and API references

- Terminal (formerly Padre) popup icon: green capsule artwork displayed by [MadeOnSol's Terminal/Padre listing](https://madeonsol.com/blog/how-to-use-padre-solana-trading), downloaded September 5, 2026 from its tool-logo asset (`padre-1771353593534.png`). Bundled unchanged as assets/logos/terminal.png to identify the linked platform; trademark remains its owner's. This replaces the prior plain gray placeholder. Direct official-site inspection was blocked; this is a third-party branding reference, not a claimed official asset download.

- Solana icon: official [Solana branding assets](https://solana.com/branding), downloaded from [the official SVG logomark](https://solana.com/src/img/branding/solanaLogoMark.svg) on September 3, 2026. The original SVG is in assets/solana-logomark.svg. Instant Trade embeds its path and gradient locally; only CSS sizing, accessible labeling and the internal gradient identifier are changed. The artwork is not stretched or rasterized. Solana branding remains the property of its owner.
- Market fallback: the existing DEX Screener pair/token API, documented in [the official API reference](https://docs.dexscreener.com/api/reference). Fresh lookup means a new HTTP read; the API's own upstream update cadence still applies. No new host permission or API key is introduced.

## P&L photo backgrounds

The original five photos were downloaded September 3, 2026; the Dunes photo was downloaded September 9, 2026. These six photos were offered under the free [Unsplash License](https://unsplash.com/license), which permits downloading, copying, modifying and distributing the images, including commercial use. They are bundled as part of the card feature, not sold as standalone images. Credits also appear in the background picker. Dark presets use the existing darkened canvas treatment; Dunes uses a light treatment. The JPEG files are retained separately.

| File | Photographer | Source page |
|---|---|---|
| dunes.jpg | Royce Fonseca | https://unsplash.com/photos/soft-white-sand-dunes-under-a-pale-blue-sky-PhiT_BhJmvM |
| highlands.jpg | JOHN TOWNER | https://unsplash.com/photos/aerial-photo-of-brown-moutains-JgOeRuGD_Y4 |
| forest.jpg | Karsten Würth | https://unsplash.com/photos/flowing-river-between-tall-trees-7BjhtdogU3A |
| mist.jpg | Alessio Soggetti | https://unsplash.com/photos/view-of-mountain-PdGBci-4jR8 |
| saturn.jpg | NASA | https://unsplash.com/photos/saturn-and-its-rings-2W-QWAC0mzI |
| obsidian.jpg | Alexander Grey | https://unsplash.com/photos/purple-bubbles-on-liquid-om4O_x_qWD8 |

CDN image IDs for the original five, respectively: photo-1477346611705-65d1883cee1e; photo-1475070929565-c985b496cb9f; photo-1552152370-fb05b25ff17d; photo-1614732414444-096e5f1122d5; photo-1516491575772-bab9f75948c0. Dunes: photo-1765498067720-6ff6847f8f85. Download parameters use a 1600px crop and JPEG quality 80–85.

GIF rendering uses the browser's ImageDecoder API. Canvas image-source behavior: https://html.spec.whatwg.org/multipage/canvas.html#canvasimagesource . WebCodecs example: https://w3c.github.io/webcodecs/samples/image-decoder/animated-gif-renderer.html . No third-party decoder code is bundled.

## New-pair supply lookup (1.3.1)

The read-only getTokenSupply request and amount/decimals conversion follow [Solana's RPC documentation](https://solana.com/docs/rpc/http/gettokensupply). The selected public mainnet endpoint is listed in [Solana's RPC overview](https://solana.com/docs/rpc). [Public endpoint limits](https://solana.com/docs/references/clusters) apply. No private API credentials or wallet signing are used.

## 1.3.2 sources

Binary/PDA routines in solana-accounts.js are adapted from the supplied PaperTrench reference (MIT). Copyright/license: third-party/PaperTrench-LICENSE.txt.

Pump virtual reserves and PDA seeds: [official program documentation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md). [Current protocol notices](https://github.com/pump-fun/pump-public-docs) describe quote-mint additions; unknown/nonzero quote extensions are rejected instead of priced as SOL.

Public services: [PublicNode Solana](https://solana.publicnode.com/) and [Solana RPC](https://solana.com/docs/rpc). Upstream rate/availability limits apply; requests only read account state.

[Univers by Linotype](https://www.myfonts.com/collections/univers-font-linotype/) is commercial. No font binary is redistributed. Cards use an installed or user-uploaded font. Native canvas review used the available Nimbus Sans fallback. The card Solana symbol is drawn as three vector parallelograms using the official mark's proportions/colors.
