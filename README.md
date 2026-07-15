# promdeck

Put your Prometheus metrics on Stream Deck keys.

Each key runs a PromQL query on a timer, colours itself against your thresholds,
draws a sparkline, and opens a dashboard when you press it. Glance at your desk
instead of alt-tabbing to Grafana.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│     CPU      │  │    MEMORY    │  │     API      │
│              │  │              │  │              │
│    23.4%     │  │    81.2%     │  │   NO CONN    │
│   ╭─╮   ╭╮   │  │      ╭───╮   │  │              │
│ ──╯ ╰───╯╰── │  │ ─────╯   ╰─  │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
     green             amber              grey
```

## Why not just render Grafana?

A Stream Deck key is 72–96px. Grafana's image renderer can produce a PNG of a
panel, but at that size the axes, legend and labels are mush. So promdeck draws
its own minimal face — one number, one colour, one sparkline — and links out to
the real dashboard on press. The deck is the glance layer; Grafana stays the
drill-down.

## Install

Needs Node 20+ to build. The plugin runs on the Stream Deck host's own runtime.

```sh
git clone https://github.com/LEE-Kyungjae/promdeck
cd promdeck
npm install
npm run build
```

Then load `com.ze.promdeck.sdPlugin` into your host:

| OS | Host | How |
|---|---|---|
| macOS / Windows | [Elgato Stream Deck](https://www.elgato.com/downloads) | `npm i -g @elgato/cli && npm run link`, or copy the `.sdPlugin` folder into the plugins directory |
| Linux, desktop | [OpenDeck](https://github.com/nekename/OpenDeck) | Copy the `.sdPlugin` folder into its plugins directory |
| Linux, headless | promdeck's own daemon | See [Headless Linux](#headless-linux) |

**On Linux:** Elgato ships no Linux software. OpenDeck runs original Stream Deck
SDK plugins, and promdeck is a plain Node bundle rather than a compiled binary,
so it needs no Wine. Note that `streamdeck-linux-gui` will *not* work — it
cannot load SDK plugins at all.

The manifest declares mac/windows because the Elgato manifest schema has no
`linux` value. OpenDeck does not gate on it.

## Headless Linux

If the deck is plugged into a server with no desktop session, there is no host
software to run — OpenDeck is a GUI app. promdeck ships a daemon that drives the
deck directly over USB HID instead. Same queries, same rendering, no display.

```sh
npm install
npm run build:daemon        # -> dist/promdeck-daemon.cjs
```

Copy `dist/promdeck-daemon.cjs` to the target, install the two native deps
beside it, and point it at a config:

```sh
node promdeck-daemon.cjs /etc/promdeck/config.json
```

Start from [`config.example.json`](config.example.json). Keys are indexed from 0
at the top-left; unlisted keys stay blank. A key press forces that key to
refresh — there is no browser to open a dashboard in, so `Open on press` does
not apply here.

**Grant HID access** so the daemon need not run as root:

```sh
# /etc/udev/rules.d/99-streamdeck.rules
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="0fd9", GROUP="plugdev", MODE="0660", TAG+="uaccess"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0fd9", GROUP="plugdev", MODE="0660", TAG+="uaccess"
```

```sh
sudo udevadm control --reload-rules
sudo udevadm trigger --action=add --subsystem-match=hidraw
```

`--action=add` matters. A plain `udevadm trigger` will not re-run permissions on
the existing node, and you will be left wondering why the rule "did nothing".
Add your user to `plugdev` and confirm `/dev/hidraw*` shows `crw-rw---- root
plugdev`.

### Remove @julusian/jpeg-turbo

The daemon's `postinstall` deletes `@julusian/jpeg-turbo`, and that is
deliberate — do not restore it.

Stream Deck keys are transmitted as JPEG. `@elgato-stream-deck` prefers
`@julusian/jpeg-turbo` and falls back to the pure-JS `jpeg-js` only when the
former cannot be **found**. On arm64 Linux the prebuilt binary can be broken, in
which case merely `require`-ing it segfaults the process — which no `try/catch`
can rescue, because the fallback is guarded by exactly that. Symptom: the deck
opens and the daemon logs `running`, then dies with no JS error;
`fillKeyColor` works while `fillKeyBuffer` never returns. Deleting the module
turns the failed load into a catchable one and the JS encoder takes over. At
96x96 the speed difference does not matter.

### systemd

```ini
[Service]
User=ubuntu
SupplementaryGroups=plugdev
WorkingDirectory=/opt/promdeck
ExecStart=/usr/bin/node /opt/promdeck/promdeck-daemon.cjs /etc/promdeck/config.json
Restart=always
RestartSec=5
SuccessExitStatus=SIGKILL
```

`SuccessExitStatus=SIGKILL` is required. On shutdown the daemon clears the panel
and then SIGKILLs itself: letting Node unwind the native HID module while its
reader thread is live segfaults. Nothing needs flushing, so the abrupt exit is
the clean one — but systemd must be told to read it that way.

## Works on any Stream Deck

Key faces are SVG drawn against a fixed `144x144` viewBox and handed to the host
as a data URI. The host rasterises to whatever your hardware actually uses —
72px on a Mini/MK.2, 96px on an XL, 120px on a Stream Deck +. No key dimension
appears anywhere in the code, so new devices need no changes.

## Settings

Configure each key in the Property Inspector:

| Setting | Meaning |
|---|---|
| Prometheus URL | Base URL, e.g. `http://localhost:9090`. No trailing path. |
| Title | Short label across the top. |
| Query | Instant PromQL. First sample of the first series wins — aggregate if your query returns many. |
| Health query | Optional gate. When it returns 0 — or nothing — the key shows down regardless of Query. See below. |
| Down text | What a gated-down key says. Default `DOWN`. |
| Unit | Appended to the value. `%`, `ms`, `B`, … |
| Decimals | 0–3. |
| Warn at / Crit at | Thresholds. **Leave blank to disable** — a blank threshold never colours the key. |
| Lower is worse | Invert thresholds. Use for `up`, success rates, free disk. |
| Sparkline query | Defaults to Query. |
| Sparkline range | `30m`, `2h`, `90s`. |
| Refresh (sec) | Poll interval, minimum 2. |
| Open on press | URL to open. Blank = press forces a refresh instead. |

