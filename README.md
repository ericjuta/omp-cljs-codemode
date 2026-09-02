# OMP CLJS codemode

`@ericjuta/omp-cljs-codemode` adds `language: "cljs"` cells to OMP's native `eval` tool.

## Call flow

The path is direct; Vite is not involved:

```text
model eval call (language: "cljs")
  -> Squint compileStringEx(..., { context: "return", async: true, "elide-exports": true })
  -> rewrite generated Squint package imports to this package's pinned runtime URLs
  -> delegate the generated JavaScript to OMP's native eval tool
  -> return the native eval result
```

The sole model-visible `eval` tool schema accepts `language: "cljs"`. OMP 18.0.0 or newer is required, with native JavaScript enabled as the hidden execution backend; JavaScript is not exposed as a model-selectable language by this plugin. All-model Code Mode additionally requires an OMP host that supplies live hidden-tool declarations to replacement eval tools. On hosts without that bridge contract, the plugin reports Code Mode transport unavailable, so OMP keeps the direct tool surface instead of hiding tools without guidance.

Unrestricted Task/scout sessions that omit native `eval` from their allowlist still receive this extension tool via OMP's extension always-include, but execution fails closed before compile. Restricted hosts (`restrictToolNames`) do not load registered extensions. If eval reports that the native backend is unavailable, stop. Do not retry eval. Use an available direct tool such as read, grep, or glob instead.

## Install and operate

The repository is public. Install the immutable public v0.1.21 release directly over HTTPS; no GitHub credentials are required:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-cljs-codemode.git#v0.1.21'
```

When upgrading from v0.1.1, install the new identity first. Never uninstall the working historical package before the target release installs successfully:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-cljs-codemode.git#v0.1.21'
```

After success, run `omp plugin list`. It must show `@ericjuta/omp-cljs-codemode@0.1.21`. If the historical identity is still listed, remove it only now; skip these cleanup commands when it is already absent:

```sh
omp plugin disable @t-y-b-b/omp-cljs-codemode
omp plugin uninstall @t-y-b-b/omp-cljs-codemode
```

A failed target install leaves the historical package working. The final list must not contain `@t-y-b-b/omp-cljs-codemode`.

The installed package name is `@ericjuta/omp-cljs-codemode`.

This install also ships the packaged `omp-cljs-codemode-operate` skill. OMP discovers it from the enabled plugin, so do not copy `SKILL.md` into a user or project skill directory. Start a new OMP process after installation or enablement so the tool and skill are loaded.

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

Use cljs for retained cells, in-cell transforms, and JavaScript interop. Use host `read`, `grep`, and `bash` directly when they are exposed. In Code Mode, the eval description lists the current hidden tool schemas; invoke those tools through the CLJS `tool` bridge. If a direct tool returns empty or fails, a cljs cell with JavaScript interop is a fallback.

One tool call is one Squint cell:

```json
{
  "language": "cljs",
  "code": "(def answer (* 6 7))\nanswer"
}
```

The final CLJS expression follows native JavaScript eval semantics. `(display value)`, `(pr value)`, stdout, and stderr are captured by the native result contract; a cell with no visible value reports the native no-output result.

Cells share OMP's retained JavaScript runtime within a session, so definitions survive later CLJS calls:

```json
{"language":"cljs","code":"(def guidance-probe 41)","reset":true}
{"language":"cljs","code":"(+ guidance-probe 1)"}
```

`reset: true` recreates the shared JS/CLJS runtime before that cell and clears prior definitions. Session `:as` aliases persist because the JS worker keeps the import binding. Prefer `str/replace` after `:as str`; do not `:refer` `replace` and call it bare. State ends when the owning OMP process/session runtime ends; it is not written into source files.

### Async helpers and tool bridge

CLJS cells retain the JavaScript codemode helpers: `display`, `read`, `write`, `output`, `tool`, `completion`, `agent`, `parallel`, and `pipeline`. JavaScript-facing filesystem and tool operations return promises, so await them with Squint's `js-await` (or `js/await`) special form:

```clojure
(let [text (js-await (js/read "package.json"))]
  (aget (js/JSON.parse text) "name"))
```

