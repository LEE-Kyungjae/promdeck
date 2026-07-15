import streamDeck, {
  action,
  SingletonAction,
  type DidReceiveSettingsEvent,
  type JsonObject,
  type KeyDownEvent,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";

import { num } from "../coerce.js";
import { evaluate } from "../evaluate.js";
import { renderButton } from "../render.js";

export type MetricSettings = {
  /** Prometheus base URL, e.g. http://localhost:9090. */
  promUrl?: string;
  title?: string;
  query?: string;
  /** Optional gate: when it returns 0, the key shows down regardless of `query`. */
  healthQuery?: string;
  downText?: string;
  unit?: string;
  decimals?: number;
  warn?: number;
  crit?: number;
  /** When true, lower values are worse (e.g. `up`, success rate). */
  invert?: boolean;
  sparkQuery?: string;
  sparkRange?: string;
  refreshSec?: number;
  /** Opened on key press — the drill-down into Grafana. */
  openUrl?: string;
} & JsonObject;

const DEFAULTS = {
  promUrl: "http://localhost:19090",
  title: "metric",
  unit: "",
  decimals: 1,
  sparkRange: "30m",
  refreshSec: 10,
} as const;

@action({ UUID: "com.ze.promdeck.metric" })
export class MetricAction extends SingletonAction<MetricSettings> {
  /** One poll timer per visible key. */
  private readonly timers = new Map<string, NodeJS.Timeout>();

  override onWillAppear(ev: WillAppearEvent<MetricSettings>): void {
    this.start(ev.action.id, ev.payload.settings);
  }

  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<MetricSettings>): void {
    // Settings changed in the Property Inspector: re-poll immediately so the
    // key reflects the edit without waiting out the refresh interval.
    this.start(ev.action.id, ev.payload.settings);
  }

  override onWillDisappear(ev: WillDisappearEvent<MetricSettings>): void {
    this.stop(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<MetricSettings>): Promise<void> {
    const url = ev.payload.settings.openUrl?.trim();
    if (url) {
      await streamDeck.system.openUrl(url);
      return;
    }

    // No drill-down configured, so make the press do the other useful thing:
    // force an out-of-band refresh.
    await this.poll(ev.action.id, ev.payload.settings);
  }

  private start(actionId: string, settings: MetricSettings): void {
    this.stop(actionId);

    const refreshMs = Math.max(2, num(settings.refreshSec) ?? DEFAULTS.refreshSec) * 1000;
    void this.poll(actionId, settings);

    this.timers.set(
      actionId,
      setInterval(() => void this.poll(actionId, settings), refreshMs),
    );
  }

  private stop(actionId: string): void {
    const timer = this.timers.get(actionId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(actionId);
    }
  }

  private async poll(actionId: string, settings: MetricSettings): Promise<void> {
    const target = this.actions.find((a) => a.id === actionId);
    if (!target?.isKey()) {
      return;
    }

    const model = await evaluate(settings.promUrl?.trim() || DEFAULTS.promUrl, {
      title: settings.title?.trim() || DEFAULTS.title,
      query: settings.query?.trim() ?? "",
      healthQuery: settings.healthQuery?.trim(),
      downText: settings.downText?.trim(),
      unit: settings.unit ?? DEFAULTS.unit,
      decimals: num(settings.decimals) ?? DEFAULTS.decimals,
      warn: num(settings.warn),
      crit: num(settings.crit),
      invert: settings.invert ?? false,
      sparkQuery: settings.sparkQuery?.trim(),
      sparkRange: settings.sparkRange ?? DEFAULTS.sparkRange,
    });

    if (model.overrideText === "NO CONN" || model.overrideText === "ERR") {
      streamDeck.logger.warn(`poll failed for ${model.title}: ${model.overrideText}`);
    }

    await target.setImage(renderButton(model));
  }
}
