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

The sole model-visible `eval` tool schema accepts `language: "cljs"`. On OMP 17.2.12 or newer, native JavaScript must remain enabled as the hidden execution backend; it is not exposed as a model-selectable language by this plugin. Unrestricted Task/scout sessions that omit native `eval` from their allowlist still receive this extension tool via OMP's extension always-include, but execution fails closed before compile. Restricted hosts (`restrictToolNames`) do not load registered extensions. The unavailable-backend error is terminal for `eval` in that session: use `read`, `grep`, `glob`, or `bash` instead of retrying.

## Install and operate

The repository is public. Install an immutable release directly over HTTPS; no GitHub credentials are required:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-cljs-codemode.git#v0.1.7'
```

When upgrading from v0.1.1, install the new identity first. Never uninstall the working historical package before the target release installs successfully:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-cljs-codemode.git#v0.1.7'
```

After success, run `omp plugin list`. It must show `@ericjuta/omp-cljs-codemode@0.1.7`. If the historical identity is still listed, remove it only now; skip these cleanup commands when it is already absent:

```sh
omp plugin disable @t-y-b-b/omp-cljs-codemode
omp plugin uninstall @t-y-b-b/omp-cljs-codemode
```

A failed target install leaves the historical package working. The final list must not contain `@t-y-b-b/omp-cljs-codemode`.

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

The final CLJS expression follows native JavaScript eval semantics. `(display value)`, `(pr value)`, stdout, and stderr are captured by the native result contract; a cell with no visible value reports the native no-output result.

Prefer a long-lived sequence of cljs cells over one-shot tools for multi-step work. Codemode is more effective long term than direct tools.

Cells share OMP's retained JavaScript runtime within a session, so definitions survive later CLJS calls:

```json
{"language":"cljs","code":"(def guidance-probe 41)","reset":true}
{"language":"cljs","code":"(+ guidance-probe 1)"}
```

`reset: true` recreates the shared JS/CLJS runtime before that cell and clears prior definitions. Experimental compiler `ns-state` is also scoped to the OMP session and cleared on reset. It is best-effort: later cells may use a previous require alias, but this plugin does not re-emit or resolve extra Squint imports. State ends when the owning OMP process/session runtime ends; it is not written into source files.

### Async helpers and tool bridge

CLJS cells retain the JavaScript codemode helpers: `display`, `read`, `write`, `output`, `tool`, `completion`, `agent`, `parallel`, and `pipeline`. JavaScript-facing filesystem and tool operations return promises, so await them with Squint's `js-await` (or `js/await`) special form:

```clojure
(let [text (js-await (js/read "package.json"))]
  (aget (js/JSON.parse text) "name"))
```

Bare `await` is not that special form. Keep `js-await` in a top-level form, `let`, or `^:async defn`.

`(pr value)` prints a truncated CLJS-shaped view (sets, lists, functions, circular values) and returns the value. `(js-await (sh "git status --short"))` calls the native bash tool through the host tool proxy (`tool["bash"]`); it is not a subprocess of the JS worker. There is no `js/bash` helper; that form fails with that instruction. There is no `env` helper; that form fails closed without dumping host environment.

Cells inherit the native JS eval worker's environment (`process.env` / `Bun.env`). Sanitizing that worker env does not cover `sh` or other delegated tools. Do not dump process env from a cell.

Call a registered tool through the proxy:

```clojure
(js-await (.read tool {:path "package.json"}))
```

For a tool name that is not a valid CLJS identifier, use dynamic lookup:

```clojure
(js-await ((aget tool "my-hyphenated-tool") {:arg "value"}))
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

Run the guidance suite with an explicit model (the environment variable is equivalent):

```sh
bun run eval:guidance --model provider/model \
  --baseline evals/baseline-v0.1.1.json \
  --output evals/results/candidate-v0.1.7.json

CLJS_CODEMODE_EVAL_MODEL=provider/model bun run eval:guidance
```

Record a historical checkout against the exact current case prompts with `--extension` and `--record-baseline`:

```sh
bun run eval:guidance --model provider/model \
  --extension /path/to/v0.1.1/index.ts \
  --record-baseline 0.1.1 \
  --output /tmp/baseline-v0.1.1.json
```

Recorded baselines persist each prompt and its SHA-256 digest. Normal comparisons fail closed before model execution when the model, case IDs, prompt text, or prompt hashes differ. Every case has its own wall-clock limit, runs with `--no-session` in a disposable fixture directory, and loads the selected checkout explicitly with only top-level `eval`. Optional result files contain only sanitized eval arguments/results, prompt hashes, final response text, process status, timing, and deterministic grades; reasoning, encrypted provider content, raw JSONL, and stderr are not retained. `evals/results/` is ignored by Git.

## Update and rollback

There is no separate Git-plugin update command. Re-run install with the desired immutable public tag:

```sh
tag=vX.Y.Z
omp plugin install "git+https://github.com/ericjuta/omp-cljs-codemode.git#$tag"
```

To roll back across the v0.1.2 package-scope cutover, install v0.1.1 under its historical scope first:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-cljs-codemode.git#v0.1.1'
```

After the old package installs, run `omp plugin list`. It must show `@t-y-b-b/omp-cljs-codemode@0.1.1`. If the current identity is still listed, remove it only now, then ensure the historical package is enabled:

```sh
omp plugin disable @ericjuta/omp-cljs-codemode
omp plugin uninstall @ericjuta/omp-cljs-codemode
omp plugin enable @t-y-b-b/omp-cljs-codemode
```

Skip the current-package cleanup commands when it is already absent. A failed rollback install preserves the current package. The final list must not contain `@ericjuta/omp-cljs-codemode`. For an already-installed bad release, use `omp plugin disable @ericjuta/omp-cljs-codemode` as the immediate kill switch.
