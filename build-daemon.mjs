import * as esbuild from "esbuild";

// Targets Node 18: older than the Elgato host's bundled runtime, and what a
// distro's packaged Node is likely to be.
await esbuild.build({
  entryPoints: ["src/daemon/main.ts"],
  bundle: true,
  outfile: "dist/promdeck-daemon.cjs",
  platform: "node",
  target: "node18",
  format: "cjs",
  sourcemap: true,
  // Native addons cannot be bundled; they are resolved from node_modules at
  // runtime on the target host.
  external: ["@elgato-stream-deck/node", "@resvg/resvg-js"],
});
console.log("built dist/promdeck-daemon.cjs");
