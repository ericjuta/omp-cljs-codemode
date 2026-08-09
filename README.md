# OMP CLJS codemode

`@ericjuta/omp-cljs-codemode` adds `language: "cljs"` cells to OMP's native `eval` tool.

## Call flow

The path is direct; Vite is not involved:

```text
model eval call (language: "cljs")
  -> Squint compileStringEx(..., { context: "return", async: true, "elide-exports": true })
  -> rewrite the Squint core import to this package's pinned runtime
  -> delegate the generated JavaScript to OMP's native eval tool
  -> return the native eval result
```

The sole model-visible `eval` tool schema accepts `language: "cljs"`. On OMP 17.2.12 or newer, native JavaScript must remain enabled as the hidden execution backend; it is not exposed as a model-selectable language by this plugin.

## Install and operate

The repository is private, so authenticate GitHub SSH first. Install an immutable tag:

```sh
omp plugin install 'git+ssh://git@github.com/ericjuta/omp-cljs-codemode.git#v0.1.2'
```

When upgrading from v0.1.1, install v0.1.2 under its new package identity first. Disable and uninstall the historical package only after that install succeeds:

```sh
omp plugin install 'git+ssh://git@github.com/ericjuta/omp-cljs-codemode.git#v0.1.2' && \
  omp plugin disable @t-y-b-b/omp-cljs-codemode && \
  omp plugin uninstall @t-y-b-b/omp-cljs-codemode
```

The success-gated sequence preserves the currently working historical package if the target install fails.

The installed package name is `@ericjuta/omp-cljs-codemode`.

Disable or re-enable the whole plugin for subsequent OMP processes:

```sh
omp plugin disable @ericjuta/omp-cljs-codemode
omp plugin enable @ericjuta/omp-cljs-codemode
```

Plugin enablement is persisted in OMP's plugin state (`omp-plugins.lock.json`, normally below `~/.omp/plugins`; XDG and project plugin roots may relocate it). Start a new OMP process after changing it.

### Isolated source checkout

Install the checkout's pinned dependencies, assign the model explicitly, then load only `index.ts` as an extension. The command exposes only `eval` as a top-level tool:

```sh
bun install --frozen-lockfile
export CLJS_CODEMODE_EVAL_MODEL=provider/model
omp --no-session --mode json --auto-approve \
  --no-extensions -e "$PWD/index.ts" \
  --tools eval --model "$CLJS_CODEMODE_EVAL_MODEL" \
  'Use eval with language cljs to compute 6 * 7. Return only the observed value.'
```

`--no-extensions` suppresses ambient extensions but retains the explicit `-e` entry. `--no-session` keeps the transcript in memory.

## Use

One tool call is one Squint cell:

```json
{
  "language": "cljs",
  "code": "(def answer (* 6 7))\nanswer"
}
```

The final CLJS expression follows native JavaScript eval semantics. `(display value)`, stdout, and stderr are captured by the native result contract; a cell with no visible value reports the native no-output result.

Cells share OMP's retained JavaScript runtime within a session, so definitions survive later CLJS calls:

```json
{"language":"cljs","code":"(def guidance-probe 41)","reset":true}
{"language":"cljs","code":"(+ guidance-probe 1)"}
```

`reset: true` recreates the shared JS/CLJS runtime before that cell and clears prior definitions. State ends when the owning OMP process/session runtime ends; it is not written into source files.

### Async helpers and tool bridge

CLJS cells retain the JavaScript codemode helpers: `display`, `read`, `write`, `env`, `output`, `tool`, `completion`, `agent`, `parallel`, and `pipeline`. JavaScript-facing filesystem and tool operations return promises, so await them through Squint interop:

```clojure
(let [text (js/await (js/read "package.json"))]
  (aget (js/JSON.parse text) "name"))
```

Call a registered tool through the proxy:

```clojure
(js/await (.read tool {:path "package.json"}))
```

For a tool name that is not a valid CLJS identifier, use dynamic lookup:

```clojure
(js/await ((aget tool "my-hyphenated-tool") {:arg "value"}))
```

Tool bridge calls preserve the native tool's permissions and side effects. Prefer `js/read(...)` when raw file text is sufficient; `tool.read(...)` returns the normal OMP tool response shape.

## Boundary: project-local CLJS namespaces

This extension compiles one source string; it does not build a CLJS project, resolve a source tree, or provide a CLJS classpath. Consequently, a form such as:

```clojure
(require '[my-app.core :as core])
```

cannot resolve a project-local namespace through this eval contract. Keep code in the cell or use supported JavaScript/package interop. There is no Vite namespace-discovery fallback.

## Development

```sh
bun install
omp plugin link .
bun run check
bun test
```

Run the deterministic guidance suite with an explicit model (the environment variable is equivalent):

```sh
bun run eval:guidance --model provider/model \
  --baseline evals/baseline-v0.1.1.json \
  --output evals/results/candidate-v0.1.2.json

CLJS_CODEMODE_EVAL_MODEL=provider/model bun run eval:guidance
```

The runner prints per-case grades and baseline deltas. Every case has its own wall-clock limit, runs with `--no-session` in a disposable fixture directory, and loads this checkout explicitly with only top-level `eval`. Optional result files contain only sanitized eval arguments/results, final response text, process status, timing, and deterministic grades; reasoning, encrypted provider content, raw JSONL, and stderr are not retained. `evals/results/` is ignored by Git.

## Update and rollback

There is no separate Git-plugin update command. Re-run install with the new immutable tag:

```sh
omp plugin install 'git+ssh://git@github.com/ericjuta/omp-cljs-codemode.git#vX.Y.Z'
```

To roll back across the v0.1.2 package-scope cutover, install v0.1.1 under its historical scope first. Disable and uninstall the current package only after that install succeeds:

```sh
omp plugin install 'git+ssh://git@github.com/ericjuta/omp-cljs-codemode.git#v0.1.1' && \
  omp plugin disable @ericjuta/omp-cljs-codemode && \
  omp plugin uninstall @ericjuta/omp-cljs-codemode && \
  omp plugin enable @t-y-b-b/omp-cljs-codemode
```

As with the upgrade, this target-first, success-gated order preserves the currently working package if the target install fails. For an already-installed bad release, the explicit old-tag install above is the rollback; use `omp plugin disable @ericjuta/omp-cljs-codemode` as the immediate kill switch.
