/**
 * `import.meta.glob` for the WORKER project only.
 *
 * The Worker shares the engine, and the engine globs `presets/*.json` to build
 * the garden-preset registry. Both bundles go through Vite (the app directly,
 * the Worker via @cloudflare/vite-plugin), so the call resolves at build time
 * in both — but tsconfig.worker.json deliberately loads no ambient @types (the
 * Cloudflare runtime globals would collide with node/DOM), so it has no
 * `vite/client` and no type for this.
 *
 * Kept OUTSIDE `src/` on purpose: tsconfig.app.json includes all of `src`, and
 * a second declaration of `glob` there would conflict with vite/client's.
 */
interface ImportMeta {
  glob(
    pattern: string,
    options?: { eager?: boolean; import?: string },
  ): Record<string, unknown>;
}
