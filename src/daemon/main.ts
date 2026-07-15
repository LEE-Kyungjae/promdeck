/**
 * Headless Stream Deck daemon.
 *
 * Drives the deck directly over USB HID, with no Stream Deck host software and
 * no display. This is what runs on a headless server that the deck is plugged
 * into -- Elgato ships nothing for Linux, and OpenDeck needs a desktop session.
 *
 * The polling, rendering and threshold logic is shared with the Elgato plugin;
 * only the device binding differs.
 */

import { openStreamDeck, listStreamDecks, type StreamDeck } from "@elgato-stream-deck/node";
import { Resvg } from "@resvg/resvg-js";

import { evaluate, isDisconnected } from "../evaluate.js";
import { renderButtonSvg, type ButtonModel } from "../render.js";
import { loadConfig, ConfigError, type ButtonConfig, type Config } from "./config.js";

const CONFIG_PATH = process.argv[2] ?? process.env.PROMDECK_CONFIG ?? "/etc/promdeck/config.json";

type KeyGeometry = { index: number; width: number; height: number };

function log(msg: string): void {
  // Plain stdout: journald timestamps it under systemd, and a bare line is
  // easier to read there than a re-implemented timestamp.
  console.log(msg);
}

/**
 * Rasterises a key face to the raw RGBA the device expects.
 *
 * Size comes from the device's own control definition rather than a constant,
 * so an XL (96px), an MK.2 (72px) or a Stream Deck + all work unchanged.
 */
function rasterise(svg: string, width: number, height: number): Buffer {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: width } });
  const rendered = resvg.render();

  if (rendered.width !== width || rendered.height !== height) {
    throw new Error(`rasterised ${rendered.width}x${rendered.height}, device wants ${width}x${height}`);
  }

  return Buffer.from(rendered.pixels);
}

async function draw(deck: StreamDeck, geom: KeyGeometry, model: ButtonModel): Promise<void> {
  const pixels = rasterise(renderButtonSvg(model), geom.width, geom.height);
  await deck.fillKeyBuffer(geom.index, pixels, { format: "rgba" });
}

async function poll(deck: StreamDeck, geom: KeyGeometry, cfg: Config, button: ButtonConfig): Promise<void> {
  const model = await evaluate(cfg.promUrl, button);

  if (model.overrideText && model.overrideText !== (button.downText ?? "DOWN")) {
    log(`[${button.title}] ${isDisconnected(model) ? "prometheus unreachable" : model.overrideText}`);
  }

  await draw(deck, geom, model).catch((err) => log(`[${button.title}] could not draw: ${err}`));
}

async function main(): Promise<void> {
  const cfg = loadConfig(CONFIG_PATH);
  log(`config: ${CONFIG_PATH} (${cfg.buttons.length} buttons, prometheus ${cfg.promUrl})`);

  const devices = await listStreamDecks();
  if (devices.length === 0) {
    throw new Error("no Stream Deck found. Check it is plugged in, and that the udev rule grants access.");
  }

  const deck = await openStreamDeck(devices[0].path);
  const buttons = deck.CONTROLS.filter((c) => c.type === "button");
  log(`device: ${deck.PRODUCT_NAME} (${buttons.length} keys)`);

  // Read geometry off the device instead of assuming a model.
  const geometry = new Map<number, KeyGeometry>();
  for (const control of buttons) {
    if (control.feedbackType === "lcd") {
      geometry.set(control.index, {
        index: control.index,
        width: control.pixelSize.width,
        height: control.pixelSize.height,
      });
    }
  }

  const configured = new Map<number, ButtonConfig>();
  for (const button of cfg.buttons) {
    if (!geometry.has(button.key)) {
      throw new ConfigError(
        `"${button.title}" targets key ${button.key}, but ${deck.PRODUCT_NAME} has no drawable key there ` +
          `(valid: 0-${buttons.length - 1})`,
      );
    }
    configured.set(button.key, button);
  }

  await deck.setBrightness(cfg.brightness);
  await deck.clearPanel();

  const timers: NodeJS.Timeout[] = [];

  // Closing the HID handle while a fillKeyBuffer write is still in flight
  // segfaults node-hid, taking the process down with a core dump instead of a
  // clean exit. Track outstanding work so shutdown can drain it first.
  const inFlight = new Set<Promise<void>>();

  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  for (const [key, button] of configured) {
    const geom = geometry.get(key)!;
    const run = (): void => track(poll(deck, geom, cfg, button));

    run();
    timers.push(setInterval(run, Math.max(2, button.refreshSec ?? cfg.refreshSec) * 1000));
  }

  // A press forces that key to refresh now. There is no browser to open a
  // dashboard in on a headless box, so this is the useful thing a key can do.
  deck.on("down", (control) => {
    if (control.type !== "button") return;
    const button = configured.get(control.index);
    const geom = geometry.get(control.index);
    if (button && geom) {
      log(`[${button.title}] refresh (pressed)`);
      track(poll(deck, geom, cfg, button));
    }
  });

  deck.on("error", (err) => {
    // Usually the deck was unplugged. Exit and let systemd restart us rather
    // than sit here holding a dead handle.
    log(`device error: ${err}`);
    void shutdown(1);
  });

  let closing = false;
  async function shutdown(code: number): Promise<void> {
    if (closing) return;
    closing = true;

    for (const t of timers) clearInterval(t);

    // Let outstanding writes land before touching the handle. allSettled, not
    // all: a rejected poll must not skip the drain.
    await Promise.allSettled([...inFlight]);

    try {
      await deck.clearPanel();
    } catch {
      // Deck already gone; the exit below is what matters.
    }

    // Exit via SIGKILL rather than process.exit().
    //
    // Node's normal teardown unwinds the native HID module while its reader
    // thread is still live, which segfaults reproducibly (3/3) once real key
    // writes have happened -- turning every stop into a core dump. There is
    // nothing to flush here: the panel is already cleared and the kernel
    // reclaims the fd. So skip teardown entirely.
    //
    // systemd is told this is a clean stop via SuccessExitStatus=SIGKILL.
    process.kill(process.pid, "SIGKILL");
  }

  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));

  log("running");
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    console.error(`config error: ${err.message}`);
  } else {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  }
  process.exit(1);
});
