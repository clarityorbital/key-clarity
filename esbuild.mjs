import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  outfile: "dist/extension.js",
  external: ["vscode"],
  // jsonc-parser's UMD entry loads its own files at runtime; its ESM build bundles cleanly.
  mainFields: ["module", "main"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
