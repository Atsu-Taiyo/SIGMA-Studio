# Repository guidance

- Use npm from the repository root. Desktop source paths are under `apps/desktop/`.
- Preserve unrelated changes and keep work scoped to the request.
- Read `MISS.md` before changing save, merge, or proposal approval behavior.
- SigmaDoc JSON is canonical. Tiptap, canvas editing state, and output DOM are derived views.
- Keep document and rendering core independent of React, editor components, and AI. Keep drawing and text-editing models framework-neutral.
- Keep AI implementations behind generic editor contracts. Canonical feature modules must not import legacy compatibility facades.
- Follow `docs/architecture.md` for ownership and dependency boundaries; use `tests/helpers/source-dependencies.ts` for dependency inspection.
- Follow `docs/pdf-parity-architecture.md` for PDF. Use the settled PageCanvas output session; never create a second pagination engine.
- Follow `docs/design-rules.md` for UI. Use in-app dialogs; only OS file pickers are exempt.
- Preserve Japanese product copy and existing localization conventions.
- Run focused tests first, typecheck for shared contracts, and lint for substantial changes. Verify saved/reloaded outcomes and cleanup, not only immediate UI.
- Public packages require actual build settings, generated declarations, Bundler/NodeNext consumers, and React 18 browser checks. See `CONTRIBUTING.md`.
- Do not publish packages, installers, or changes to release assets as a side effect of local verification.
