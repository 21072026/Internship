# Third-party licence inventory

<!-- GENERATED FILE — do not edit by hand.
     Regenerate with: npm run check:licenses -- --write
     license-inventory-signature: 4cbad5d3490e2e6e -->

> Not legal advice. This is the machine-checked inventory a procurement
> questionnaire asks for, and the input to a lawyer’s review — not a
> substitute for one.

This project is licensed **AGPL-3.0-or-later** and is **dual-licensed**: the
sole rights holder — **Mehmet Erşahin**, a natural person — may also grant a
commercial licence on terms that are not the AGPL
([licensing-strategy.md](licensing-strategy.md)). That second possibility is
what makes this inventory load-bearing rather than decorative: a dependency
can be perfectly fine to *distribute* under the AGPL and still make the
commercial grant impossible. Both questions are checked separately, per
package, by `npm run check:licenses` on every pull request.

**Scope**: the production dependency tree read from `package-lock.json`
— 209 packages over 217 installation paths, the same set
described by that build’s CycloneDX SBOM at `/sbom.cdx.json` (both read this
one source, so the two documents cannot disagree).

**Development dependencies** (374 packages) are not listed here and do not
gate the build: nothing imports them at runtime, so no licence obligation
attaches to them through this application. Worth stating plainly rather than
waving through, though — the container image does physically contain them,
because the Dockerfile runs a full `npm ci` (`next build` needs TypeScript and
Tailwind) and copies `node_modules` wholesale. They are therefore evaluated
against the same policy anyway, and **none of them carries a blocking licence** as of this
generation — so the exclusion changes no answer today.

## Verdict summary

| Verdict | Packages | What it means |
|---|---:|---|
| ok | 192 | Permissive. No obligation beyond keeping the copyright notice. |
| ok · attribution | 1 | Permissive with an explicit attribution requirement (usually a data set rather than code). Satisfied by this inventory plus the notice shipped inside the package. |
| ok · weak copyleft | 15 | File- or library-level copyleft (LGPL, MPL, EPL). Compatible with both the AGPL distribution and the commercial grant as long as the package is shipped unmodified and its own source stays available. Modifying one of these in place is what would change the answer. |
| ok · allowlisted | 1 | The declared string is not a resolvable SPDX expression, and the real licence was established by hand. Every entry carries its reason in scripts/license-policy.mjs. |

**No blocking licence in the production tree.** Nothing here prevents
distribution under AGPL-3.0-or-later, and nothing here prevents a commercial
licence being granted on top of it.

## By licence

| Declared licence | Packages | Verdict |
|---|---:|---|
| `MIT` | 134 | ok |
| `Apache-2.0` | 30 | ok |
| `LGPL-3.0-or-later` | 10 | ok · weak copyleft |
| `ISC` | 9 | ok |
| `BSD-2-Clause` | 8 | ok |
| `BSD-3-Clause` | 4 | ok |
| `Apache-2.0 AND LGPL-3.0-or-later` | 3 | ok · weak copyleft |
| `(MIT AND Zlib)` | 1 | ok |
| `(MIT OR EUPL-1.1+)` | 1 | ok |
| `(MIT OR GPL-3.0-or-later)` | 1 | ok |
| `0BSD` | 1 | ok |
| `Apache-2.0 AND LGPL-3.0-or-later AND MIT` | 1 | ok · weak copyleft |
| `BlueOak-1.0.0` | 1 | ok |
| `BSD` | 1 | ok · allowlisted |
| `CC-BY-4.0` | 1 | ok · attribution |
| `MIT-0` | 1 | ok |
| `MPL-2.0` | 1 | ok · weak copyleft |
| `Unlicense` | 1 | ok |

## Hand-resolved packages

A package whose declared string is not a resolvable SPDX expression is
resolved by reading the licence text shipped inside it. Each one carries its
reason, in prose, in `scripts/license-policy.mjs` — the same discipline as
[`docs/security-exceptions.md`](../security-exceptions.md): the reason *is*
the entry, so an allowlisting nobody could justify in a sentence never gets
written.