Bare `await` is not that special form. Keep `js-await` in a top-level form, `let`, or `^:async defn`.
Squint has no `js->clj`; `clj->js` works. Shape JavaScript values into CLJS with `vec`, `aget`, and `js-keys`.

`(pr value)` prints a bounded CLJS-shaped view (sets, lists, functions, circular values), renders promises opaquely, and returns the original value. `(js-await (sh "git status --short"))` calls the native bash tool through the host tool proxy (`tool["bash"]`); it is not a subprocess of the JS worker. Missing tool bridges fail with the same actionable diagnostic whether `tool` is absent or lacks `bash`. There is no `js/bash` helper; that form fails with that instruction. There is no `env` helper; that form fails closed without dumping host environment.

Cells inherit the native JS eval worker's environment (`process.env` / `Bun.env`). Sanitizing that worker env does not cover `sh` or other delegated tools. Do not dump process env from a cell.

Call a registered tool through the proxy with valid Squint interop syntax:

```clojure
(js-await ((aget tool "read") (clj->js {:path "package.json"})))
```

The same dynamic lookup works for names that are not valid CLJS identifiers:

```clojure
(js-await ((aget tool "my-hyphenated-tool") (clj->js {:arg "value"})))
```

For independent bridged calls, `js/Promise.all` returns a JavaScript array. Use `vec`, `aget`, or an indexed `(range (.-length results))`; `array-seq` is not supported.

Tool bridge calls preserve the native tool's permissions and side effects. The eval-local `(js-await (js/read path))` helper returns raw regular-file text, does not expand `~`, and cannot read directories. Bridged `tool.read` returns the normal OMP tool response shape and follows the live host schema. Neither replaces a directly exposed host `read` tool.

Squint reader and compiler failures are normalized when the upstream message is otherwise opaque. Common diagnostics include unmatched delimiters, malformed `defn`/`fn` forms, odd `cond` forms, and invalid binding vectors.

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
  --baseline evals/baseline-v0.1.17.json \
  --output evals/results/candidate-v0.1.21.json

CLJS_CODEMODE_EVAL_MODEL=provider/model bun run eval:guidance
```

Cases are one of two kinds. A `mechanical` case dictates exact source and pins each call's code, result, and reset; it guards the compile and delegation path. A `naturalistic` case states only a user goal and grades the observed outcome, call-count bounds, tool choice, eval errors, and required or forbidden eval-code patterns; it is what measures whether model-visible guidance actually works. Each case declares either the fallback `direct` surface or the live `code-mode` surface. A case may materialize `fixtureFiles`, assert `expectedFixtureFiles`, and select the deterministic `replace` edit variant without depending on the surrounding repository or operator settings.

Sealed holdouts are skipped by default. Run them deliberately:

```sh
bun run eval:guidance --model provider/model --include-holdouts
```

A recorded baseline pins every case prompt, execution setting, grading rule, holdout flag, and the complete case inventory. The `caseContractSha256` and `suiteContractSha256` digests reject changes before any model runs. A changed expected regex, call-count window, exposed tool, deadline, or case list therefore cannot appear as a behavior regression. Older baselines still load, but the runner warns that it cannot verify grading drift.

Record a baseline for a given checkout against the exact current case prompts with `--extension` and `--record-baseline`, which always includes holdouts:

```sh
bun run eval:guidance --model provider/model \
  --extension /path/to/pristine/index.ts \
  --record-baseline 0.1.17 \
  --output evals/baseline-v0.1.17.json
```

Schema-v4 comparisons reject model, suite contract, prompt, or case contract mismatches before model execution. Schema-v3 baselines retain subset compatibility but print an unverified-grading warning. Every case has its own wall-clock limit, runs with `--no-session` in a disposable fixture directory, and loads only the tools that case exposes. Direct-surface cases load a fixture-hosted adapter from a private temporary directory and import the selected checkout through an `extension-entry.ts` file symlink. Code-mode cases load the checkout entry itself. The runner does not write beside the extension. Optional result files contain only sanitized eval arguments and results, prompt hashes, final response text, process status, timing, and deterministic grades. They never retain reasoning, encrypted provider content, raw JSONL, or stderr. `evals/results/` is ignored by Git.

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
