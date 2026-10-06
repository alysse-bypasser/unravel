# Unravel

A browser-based JavaScript deobfuscator. One static file, no build step, no server.

## Run it
- Open `index.html` in a browser, or serve the folder: `python3 -m http.server`
- Host it on any static host (GitHub Pages, Netlify, Cloudflare Pages).

## Modes
- **Deobfuscate**: reverses obfuscation with the engine you pick.
- **Decompile**: for minified or transpiled code that is not obfuscated. Rewrites `var` to `let`/`const`, string concatenation to template literals, callbacks to arrow functions and `a && a.b` to `a?.b`, then runs Wakaru when it can load.
- **Dump**: runs the code in a sandboxed iframe with hooks on `eval`, `Function`, timers, `atob`, `document.write` and network calls, then prints every layer and call it captured. It does not help with obfuscators that never call `eval`. Only use it on code you are prepared to run; sandboxing reduces the risk without removing it.

## Unravel engine (static, never runs your code)
- obfuscator.io-style string arrays (RC4, base64 and plain), including the rotation step, alias variables and wrapper functions, then removes the decoder
- proxy objects (`o.key(a, b)` becomes `a + b`), flattened `split("|")` switch loops
- constant folding, `"abc".split("").reverse().join("")`, `String.fromCharCode`, template literals
- dead branches, unused variables and parameters, single-assignment constants, single-use functions, immediately-called wrapper functions
- anti-debug traps, self-defending checks and console blockers
- smart renaming of `_0x…`, zero-width and `IlIl` names, and optionally one-letter names

## Other engines
webcrack, webcrack then Unravel, Synchrony and obfuscator-io-deobfuscator (loaded from jsDelivr on first use), plus a static Dean Edwards packer unpacker and a static `eval`/`Function`/`atob` layer peeler. Wakaru can polish the result.

## Tested
Unravel was tested offline against real samples: an obfuscator.io file (RC4 string array, proxy objects, flattened loops, self-defending and debug protection), the light, balanced and maximum modes of js-obfuscator.github.io, and a codebeautify.org sample (plain string array). It has not been tested against JS-Confuser or other obfuscators. The external engines load at their latest versions and were not tested.

## Notes
- Babel loads from cdnjs; the other engines load from jsDelivr. Nothing is bundled, and each library keeps its own license.
- "Remove unused variables" also removes unused top-level variables, and Simplify can make some code less readable.
- Names are guesses from patterns. Review the output.