### `duck` — declares `BSD`, resolved as `BSD-2-Clause`

Declares the bare, non-SPDX string "BSD", which by itself is unresolvable — "BSD" covers everything from 0BSD to the 4-clause advertising variant. The LICENSE file shipped in the package is verbatim BSD-2-Clause (copyright 2013 Michael Williamson: the two redistribution conditions and the warranty disclaimer, no advertising clause, no non-endorsement clause), so the licence is permissive and compatible with both AGPL distribution and the commercial grant. Reached only through `mammoth` → `lop` → `duck`, the .docx parser used for CV text extraction. Re-read the LICENSE file if the version changes; the key is version-pinned so a bump forces exactly that.

## Full inventory

| Package | Version | Declared licence | Verdict |
|---|---|---|---|
| `@anthropic-ai/sdk` | 0.122.0 | `MIT` | ok |
| `@babel/runtime` | 7.29.2 | `MIT` | ok |
| `@emnapi/runtime` | 1.11.3 | `MIT` | ok |
| `@hookform/resolvers` | 3.10.0 | `MIT` | ok |
| `@img/colour` | 1.1.0 | `MIT` | ok |
| `@img/sharp-darwin-arm64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-darwin-x64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-freebsd-wasm32` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-libvips-darwin-arm64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-darwin-x64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linux-arm` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linux-arm64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linux-ppc64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linux-riscv64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linux-s390x` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linux-x64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linuxmusl-arm64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-libvips-linuxmusl-x64` | 1.3.2 | `LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-linux-arm` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-linux-arm64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-linux-ppc64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-linux-riscv64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-linux-s390x` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-linux-x64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-linuxmusl-arm64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-linuxmusl-x64` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-wasm32` | 0.35.3 | `Apache-2.0 AND LGPL-3.0-or-later AND MIT` | ok · weak copyleft |
| `@img/sharp-webcontainers-wasm32` | 0.35.3 | `Apache-2.0` | ok |
| `@img/sharp-win32-arm64` | 0.35.3 | `Apache-2.0 AND LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-win32-ia32` | 0.35.3 | `Apache-2.0 AND LGPL-3.0-or-later` | ok · weak copyleft |
| `@img/sharp-win32-x64` | 0.35.3 | `Apache-2.0 AND LGPL-3.0-or-later` | ok · weak copyleft |
| `@napi-rs/canvas` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-android-arm64` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-darwin-arm64` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-darwin-x64` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-linux-arm-gnueabihf` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-linux-arm64-gnu` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-linux-arm64-musl` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-linux-riscv64-gnu` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-linux-x64-gnu` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-linux-x64-musl` | 0.1.80 | `MIT` | ok |
| `@napi-rs/canvas-win32-x64-msvc` | 0.1.80 | `MIT` | ok |
| `@next/env` | 15.5.24 | `MIT` | ok |
| `@next/swc-darwin-arm64` | 15.5.24 | `MIT` | ok |
| `@next/swc-darwin-x64` | 15.5.24 | `MIT` | ok |
| `@next/swc-linux-arm64-gnu` | 15.5.24 | `MIT` | ok |
| `@next/swc-linux-arm64-musl` | 15.5.24 | `MIT` | ok |
| `@next/swc-linux-x64-gnu` | 15.5.24 | `MIT` | ok |
| `@next/swc-linux-x64-musl` | 15.5.24 | `MIT` | ok |
| `@next/swc-win32-arm64-msvc` | 15.5.24 | `MIT` | ok |
| `@next/swc-win32-x64-msvc` | 15.5.24 | `MIT` | ok |
| `@node-saml/node-saml` | 5.1.0 | `MIT` | ok |
| `@panva/hkdf` | 1.2.1 | `MIT` | ok |
| `@pdf-lib/standard-fonts` | 1.0.0 | `MIT` | ok |
| `@pdf-lib/upng` | 1.0.1 | `MIT` | ok |
| `@pinojs/redact` | 0.4.0 | `MIT` | ok |
| `@prisma/client` | 5.22.0 | `Apache-2.0` | ok |
| `@scarf/scarf` | 1.4.0 | `Apache-2.0` | ok |
| `@selderee/plugin-htmlparser2` | 0.12.0 | `MIT` | ok |
| `@stablelib/base64` | 1.0.1 | `MIT` | ok |
| `@swc/helpers` | 0.5.15 | `Apache-2.0` | ok |
| `@types/debug` | 4.1.13 | `MIT` | ok |
| `@types/ms` | 2.1.0 | `MIT` | ok |
| `@types/node` | 20.19.43 | `MIT` | ok |
| `@types/qs` | 6.15.1 | `MIT` | ok |
| `@types/xml-encryption` | 1.2.4 | `MIT` | ok |
| `@types/xml2js` | 0.4.14 | `MIT` | ok |
| `@xmldom/is-dom-node` | 1.0.1 | `MIT` | ok |
| `@xmldom/xmldom` | 0.8.13 | `MIT` | ok |
| `@zone-eu/mailsplit` | 5.4.15 | `(MIT OR EUPL-1.1+)` | ok |
| `adler-32` | 1.3.1 | `Apache-2.0` | ok |
| `agent-base` | 7.1.4 | `MIT` | ok |
| `argparse` | 1.0.10 | `MIT` | ok |
| `asn1.js` | 5.4.1 | `MIT` | ok |
| `atomic-sleep` | 1.0.0 | `MIT` | ok |
| `base64-js` | 1.5.1 | `MIT` | ok |
| `bcryptjs` | 2.4.3 | `MIT` | ok |
| `bluebird` | 3.4.7 | `MIT` | ok |
| `bn.js` | 4.12.5 | `MIT` | ok |
| `buffer-equal-constant-time` | 1.0.1 | `BSD-3-Clause` | ok |
| `caniuse-lite` | 1.0.30001806 | `CC-BY-4.0` | ok · attribution |
| `cfb` | 1.2.2 | `Apache-2.0` | ok |
| `client-only` | 0.0.1 | `MIT` | ok |
| `clsx` | 2.1.1 | `MIT` | ok |
| `codepage` | 1.15.0 | `Apache-2.0` | ok |
| `cookie` | 0.7.2 | `MIT` | ok |
| `core-util-is` | 1.0.3 | `MIT` | ok |
| `crc-32` | 1.2.2 | `Apache-2.0` | ok |
| `debug` | 4.4.3 | `MIT` | ok |
| `deepmerge-ts` | 8.0.2 | `BSD-3-Clause` | ok |
| `detect-libc` | 2.1.2 | `Apache-2.0` | ok |
| `dingbat-to-unicode` | 1.0.1 | `BSD-2-Clause` | ok |
| `dom-serializer` | 2.0.0 | `MIT` | ok |
| `domelementtype` | 2.3.0 | `BSD-2-Clause` | ok |
| `domhandler` | 5.0.3 | `BSD-2-Clause` | ok |
| `domutils` | 3.2.2 | `BSD-2-Clause` | ok |
| `duck` | 0.1.12 | `BSD` | ok · allowlisted |
| `ecdsa-sig-formatter` | 1.0.11 | `Apache-2.0` | ok |
| `encoding-japanese` | 2.2.0 | `MIT` | ok |
| `entities` | 4.5.0, 7.0.1 | `BSD-2-Clause` | ok |
| `escape-html` | 1.0.3 | `MIT` | ok |
| `fast-sha256` | 1.3.0 | `Unlicense` | ok |
| `frac` | 1.1.2 | `Apache-2.0` | ok |
| `fsevents` | 2.3.3 | `MIT` | ok |
| `he` | 1.2.0 | `MIT` | ok |
| `html-to-text` | 10.0.1 | `MIT` | ok |
| `htmlparser2` | 10.1.0 | `MIT` | ok |
| `http_ece` | 1.2.0 | `MIT` | ok |
| `https-proxy-agent` | 7.0.6 | `MIT` | ok |
| `iconv-lite` | 0.7.3 | `MIT` | ok |
| `imapflow` | 1.7.6 | `MIT` | ok |
| `immediate` | 3.0.6 | `MIT` | ok |
| `inherits` | 2.0.4 | `ISC` | ok |
| `ip-address` | 10.4.0 | `MIT` | ok |
| `isarray` | 1.0.0 | `MIT` | ok |
| `jose` | 4.15.9 | `MIT` | ok |
| `json-schema-to-ts` | 3.1.1 | `MIT` | ok |
| `jszip` | 3.10.1 | `(MIT OR GPL-3.0-or-later)` | ok |
| `jwa` | 2.0.1 | `MIT` | ok |
| `jws` | 4.0.1 | `MIT` | ok |
| `leac` | 0.7.0 | `MIT` | ok |
| `libbase64` | 1.3.0 | `MIT` | ok |
| `libmime` | 5.4.2 | `MIT` | ok |
| `libqp` | 2.1.1 | `MIT` | ok |
| `lie` | 3.3.0 | `MIT` | ok |
| `linkify-it` | 5.0.2 | `MIT` | ok |
| `lop` | 0.4.2 | `BSD-2-Clause` | ok |
| `lru-cache` | 6.0.0 | `ISC` | ok |
| `lucide-react` | 0.577.0 | `ISC` | ok |
| `mailparser` | 3.9.17 | `MIT` | ok |
| `mammoth` | 1.12.1 | `BSD-2-Clause` | ok |
| `minimalistic-assert` | 1.0.1 | `ISC` | ok |
| `minimist` | 1.2.8 | `MIT` | ok |
| `ms` | 2.1.3 | `MIT` | ok |
| `nanoid` | 3.3.18 | `MIT` | ok |
| `next` | 15.5.24 | `MIT` | ok |
| `next-auth` | 4.24.15 | `ISC` | ok |
| `node-cron` | 3.0.3 | `ISC` | ok |
| `nodemailer` | 9.0.6 | `MIT-0` | ok |
| `oauth` | 0.9.15 | `MIT` | ok |
| `object-hash` | 2.2.0 | `MIT` | ok |
| `oidc-token-hash` | 5.2.0 | `MIT` | ok |
| `on-exit-leak-free` | 2.1.2 | `MIT` | ok |
| `openid-client` | 5.7.1 | `MIT` | ok |
| `option` | 0.2.4 | `BSD-2-Clause` | ok |
| `pako` | 1.0.11 | `(MIT AND Zlib)` | ok |
| `parseley` | 0.13.1 | `MIT` | ok |
| `path-is-absolute` | 1.0.1 | `MIT` | ok |
| `pdf-lib` | 1.17.1 | `MIT` | ok |
| `pdf-parse` | 2.4.5 | `Apache-2.0` | ok |
| `pdfjs-dist` | 5.4.296 | `Apache-2.0` | ok |
| `peberminta` | 0.10.0 | `MIT` | ok |
| `picocolors` | 1.1.1 | `ISC` | ok |
| `pino` | 10.3.1 | `MIT` | ok |
| `pino-abstract-transport` | 3.0.0 | `MIT` | ok |
| `pino-std-serializers` | 7.1.0 | `MIT` | ok |
| `postcss` | 8.5.25 | `MIT` | ok |
| `preact` | 10.29.0 | `MIT` | ok |
| `preact-render-to-string` | 5.2.6 | `MIT` | ok |
| `pretty-format` | 3.8.0 | `MIT` | ok |
| `process-nextick-args` | 2.0.1 | `MIT` | ok |
| `process-warning` | 5.1.0 | `MIT` | ok |
| `punycode.js` | 2.3.1 | `MIT` | ok |
| `quick-format-unescaped` | 4.0.4 | `MIT` | ok |
| `react` | 19.2.8 | `MIT` | ok |
| `react-dom` | 19.2.8 | `MIT` | ok |
| `react-hook-form` | 7.86.0 | `MIT` | ok |
| `readable-stream` | 2.3.8 | `MIT` | ok |
| `real-require` | 0.2.0, 1.0.0 | `MIT` | ok |
| `safe-buffer` | 5.1.2 | `MIT` | ok |
| `safe-stable-stringify` | 2.5.0 | `MIT` | ok |
| `safer-buffer` | 2.1.2 | `MIT` | ok |
| `sax` | 1.6.0 | `BlueOak-1.0.0` | ok |
| `scheduler` | 0.27.0 | `MIT` | ok |
| `selderee` | 0.12.0 | `MIT` | ok |
| `setimmediate` | 1.0.5 | `MIT` | ok |
| `sharp` | 0.35.3 | `Apache-2.0` | ok |
| `smart-buffer` | 4.2.0 | `MIT` | ok |
| `socks` | 2.8.9 | `MIT` | ok |
| `sonic-boom` | 4.2.1 | `MIT` | ok |
| `source-map-js` | 1.2.1 | `BSD-3-Clause` | ok |
| `split2` | 4.2.0 | `ISC` | ok |
| `sprintf-js` | 1.0.3 | `BSD-3-Clause` | ok |
| `ssf` | 0.11.2 | `Apache-2.0` | ok |
| `standardwebhooks` | 1.0.0 | `MIT` | ok |
| `string_decoder` | 1.1.1 | `MIT` | ok |
| `styled-jsx` | 5.1.6 | `MIT` | ok |
| `swagger-ui-dist` | 5.32.14 | `Apache-2.0` | ok |
| `tailwind-merge` | 2.6.1 | `MIT` | ok |
| `thread-stream` | 4.2.0 | `MIT` | ok |
| `tlds` | 1.261.0 | `MIT` | ok |
| `ts-algebra` | 2.0.0 | `MIT` | ok |
| `tslib` | 1.14.1, 2.8.1 | `0BSD` | ok |
| `uc.micro` | 2.1.0 | `MIT` | ok |
| `underscore` | 1.13.8 | `MIT` | ok |
| `undici-types` | 6.21.0 | `MIT` | ok |
| `util-deprecate` | 1.0.2 | `MIT` | ok |
| `uuid` | 11.1.1, 8.3.2 | `MIT` | ok |
| `web-push` | 3.6.7 | `MPL-2.0` | ok · weak copyleft |
| `wmf` | 1.0.2 | `Apache-2.0` | ok |
| `word` | 0.3.0 | `Apache-2.0` | ok |
| `xlsx` | 0.18.5 | `Apache-2.0` | ok |
| `xml-crypto` | 6.1.2 | `MIT` | ok |
| `xml-encryption` | 3.1.0 | `MIT` | ok |
| `xml2js` | 0.6.2 | `MIT` | ok |
| `xmlbuilder` | 10.1.1, 11.0.1, 15.1.1 | `MIT` | ok |
| `xpath` | 0.0.32, 0.0.33, 0.0.34 | `MIT` | ok |
| `yallist` | 4.0.0 | `ISC` | ok |
| `zod` | 3.25.76 | `MIT` | ok |

## How this file is produced and kept honest

- `scripts/check-licenses.mjs` reads `package-lock.json` — no install, no
  network, no extra dependency — and classifies each declared licence through
  the policy table in `scripts/license-policy.mjs`.
- An SPDX id nobody has classified resolves to **unknown**, which fails. The
  default is deliberately "stop and ask a human", not "probably fine".
- `OR` expressions take the most permissive branch (the recipient chooses, so
  we choose); `AND` expressions take the most restrictive (every term binds).
- The signature in the comment at the top covers **package names, declared
  licences and verdicts** — not version numbers. A patch bump that changes
  nothing legally will not fail CI; a new dependency, a removed one, or a
  changed licence will. Regenerate with `npm run check:licenses -- --write`.
- Related: [`docs/trust/vulnerability-management.md`](../trust/vulnerability-management.md)
  (the security side of the same supply chain) and
  [`docs/legal/licensing-strategy.md`](licensing-strategy.md) (why dual
  licensing, and what it requires of us).
