# Contributing

Thanks for the interest. This is a small, opinionated project at v0.5.0; the
public surface is deliberately one hook, and the architectural direction is
fixed for the v1.0.0 cycle. Within that scope, contributions are welcome.

## Before you open a PR

For anything beyond a typo or a one-file bug fix, please open an issue first to
align on direction. Spending an afternoon on a PR I'll need to ask to be
reshaped is no fun for either of us.

A few things that will save back-and-forth:

- **Behaviour-changing PRs need tests.** The library has a property-test layer
  on the strategy state machine and a substrate-invariants suite; both deserve
  to grow with the change.
- **Comment quality matters.** Comments explain *why*, not *what*. See
  `CLAUDE.md` § _Voice and conventions_ for the project's prose register.
- **British English** in committed prose (organisation, behaviour, optimised).
  Source identifiers stay American (`color`, `behavior`) — they match the web
  platform.

## Running the project

```bash
npm install        # resolves workspaces
npm run check      # biome lint + format
npm run typecheck  # tsc --build across workspaces
npm test           # vitest across the library + the demo
npm run bench      # authoritative perf baseline (vitest bench)
```

The pre-commit hook runs `biome check --staged`. Don't bypass it.

## Reporting bugs

Use the GitHub issue tracker: <https://github.com/oracaus/oracaus/issues>.

Useful issue contents:

- minimal reproducer (CodeSandbox / StackBlitz link, or a small repo),
- the version of `@oracaus/coherent-derivation` you're on,
- what you expected vs. what you saw,
- browser and runtime if it's behaviour-specific.

## Security issues

See [SECURITY.md](./SECURITY.md) — please don't file these publicly.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md). By
participating you agree to abide by its terms.
