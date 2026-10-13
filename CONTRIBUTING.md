# Contributing to OpenMind Studio

Thank you for helping. By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE) (section 5 of the licence), like the rest of the project.

## Before you start

- Bugs and ideas: open an issue with the version (Help > About), the operating system and the steps.
- Security problems: **don't** open an issue — see [SECURITY.md](SECURITY.md).
- Larger changes: open an issue first, so the design can be agreed before you write the code.

## Making a change

1. Fork the repository and create a branch from `main`.
2. Follow the existing code: Rust (stable, no `unwrap()`/`expect()` outside tests, errors through `thiserror`, logging
   through `tracing`), TypeScript strict with no `any`, files under 700 lines and functions under 80. The architecture
   and the rules are in [CLAUDE.md](CLAUDE.md).
3. Add or update tests for what you change.
4. Run the checks CI runs:

   ```sh
   cargo fmt --all -- --check
   cargo clippy --workspace --all-targets -- -D warnings
   cargo test --workspace
   pnpm lint && pnpm exec tsc --noEmit -p . && pnpm test && pnpm build
   ```

5. Open a pull request against `main`. Every pull request is reviewed by a maintainer before it is merged, and CI must
   pass. Changes to build scripts and `.github/workflows/` get extra attention: release packages are built from them.

## Third-party code

Only add dependencies under an OSI-approved open-source licence, and never copy code whose licence you can't name.
`pnpm licenses:generate` must still find a licence for every component.
