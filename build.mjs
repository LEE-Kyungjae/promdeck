import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: ["src/plugin.ts"],
  bundle: true,
  outfile: "com.ze.promdeck.sdPlugin/bin/plugin.js",
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  // The Stream Deck host runs the plugin with its own Node runtime, so the
  // bundle must be self-contained.
  external: [],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("watching...");
} else {
  await esbuild.build(options);
  console.log("built com.ze.promdeck.sdPlugin/bin/plugin.js");
}
