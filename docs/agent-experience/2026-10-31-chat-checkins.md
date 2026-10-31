# 2026-10-31 — Multi-step chat flows without a state table

- **A multi-click chat flow can carry its state in the button value.** Survey answers so far ride
  in the next button's `value` (`invitationId|next|base64url(JSON)`), so nothing half-answered is
  ever stored and the engine's single `submitSurveyResponse()` stays the only writer. The value is
  the clicker's own claim — decode strictly (id regex, flat object, primitives only) and let the
  engine validate it like a form post.
- **Identical Slack bodies inside the replay window answer 401.** A test that clicks the same
  button twice must vary `action_ts`, or the second click is rejected before the handler runs.
- **`scripts/test/notification-catalog.test.mjs` mirrors `EMAIL_GROUPS` by hand.** A catalog
  event in a group the mirror lacks (here `surveys`) fails that test, not tsc.
- **Run chat e2e against the production build.** `next dev` cold-compiles the interaction route
  on the first click and the response-url poll times out; `npm run build` with
  `NODE_OPTIONS=--max-old-space-size=7168` then `CI=1 npx playwright test …` is stable.
