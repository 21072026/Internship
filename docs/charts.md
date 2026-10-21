# Charts (#1890)

Decision record for the charting layer, and the rules for using it.

## Decision

**visx** (`@visx/shape`, `@visx/scale`, `@visx/group`, `@visx/responsive`, all 4.0.0),
behind four thin wrappers in `src/components/charts/`: `BarChart`, `LineChart`,
`AreaChart`, `Donut`.

## Why

Requirements from the issue: SVG output (it prints and scales), no runtime CDN fetch,
React 19 + App Router, and tree-shakeable or dynamically importable under a stated bundle
budget.

| Candidate | What the four chart shapes cost (minified + gzip, react external) | Notes |
|---|---|---|
| **visx 4** | **19.5 KB** | SVG primitives + d3 scales; we draw the marks, so testids, `<title>`s and CSS-variable colours sit on the real elements. React 18/19 peer. |
| recharts 3 | 120 KB | Complete charts out of the box, but six times the weight (it ships redux toolkit, immer and reselect) and its marks are generated — attaching a `data-testid` per bar needs a custom `shape` anyway. |
| hand-rolled SVG + d3-scale | 8.7 KB (scales only) | Smallest, but it is a second chart library to maintain, and it is what the old `<div>` track was. |

Measured with `esbuild --bundle --minify` over an entry that re-exports exactly the parts each
wrapper set uses. visx is the smallest real library, and owning the marks is what this
codebase needs: every e2e spec here reads charts through testids and values.

## Rules

- **Import from `@/components/charts`, never from an implementation file.** The index
  loads each chart with `next/dynamic` (`ssr: false`), so `@visx/*` is a separate chunk
  that a page fetches only when it draws a chart. This is the same pattern as
  `await import('xlsx')` in `src/lib/excel.ts`.
- **Colours are CSS values, normally `var(--chart-N)`.** The tokens live in
  `src/app/globals.css`, and `html.dark` redefines them. `--chart-1` follows the accent
  ramp, so a user's accent and an org's brand palette (#2922) reach the charts. An SVG
  cannot see Tailwind classes or the `html.dark` utility overrides, so a chart never takes
  a `bg-*` class and never has a per-theme branch.
- **The wrappers know nothing about the domain.** They take categories (already
  formatted labels) and series (`{ key, label, color, values, testIdPrefix }`). Shaping
  the data stays in the page.
- **`null` is a gap, not a zero** (`LineChart`/`AreaChart`). Use it for a value that does
  not exist yet, such as an empty month or a window that has not closed.
- **Every mark carries `data-label` and `data-value`**, and `data-testid` when the series
  has a `testIdPrefix`. Specs assert on those, not on pixels alone
  (`e2e/analytics-trends.spec.ts`).
- **Width is measured, not inherited.** The plot reads its width from a ResizeObserver
  and its height from a prop. No CSS percentage height is left to collapse, which was the
  failure in #1425. Category labels thin themselves out when the width cannot fit them,
  so a 360px phone never scrolls sideways.

## Where it is used

- `/admin/analytics`: the trends bars (`analytics-trend-chart`, `trend-bar-new-<i>`,
  `trend-bar-interactions-<i>`) and the conversion-by-entry-month line
  (`conversion-trend-chart`, `conversion-point-<i>`).
- `/mentor/feedback`: the six-month average (`mentor-feedback-trend`,
  `mentor-feedback-bar-<i>`).
