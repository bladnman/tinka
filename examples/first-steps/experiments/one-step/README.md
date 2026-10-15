# One Step

A first-entry flow for a fictional field journal. Compare immediate writing with a choice of starting prompts.

Run from this directory: `python3 -m http.server 8000 --bind 127.0.0.1`, then open `http://127.0.0.1:8000/`. Any static server works. Stop with Ctrl-C.

The only required file is `index.html`; styles and JavaScript are inline. No packages, fonts, network requests, shared assets, Tinka SDK, or host messages are required.

Real behavior: choosing a starting point, entering a title or text, and returning to the first screen. Simulated behavior: there is no account, backend, persistence, or saved journal. Writing disappears on reload.

Transfer the layout, prompt wording, and transition into your product's components. Add accessible validation and real storage appropriate to the product before shipping. The board manifest is only a preview adapter.
