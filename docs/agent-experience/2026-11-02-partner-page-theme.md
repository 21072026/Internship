# 2026-11-02 — Partner page theme (#3535)

- **`next/font` loaders take literals only.** `Inter(opts)` with a shared `opts`
  object fails the build with "Font loader values must be explicitly written
  literals"; write the options out in every call.
- **A worktree's `.env` should name its own database.** Creating
  `internship_<issue>` in the local MySQL container (as root, `GRANT` to the app
  user) and pointing the worktree's `.env` at it keeps `db push` from touching
  another session's schema. `npm run seed:demo` reads `process.env`, not `.env`:
  `set -a; source .env; set +a` first, and use `localhost`, not `127.0.0.1`, or
  its "is this local?" guard refuses.
- **Media can be made in the browser.** With no ffmpeg or Pillow on the machine,
  a `<canvas>` gives a PNG/JPEG (`toBlob`) and `canvas.captureStream()` +
  `MediaRecorder` a short WebM — enough to exercise an upload route and a video
  player without any third-party asset.
- **A WCAG "large text" button is a design tool.** A saturated brand colour
  (an orange) fails 4.5:1 with white; rendered at 19px bold the label counts as
  large text and 3:1 suffices. Decide such sizes in code, then let the rule derive
  the text colour instead of asking the admin for one.
- **The admin onboarding tour swallows clicks** on a fresh demo admin; skip it
  before driving `/admin/*` in the browser pane.
- **`scripts/test/gitignore-exports.test.mjs` fails on macOS** (case-insensitive
  `git check-ignore` for `accounts.CSV`), independent of any change — CI on Linux
  is the judge.
