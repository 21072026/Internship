# Interest signup (#1406), 2026-11-16

The issue's line numbers predated tenant host routing, canonical enquiry
attribution, contact double opt-in and the sealed mail outbox. Inspecting current
main first avoided a second UTM or delivery stack. Public interest records need
an explicit subscriber credential in the existing sealed envelope because they
have no User preference row. Consent must be rechecked after approval/queueing,
not just when composing. An unsubscribed or deleted row must remain a veto.

Validation uses an isolated local MySQL database and namespaced synthetic
fixtures with SMTP disabled. New tests exercise API anti-spam/consent,
confirmation, terminal withdrawal, queued/inline suppression, admin access and
the landing control. TypeScript needs an explicit larger Node heap locally.
