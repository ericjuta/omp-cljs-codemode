---
name: omp-cljs-codemode-operate
description: Prove omp-cljs-codemode live identity vs checkout, reinstall a tagged release, or diagnose missing native eval backend. Use when wrapping a release, live eval disagrees with checkout, or a cell says CLJS eval is unavailable. Do not use this skill to choose cljs over read, grep, lsp, or bash.
---

# omp-cljs-codemode operate

Use after a cljs plugin change, release wrap, when live `eval language: cljs` disagrees with checkout, or when a cell says CLJS eval is unavailable.

## Identities

Three things are not the same:

1. Checkout (`package.json` + `index.ts` in the repo)
2. Installed pin (`~/.omp/plugins/package.json`, `omp-plugins.lock.json`, `omp plugin list`)
3. This OMP process (keeps the previous extension until a **new** process)

Checkout tests and `bun run check` are not live proof.

Current public install:

```sh
omp plugin install 'git+https://github.com/ericjuta/omp-cljs-codemode.git#v0.1.13'
```

`omp plugin list` must show `@ericjuta/omp-cljs-codemode@0.1.13`. Then start a new OMP process.

## Wrapper contract

`@ericjuta/omp-cljs-codemode` is a native-`eval` wrapper. It compiles Squint, then delegates with `ctx.invokeTool({ ...params, language: "js", code })`. OMP attaches `invokeTool` only when a same-name native built-in exists.

Do **not**:

- execute compiled JS inside the plugin
- polyfill `display`/`read`/`tool` locally beyond the tiny `pr`/`sh`/`bash` prelude injected into compiled JS
- seed native `eval` into scout or other explicit read-only allowlists
- regex-rewrite CLJS source or `import.meta.resolve` non-core Squint imports
- rewrite model guidance to sell utility

Scout allows only `read, grep, glob, web_search`. On unrestricted sessions the SDK still auto-includes extension tools, so cljs `eval` can appear without a JS backend. Restricted hosts (`restrictToolNames`) do not load registered extensions.

First-cell `reset: true` remains valid for persistence setup. Experimental compiler `ns-state` is scoped to the OMP session. Commit it only after a successful native result (`details.isError` is not true). A failed `reset: true` still deletes prior compiler state because native reset already ran.

## Diagnose unavailable backend

1. Parent/main session: a bare `(+ 1 2)` cell should return `3`.
2. Unrestricted Task/scout without native `eval`: the same call should fail closed **before** compile. Invalid source such as `(` must produce the unavailable-backend error, not a Squint reader error.
3. If the message says the native backend is unavailable, stop. Use `read`, `grep`, `glob`, or `bash`. Do not retry `eval`.

Current fail-closed text starts with `CLJS eval is unavailable` and tells the model not to retry.

## Do not

- Claim live 0.1.N from checkout tests or by reading installed source only
- Use `--no-extensions -e "$PWD/index.ts"` when the ask is ambient installed-plugin proof
- Invent `:` on Squint keywords; they compile to strings
- Treat native JSON `display[1]` / `[object Object]` as a printer failure (`pr` returns the value)
- Use this skill to choose cljs over `read`, `grep`, `lsp`, or `bash`

## Fresh ambient smoke

After install, launch a **new** process with ambient extensions (no `--no-extensions`, no `-e`):

```sh
omp --no-session --mode json --auto-approve --tools eval --model "$CLJS_CODEMODE_EVAL_MODEL" --thinking off --max-time 120 \
  'Use eval language cljs. Print (list)/(list 1 2 3), (atom {:n 1}), (ex-info "boom" {:k 1}) and (js/Error. "boom"), and a depth-5 map. Quote completed eval texts only.'
```

Quote completed `eval` tool texts, not the child model's summary.

Expected printer lines on 0.1.13:

- `() (1 2 3) [] [1 2 3] (1 2)`
- `#atom {:n 1}`
- `#error {:message "boom" :data {:k 1}}`
- `#error {:message "boom"}`
- `{:a {:b {:c {:d ...}}}}`

## Helpers and compiler diagnostics

- Prefer `js-await` (or `js/await`). Bare `await` compiles as a function call.
- `(pr value)` and `(js-await (sh "cmd"))` are injected JS helpers. `(js/bash ...)` throws: there is no `js/bash` helper.
- `js-await` inside a sync `defn` fails at compile time: use top-level/`let`/`^:async defn`. Nested `^:async fn` is allowed.
- Unmatched `(` / `[` / `{` / `"` become one-line `CLJS reader error` sentences. `defn` without a name or params, odd maps, and non-sequential `let`/`require` specs become `CLJS compile error` sentences.

## Common live mistakes (parent sessions)

These compile or run and are separate from missing delegation:

- `(js/bash ...)` → injected helper error. Use `(js-await (sh ...))` or native `bash`.
- `(defn ... (js/await ...))` without `^:async` → compile diagnostic.
- `(def answer ...)` with no final expression → native `(no output)`. Add a final value, `(display ...)`, or `(pr ...)`.
- Using eval to probe cwd, `js/Object.keys tool`, or `xd://report_issue`. Use `read`, `write`, or the named tool instead.

## Release gate

Match prior cuts: one `release public CLJS codemode vX.Y.Z` commit, annotated tag, signed Eric identity. Run `bun test` and `bun run check` before tag. If check fails after a tag, cut a new tag; do not move the old one.

## Proof

`bun test` in the plugin repo covers the missing-`invokeTool` path, prelude helpers, diagnostics, and `applyCompilerStateResult` keep/delete/store. The installed plugin is a separate identity; `omp plugin link .` or reinstall is required before a live session sees checkout changes.
