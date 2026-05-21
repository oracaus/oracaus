# Security policy

## Reporting a vulnerability

If you believe you've found a security issue in `@oracaus/coherent-derivation` or
the demo, please **do not** open a public GitHub issue. Reach out privately via
[LinkedIn](https://www.linkedin.com/in/przemyslawkalka/?locale=en-US) with:

- a description of the issue,
- a minimal reproducer (or sketch of the attack surface), and
- the version of `@oracaus/coherent-derivation` (or the demo's commit SHA) you
  observed it against.

I'll acknowledge within 7 days and aim to confirm or refute within 14. Once a
fix is published I'll credit the reporter in the changelog (or honour an
anonymity request).

## Threat model worth knowing

`@oracaus/coherent-derivation` reconstructs the adopter's `compute` function in a
Web Worker via `new Function(compute.toString())`. The source string crossing
`postMessage` is **the adopter's own code**, captured from their bundle — not
arbitrary remote input. The library exposes no path from user-supplied data
through to `new Function`. In CSP-restricted environments (or where the
`unsafe-eval` directive is unavailable) adopters supply a bundled worker via
`workerFactory`, and the `new Function` path is not taken.

If you discover a way to drive untrusted data into the reconstruction path
through the library's public API, that's the kind of issue this policy exists
for.