Large numbers are compacted automatically (`1400000` → `1.4M`) when the unit is
blank or byte-like.

## Key states

| Face | Meaning |
|---|---|
| Value + colour | Normal. Green / amber / red by threshold. |
| `—` grey | Query is valid but matched no series. |
| `NO CONN` grey | Prometheus is unreachable. |
| `ERR` red | Prometheus returned an error — usually bad PromQL. |
| `SET Q` grey | No query configured yet. |

`NO CONN` is deliberately distinct from `—`. If a broken network path rendered
the same as a broken service, every key would lie to you the moment your tunnel
or VPN dropped. When you see `NO CONN`, the key is reporting on *itself*, not on
your service.

### Pick one meaning for red

A board you have to decode is a board you will not read at 3am. Decide up front
what red means and hold every key to it. One convention that works:

> **Red: users are affected right now. Amber: worth a look, nobody is hurting.**

So a failed probe of your front page is red, while your metrics pipeline losing
a scrape target is amber — your dashboard is partially blind, but nobody is
being turned away. Set `Crit at` only on the keys that clear that bar, and leave
it blank elsewhere so those keys can never go red.

The same discipline applies to direction. Keys are easiest to read when low is
always good — outages, latency, saturation. When a key is inevitably the other
way round (days until a certificate expires), set `Lower is worse` and give it a
unit, so the `d` tells the reader which way to read it.

## One key per service, not two

A key showing `1` tells you nothing you could not get from its colour, and it
costs you the key. Prefer a number worth reading, gated by a health check.

No single query can express both "is it reachable" and "how fast is it". A
failed blackbox probe still reports a `probe_duration_seconds` — how long the
failure took — so a latency key on its own will show a confident number for a
site that is off the air. That is what `Health query` is for:

| Setting | Value |
|---|---|
| Title | `www` |
| Query | `probe_duration_seconds{instance="https://example.com"} * 1000` |
| Health query | `probe_success{instance="https://example.com"}` |
| Unit | `ms` |
| Warn / Crit | `1500` / `3000` |

Healthy, that key reads `540ms` in green and its sparkline shows the trend. Down,
it reads `DOWN` in red. One key replaces an up/down key plus a latency key, and
there is no `1` to decode.

A health query that returns *nothing* also counts as down: a probe reporting
no result at all is not evidence of a working service.

## Recipes

Start here and adapt. These assume the usual exporters.

**Is anything down at all** — `Lower is worse` off, warn `1`:
```promql
count(up == 0) or vector(0)
```

The `or vector(0)` is not optional. `up == 0` matches no series when everything
is healthy, and `count()` of nothing is *empty*, not zero — so the bare version
renders `—` exactly when all is well, which reads identically to a broken query.
The same trap applies to any `count`/`sum` whose selector can match nothing.

**A specific target is up** — `Lower is worse` **on**, crit `0`:
```promql
up{job="my-service"}
```

**Host CPU %** (node_exporter) — warn `70`, crit `90`, unit `%`:
```promql
100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
```

**Host memory %** (node_exporter) — warn `80`, crit `90`, unit `%`:
```promql
(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100
```

**Host disk %** (node_exporter) — warn `75`, crit `90`, unit `%`:
```promql
(1 - node_filesystem_avail_bytes{mountpoint="/"} / node_filesystem_size_bytes{mountpoint="/"}) * 100
```

**Load average** (node_exporter) — warn `4`, crit `8`:
```promql
node_load1
```

**Request rate** — unit `rps`:
```promql
sum(rate(http_requests_total{job="my-service"}[5m]))
```

**Error rate %** — warn `1`, crit `5`, unit `%`:
```promql
sum(rate(http_requests_total{job="my-service",status=~"5.."}[5m]))
  / sum(rate(http_requests_total{job="my-service"}[5m])) * 100
```

**p95 latency** — unit `ms`:
```promql
histogram_quantile(0.95,
  sum(rate(http_request_duration_seconds_bucket{job="my-service"}[5m])) by (le)
) * 1000
```

**JVM heap %** (Micrometer / Spring Actuator) — warn `75`, crit `90`, unit `%`:
```promql
sum(jvm_memory_used_bytes{job="my-service",area="heap"})
  / sum(jvm_memory_max_bytes{job="my-service",area="heap"}) * 100
```

**Pods not ready** (kube-state-metrics) — warn `1`:
```promql
count(kube_pod_status_ready{condition="true"} == 0)
```

**Certificate days left** (blackbox_exporter) — `Lower is worse` **on**, warn
`14`, crit `3`, unit `d`:
```promql
(probe_ssl_earliest_cert_expiry - time()) / 86400
```

### If a rate-based key reads wildly high at first

On a freshly started Prometheus, `rate(...[5m])` extrapolates over a window it
does not have data for yet, so keys built on it can read nonsense for the first
few minutes. Measured on an idle 4-core host with ~2 minutes of history: the
`[5m]` CPU recipe reported 66% while `[1m]` reported 8.6% and the true value was
~8%. It converges on its own once the window fills — `[5m]` matched `[1m]` to
within 0.1pp after about four minutes. Wait it out rather than lowering your
thresholds to fit it.

### If a key shows `—`

The query returned no series. Common causes: the metric name is wrong, your
label selector matches nothing, or the meter does not exist yet. Some
instrumentation is lazy — Micrometer's `http_server_requests_*`, for example,
only appears after the first HTTP request reaches the service. Paste the query
into Prometheus's own expression browser to confirm before blaming the key.

## Architecture

```
src/prometheus.ts   HTTP API client (instant + range). No Elgato dependency.
src/render.ts       SVG key face, thresholds, sparkline. No Elgato dependency.
src/coerce.ts       Settings coercion. No Elgato dependency.
src/actions/metric.ts   Binds the above to the Stream Deck SDK.
src/plugin.ts       Entry point.
```

The core carries no Elgato dependency, so retargeting to a different host means
swapping the binding, not rewriting the logic.

## Development

```sh
npm run watch    # rebuild on change
npm run restart  # restart the plugin in the Elgato host
```

## Security

promdeck talks to Prometheus with no authentication. Prometheus has no auth of
its own either, so whatever you point this at should be on a trusted network or
behind something that does authenticate. Do not expose a Prometheus to the
public internet just to reach it from your deck.

## License

MIT
