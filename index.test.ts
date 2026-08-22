import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import {
	AWAIT_IN_SYNC_DEFN_MESSAGE,
	compileCljs,
	createCljsEvalTool,
	ENV_HELPER_MESSAGE,
	MISSING_BASH_MESSAGE,
	MISSING_NATIVE_EVAL_MESSAGE,
} from "./index.js";

const fakePi = {
	typebox: { Type },
	registerTool: () => {},
};

type InvokeOptions = {
	signal?: AbortSignal;
	onUpdate?: (update: unknown) => void;
};

type InvokeTool = (params: Record<string, unknown>, options?: InvokeOptions) => Promise<unknown>;

type EvalExecute = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: ((update: unknown) => void) | undefined,
	ctx: { invokeTool: InvokeTool },
) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...args: never[]) => Promise<unknown>;

async function evaluateCljsCell(source: string, tool: Record<string, unknown> = {}): Promise<unknown> {
	const code = compileCljs(source).replace(/^import .+;\n/gm, "");
	const squintCore = (await import("squint-cljs/core.js")) as Record<string, unknown>;
	return await new AsyncFunction("tool", "squint_core", code)(tool as never, squintCore as never);
}

async function executeWith(
	tool: Record<string, unknown>,
	params: Record<string, unknown>,
	invokeTool: InvokeTool,
	signal?: AbortSignal,
	onUpdate?: (update: unknown) => void,
): Promise<unknown> {
	const execute = tool.execute as EvalExecute;
	return execute("test-call", params, signal, onUpdate, { invokeTool });
}

async function executeDelegated(
	tool: Record<string, unknown>,
	params: Record<string, unknown>,
	signal?: AbortSignal,
	onUpdate?: (update: unknown) => void,
) {
	const calls: Array<Record<string, unknown>> = [];
	const invokeTool: InvokeTool = async (nextParams, _options) => {
		calls.push(nextParams);
		return { content: [{ type: "text", text: "delegated" }], details: { delegated: true } };
	};
	const result = await executeWith(tool, params, invokeTool, signal, onUpdate);
	return { calls, result };
}

describe("CLJS codemode plugin", () => {
	it("compiles an expression for the native eval backend", async () => {
		const value = await evaluateCljsCell("(def result (+ 1 2))\nresult");
		expect(value).toBe(3);
	});

	it("keeps a definition-only cell silent", async () => {
		expect(await evaluateCljsCell("(def silent-result 3)")).toBeUndefined();
	});

	it("rewrites Squint's core import to the pinned runtime", () => {
		const code = compileCljs("(+ 1 2)");
		expect(code).toContain(`from ${JSON.stringify(import.meta.resolve("squint-cljs/core.js"))}`);
		expect(code).not.toContain("from 'squint-cljs/core.js'");
	});

	it("preserves the native eval tool contract metadata and timeout schema", () => {
		const tool = createCljsEvalTool(fakePi);
		const parameters = tool.parameters as { properties: Record<string, unknown> };
		expect(tool.name).toBe("eval");
		expect(tool.loadMode).toBe("essential");
		expect(tool.strict).toBe(true);
		expect(tool.concurrency).toBe("exclusive");
		expect(parameters.properties.timeout).toBeDefined();
	});

	it("fails Code Mode transport closed until the host supplies the bridge", () => {
		const tool = createCljsEvalTool(fakePi);
		expect(tool.codeModeActivation).toBe("all-models");
		expect((tool.supportsCodeModeTransport as () => boolean)()).toBe(false);
	});

	it("activates Code Mode only after the host supplies the live bridge", () => {
		const tool = createCljsEvalTool(fakePi);
		expect((tool.supportsCodeModeTransport as () => boolean)()).toBe(false);

		(tool.setCodeModeBridge as (bridge: { getDeclarations(): string | undefined }) => void)({
			getDeclarations: () => "  read(args: { path: string }): Promise<unknown>;",
		});
		expect((tool.supportsCodeModeTransport as () => boolean)()).toBe(true);
	});

	it("renders live hidden-tool declarations only while Code Mode is active", () => {
		let declarations: string | undefined;
		const tool = createCljsEvalTool(fakePi);
		(tool.setCodeModeBridge as (bridge: { getDeclarations(): string | undefined }) => void)({
			getDeclarations: () => declarations,
		});
		const directDescription = String(tool.description);
		expect(directDescription).not.toContain("Live bridged tool declarations");

		declarations = [
			"  read(args: { path: string }): Promise<unknown>;",
			"  edit(args: { path: string; oldText: string; newText: string }): Promise<unknown>;",
		].join("\n");
		const codeModeDescription = String(tool.description);
		expect(codeModeDescription).toContain("Code Mode is active");
		expect(codeModeDescription).toContain(declarations);
		expect(codeModeDescription).toContain('(js-await ((aget tool "read") (clj->js {:path "package.json"})))');
		expect(codeModeDescription).toContain("Promise.all returns a JavaScript array");
		expect(codeModeDescription).toContain("vec, aget, or (range (.-length results))");
		expect(codeModeDescription).toContain("Do not use array-seq");
		expect(codeModeDescription).toContain("does not expand ~");
		expect(codeModeDescription).toContain("cannot read directories");
	});

	it("compiles and executes nested async CLJS expressions", async () => {
		const value = await evaluateCljsCell(
			"(def result (let [value (js/await (js/Promise.resolve 7))] value))\nresult",
		);
		expect(value).toBe(7);
	});

	it("handles bridged Promise.all results with vec, aget, and indexed range access", async () => {
		const tool = {
			read: async (args: { path: string }) => ({ path: args.path }),
		};
		const value = await evaluateCljsCell(
			`(let [results (js-await (js/Promise.all #js [
  ((aget tool "read") (clj->js {:path "a.txt"}))
  ((aget tool "read") (clj->js {:path "b.txt"}))]))]
  [(mapv #(aget % "path") (vec results))
   (aget (aget results 0) "path")
   (mapv (fn [i] (aget (aget results i) "path"))
         (range (.-length results)))])`,
			tool,
		);
		expect(value).toEqual([["a.txt", "b.txt"], "a.txt", ["a.txt", "b.txt"]]);
	});

	it("returns the effective final top-level form", async () => {
		const value = await evaluateCljsCell('(js/await (js/Promise.resolve 1))\n; preserve this boundary comment\n"done"');
		expect(value).toBe("done");
	});

	it("keeps metadata attached to its top-level definition", async () => {
		const value = await evaluateCljsCell("^:private\n(def result 9)\nresult");
		expect(value).toBe(9);
	});

	it("preserves Squint reader semantics for discarded and character forms", async () => {
		expect(await evaluateCljsCell("42 #_ 99")).toBe(42);
		expect(await evaluateCljsCell("\\, 7")).toBe(7);
		expect(await evaluateCljsCell("42 #?(:cljs 7 :clj 8)")).toBe(7);
	});

	it("reports unmatched parentheses as a reader error", () => {
		expect(() => compileCljs("(")).toThrow(/CLJS reader error.*unmatched parentheses/);
	});

	it("rewrites common Squint reader and compile errors", () => {
		expect(() => compileCljs(")")).toThrow(/Remove the extra closer/);
		expect(() => compileCljs("[")).toThrow(/unmatched brackets/);
		expect(() => compileCljs("{")).toThrow(/unmatched braces/);
		expect(() => compileCljs('"hello')).toThrow(/Close the string/);
		expect(() => compileCljs("'")).toThrow(/form is incomplete/);
		expect(() => compileCljs("{:a}")).toThrow(/key\/value pairs/);
		expect(() => compileCljs("(defn)")).toThrow(/defn needs a name symbol/);
		expect(() => compileCljs("(defn foo)")).toThrow(/parameter vector/);
		expect(() => compileCljs("(let x 1)")).toThrow(/vector or sequential form/);
		expect(() => compileCljs("#?")).toThrow(/keyword feature/);
	});



	it("exposes only the strict CLJS language schema", () => {
		const tool = createCljsEvalTool(fakePi);
		const language = (tool.parameters as { properties: Record<string, unknown> }).properties.language as Record<string, unknown>;
		expect(language).toMatchObject({ const: "cljs" });
		expect(language).not.toHaveProperty("anyOf");
		expect(language).not.toHaveProperty("enum");
		const schema = JSON.stringify(language);
		for (const nativeLanguage of ["py", "js", "rb", "jl"]) {
			expect(schema).not.toContain(`\"const\":\"${nativeLanguage}\"`);
		}
	});
	it("rejects non-CLJS calls before delegation", async () => {
		const tool = createCljsEvalTool(fakePi);
		const calls: Array<Record<string, unknown>> = [];
		const invokeTool: InvokeTool = async params => {
			calls.push(params);
			return { content: [] };
		};
		await expect(executeWith(tool, { language: "js", code: "1 + 2" }, invokeTool)).rejects.toThrow(
			'CLJS eval only supports language "cljs"',
		);
		expect(calls).toHaveLength(0);
	});

	it("fails closed when native eval delegation is unavailable", async () => {
		const tool = createCljsEvalTool(fakePi);
		const execute = tool.execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: Record<string, never>,
		) => Promise<unknown>;
		await expect(execute("missing-delegation", { language: "cljs", code: "(+ 1 2)" }, undefined, undefined, {})).rejects.toThrow(
			MISSING_NATIVE_EVAL_MESSAGE,
		);
	});

	it("does not compile when native eval delegation is unavailable", async () => {
		const tool = createCljsEvalTool(fakePi);
		const execute = tool.execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: Record<string, never>,
		) => Promise<unknown>;
		await expect(execute("do-not-compile", { language: "cljs", code: "(" }, undefined, undefined, {})).rejects.toThrow(
			MISSING_NATIVE_EVAL_MESSAGE,
		);
	});

	it("delegates CLJS as JavaScript while retaining timeout and call metadata", async () => {
		const tool = createCljsEvalTool(fakePi);
		const { calls, result } = await executeDelegated(tool, {
			language: "cljs",
			code: '(js/await (.read tool {:path "package.json"}))',
			title: "read package",
			timeout: 10,
			reset: true,
		});
		const delegated = calls[0];
		expect(delegated.language).toBe("js");
		expect(delegated.title).toBe("read package");
		expect(delegated.timeout).toBe(10);
		expect(delegated.reset).toBe(true);
		expect(delegated.code).toContain("await tool.read");
		expect(result).toEqual({ content: [{ type: "text", text: "delegated" }], details: { delegated: true } });
	});

	it("preserves a core import string inside user code", async () => {
		const tool = createCljsEvalTool(fakePi);
		const { calls } = await executeDelegated(tool, {
			language: "cljs",
			code: '"from \'squint-cljs/core.js\'"',
		});
		expect(String(calls[0].code)).toContain('"from \'squint-cljs/core.js\'"');
	});

	it("forwards abort and progress channels to CLJS eval", async () => {
		const tool = createCljsEvalTool(fakePi);
		const seen: InvokeOptions[] = [];
		const signal = new AbortController().signal;
		const onUpdate = (_update: unknown) => {};
		const invokeTool: InvokeTool = async (_params, options) => {
			seen.push(options ?? {});
			return { content: [] };
		};
		await executeWith(tool, { language: "cljs", code: "(+ 1 2)" }, invokeTool, signal, onUpdate);
		expect(seen).toHaveLength(1);
		expect(seen[0].signal).toBe(signal);
		expect(seen[0].onUpdate).toBe(onUpdate);
	});

	it("keeps model-visible CLJS boundaries and canonical examples in sync", () => {
		const description = String(createCljsEvalTool(fakePi).description);
		const examples = [
			"(+ 1 2)",
			"(def result (+ 1 2))\n(display result)",
			"(js-await (js/Promise.resolve 3))",
			'(js-await (sh "git status --short"))',
			"(pr (atom {:n 1}))",
		] as const;
		expect(description).toContain("<examples>");
		expect(description).toContain("</examples>");
		for (const code of examples) {
			expect(description).toContain(`code=${code.includes("\n") ? `\"\"\"${code}\"\"\"` : JSON.stringify(code)}`);
			expect(() => compileCljs(code)).not.toThrow();
		}
		expect(description).toContain("Use cljs for retained cells, in-cell transforms, and JavaScript interop.");
		expect(description).toContain("Use host read, grep, and bash directly when they are exposed");
		expect(description).toContain("If a direct tool returns empty or fails");
		expect(description).toContain("a cljs cell with JavaScript interop is a fallback");
		expect(description).not.toContain("child_process");
		expect(description).toContain("direct Squint");
		expect(description).toContain("Vite");
		expect(description).toContain("final expression or display");
		expect(description).toContain("def alone has no visible output");
		expect(description).toContain("Project-local CLJS require and path resolution are unavailable");
		expect(description).toContain("Session :as aliases from a prior cell may persist until reset: true");
		expect(description).toContain("js-await");
		expect(description).toContain("^:async defn");
		expect(description).toContain("(pr (atom {:n 1}))");
		expect(description).toContain("display(...) uses the native formatter while pr(...) renders CLJS shapes; reach for pr(...) when CLJS-shaped output matters.");
		expect(description).toContain("Squint has no js->clj; clj->js works. Shape JavaScript values into CLJS with vec, aget, and js-keys.");
		expect(description).not.toContain("Codemode is more effective long term than direct tools");
		expect(description).not.toContain("Prefer long-lived cljs cells");
		expect(description).not.toContain('Prefer (js-await (js/read "package.json"))');
		expect(description).not.toContain('(js/read "package.json")');
		expect(description).toContain("(js-await (js/Promise.resolve 3))");
		expect(description).toContain('(js-await ((aget tool "tool-name") (clj->js {:arg "value"})))');
		expect(description).toContain("There is no js/bash helper");
		expect(description).toContain("Multiple top-level forms execute in order");
		expect(description).toContain("output(...)");
		expect(description).toContain("this tool cannot create one");
		expect(description).toContain("Do not retry eval");
		expect(description).toContain("Do not retry eval. Use an available direct tool such as read, grep, or glob instead.");
		expect(description).toContain("Do not use eval to discover cwd");
		expect(description).toContain("xd://report_issue");
		expect(description).toContain("Prefer str/replace after :as str");
		expect(description).not.toContain("Experimental compiler ns-state");
		expect(description).toContain('host bash tool via tool["bash"]');
		expect(description).toContain('sh calls tool["bash"] only when bash is exposed and fails closed otherwise');
		expect(description).toContain("truncated CLJS-shaped view");
		expect(description).toContain("There is no env helper");
		expect(description).toContain("eval-local read(path, offset?, limit?) helper reads regular files only");
		expect(description).toContain("It does not expand ~ and does not support directory reads");
		expect(description).toContain("Do not expose host environment from a cell");
		expect(description).not.toContain("write(), env(), output()");
		expect(description).not.toContain("process.env");
		expect(description).not.toContain("Bun.env");
		expect(description).not.toContain('(js-await (sh "git status --short"))');
	});

	it("injects pr, sh, and a bash diagnostic helper", async () => {
		const displayed: unknown[] = [];
		const bashCalls: unknown[] = [];
		const squintCore = { pr_str: (value: unknown) => JSON.stringify(value) };
		const run = new AsyncFunction(
			"squint_core",
			"display",
			"tool",
			compileCljs("(pr {:a 1})").replace(/^import .+;\n/gm, ""),
		) as (
			squintCore: { pr_str: (value: unknown) => string },
			display: (value: unknown) => void,
			tool: { bash: (args: unknown) => Promise<string> },
		) => Promise<unknown>;
		const value = await run(
			squintCore,
			next => {
				displayed.push(next);
			},
			{
				bash: async args => {
					bashCalls.push(args);
					return "ok";
				},
			},
		);
		expect(value).toEqual({ a: 1 });
		expect(displayed).toEqual(["{:a 1}"]);
		const runSh = new AsyncFunction(
			"squint_core",
			"display",
			"tool",
			compileCljs('(js-await (sh "git status --short"))').replace(/^import .+;\n/gm, ""),
		) as (
			squintCore: { pr_str: (value: unknown) => string },
			display: (value: unknown) => void,
			tool: { bash: (args: unknown) => Promise<string> },
		) => Promise<unknown>;
		await expect(
			runSh(squintCore, () => {}, {
				bash: async args => {
					bashCalls.push(args);
					return "ok";
				},
			}),
		).resolves.toBe("ok");
		expect(bashCalls).toEqual([{ command: "git status --short" }]);
		await expect(evaluateCljsCell('(js-await (sh "true"))', {})).rejects.toThrow(MISSING_BASH_MESSAGE);
		await expect(
			evaluateCljsCell('(js-await (sh "true"))', {
				bash: async () => {
					throw new Error("Unknown tool from js runtime: bash");
				},
			}),
		).rejects.toThrow(MISSING_BASH_MESSAGE);
		const runBash = new AsyncFunction(
			compileCljs('(js/bash {:command "true"})').replace(/^import .+;\n/gm, ""),
		) as () => Promise<unknown>;
		await expect(runBash()).rejects.toThrow("There is no js/bash helper");
		const runEnv = new AsyncFunction(
			compileCljs("(js/env)").replace(/^import .+;\n/gm, ""),
		) as () => Promise<unknown>;
		await expect(runEnv()).rejects.toThrow(ENV_HELPER_MESSAGE);
	});

	it("prints truncated CLJS-shaped values from pr", async () => {
		const displayed: unknown[] = [];
		const run = new AsyncFunction(
			"display",
			compileCljs("(pr {:a 1} #{1 2} (fn [] 1) [0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31 32])").replace(/^import .+;\n/gm, ""),
		) as (display: (value: unknown) => void) => Promise<unknown>;
		await run(next => {
			displayed.push(next);
		});
		expect(displayed).toHaveLength(1);
		const text = String(displayed[0]);
		expect(text).toContain("{:a 1}");
		expect(text).toMatch(/#\{[12] [12]\}/);
		expect(text).toContain("#function");
		expect(text).toContain(" ...]");
		expect(text).not.toContain(" 32]");
	});

	it("truncates nested objects at CLJS_PRINT_DEPTH", async () => {
		const displayed: unknown[] = [];
		const run = new AsyncFunction(
			"display",
			compileCljs("(pr {:a {:b {:c {:d {:e 1}}}}})").replace(/^import .+;\n/gm, ""),
		) as (display: (value: unknown) => void) => Promise<unknown>;
		await run(next => {
			displayed.push(next);
		});
		expect(displayed).toEqual(["{:a {:b {:c {:d ...}}}}"]);
	});

	it("prints lists with parens and does not call Squint List.map", async () => {
		const displayed: unknown[] = [];
		const run = new AsyncFunction(
			"squint_core",
			"display",
			compileCljs("(pr (list) (list 1 2 3) [] [1 2 3] (cons 1 (list 2)))").replace(/^import .+;\n/gm, ""),
		) as (
			squintCore: Record<string, unknown>,
			display: (value: unknown) => void,
		) => Promise<unknown>;
		const squintCore = (await import("squint-cljs/core.js")) as Record<string, unknown>;
		await run(squintCore, next => {
			displayed.push(next);
		});
		expect(displayed).toEqual(["() (1 2 3) [] [1 2 3] (1 2)"]);
	});

	it("prints a bounded prefix of an infinite LazySeq without Array.from", async () => {
		const displayed: unknown[] = [];
		const originalFrom = Array.from;
		const unbounded: string[] = [];
		Array.from = ((value: unknown, ...rest: unknown[]) => {
			const ctor = value && typeof value === "object" ? (value as { constructor?: { name?: string } }).constructor?.name : undefined;
			if (ctor === "LazySeq" || ctor === "Cons" || ctor === "LazyIterable") {
				unbounded.push(String(ctor));
				throw new Error(`unbounded Array.from on ${ctor}`);
			}
			return originalFrom.apply(Array, [value, ...rest] as Parameters<typeof Array.from>);
		}) as typeof Array.from;
		try {
			const run = new AsyncFunction(
				"squint_core",
				"display",
				compileCljs("(pr (iterate inc 0))").replace(/^import .+;\n/gm, ""),
			) as (
				squintCore: Record<string, unknown>,
				display: (value: unknown) => void,
			) => Promise<unknown>;
			const squintCore = (await import("squint-cljs/core.js")) as Record<string, unknown>;
			await Promise.race([
				run(squintCore, next => {
					displayed.push(next);
				}),
				new Promise((_, reject) => {
					setTimeout(() => reject(new Error("infinite LazySeq print timed out")), 1000);
				}),
			]);
		} finally {
			Array.from = originalFrom;
		}
		expect(unbounded).toEqual([]);
		expect(displayed).toHaveLength(1);
		const text = String(displayed[0]);
		expect(text.startsWith("(0 1 2 ")).toBe(true);
		expect(text).toContain(" ...");
		expect(text).not.toContain(" 32)");
	});

	it("prints atoms reduced errors dates maps and bytes without leaking internals", async () => {
		const displayed: unknown[] = [];
		const run = new AsyncFunction(
			"squint_core",
			"display",
			compileCljs("(pr (atom {:n 1}) (reduced 3) (js/Date. 0) (js/Map. #js [#js [\"a\" 1]]) (js/Uint8Array. #js [1 2 3]))").replace(/^import .+;\n/gm, ""),
		) as (
			squintCore: Record<string, unknown>,
			display: (value: unknown) => void,
		) => Promise<unknown>;
		const squintCore = (await import("squint-cljs/core.js")) as Record<string, unknown>;
		await run(squintCore, next => {
			displayed.push(next);
		});
		expect(displayed).toHaveLength(1);
		const text = String(displayed[0]);
		expect(text).toContain("#atom {:n 1}");
		expect(text).not.toContain("_watches");
		expect(text).not.toContain("_reset_BANG_");
		expect(text).toContain("#reduced 3");
		expect(text).toContain('#inst "1970-01-01T00:00:00.000Z"');
		expect(text).toContain('#js/Map {"a" 1}');
		expect(text).toContain("#Uint8Array [1 2 3]");
	});

	it("prints ExceptionInfo and Error as keyed #error maps", async () => {
		const displayed: unknown[] = [];
		const run = new AsyncFunction(
			"squint_core",
			"display",
			compileCljs("(pr (ex-info \"boom\" {:k 1}))\n(pr (js/Error. \"boom\"))").replace(/^import .+;\n/gm, ""),
		) as (
			squintCore: Record<string, unknown>,
			display: (value: unknown) => void,
		) => Promise<unknown>;
		const squintCore = (await import("squint-cljs/core.js")) as Record<string, unknown>;
		await run(squintCore, next => {
			displayed.push(next);
		});
		expect(displayed).toEqual([
			'#error {:message "boom" :data {:k 1}}',
			'#error {:message "boom"}',
		]);
	});

	it("prints Squint keywords as strings because they compile to strings", async () => {
		const displayed: unknown[] = [];
		const run = new AsyncFunction(
			"squint_core",
			"display",
			compileCljs("(pr :hello/world #{:a :b} [:a :b] (list :a))").replace(/^import .+;\n/gm, ""),
		) as (
			squintCore: Record<string, unknown>,
			display: (value: unknown) => void,
		) => Promise<unknown>;
		const squintCore = (await import("squint-cljs/core.js")) as Record<string, unknown>;
		await run(squintCore, next => {
			displayed.push(next);
		});
		expect(displayed).toEqual(['"hello/world" #{"a" "b"} ["a" "b"] ("a")']);
	});

	it("compiles js-await as the JavaScript await operator", () => {
		const code = compileCljs("(js-await 1)");
		expect(code).toContain("return (await 1)");
		expect(code).not.toContain("await(1)");
	});

	it("rejects await inside a sync defn before delegation", () => {
		expect(() => compileCljs("(defn sneak [path] (js/await (js/read path)))")).toThrow(AWAIT_IN_SYNC_DEFN_MESSAGE);
		expect(() => compileCljs("(defn ^:async sneak [path] (js/await (js/read path)))\n(sneak \"x\")")).not.toThrow();
	});

	it("allows top-level js-await after a sync defn", () => {
		const code = compileCljs("(defn f [] 1)\n(js-await (js/Promise.resolve 2))");
		expect(code).toContain("return (await Promise.resolve(2))");
	});

	it("allows js-await inside a nested async fn of a sync defn", () => {
		const code = compileCljs("(defn outer [] ((^:async fn [] (js-await 1))))");
		expect(code).toContain("async function");
		expect(code).toContain("return (await 1)");
	});

	it("rejects js-await inside a nested sync fn", () => {
		expect(() => compileCljs("(defn ^:async outer [] ((fn [] (js-await 1))))")).toThrow(AWAIT_IN_SYNC_DEFN_MESSAGE);
	});

	it("compiles str/replace without compiler ns-state", () => {
		const code = compileCljs('(str/replace "aa" "a" "b")');
		expect(code).toContain("str.replace");
		expect(code).not.toContain("squint_core.replace");
	});

	it("resolves clojure.string requires to Squint's bundled module", () => {
		const bare = compileCljs("(require '[clojure.string :as str])");
		expect(bare).toContain("squint-cljs/src/squint/string.js");
		expect(bare).not.toContain("from 'clojure.string'");
		const quoted = compileCljs(`(require '["clojure.string" :as str])`);
		expect(quoted).toContain("squint-cljs/src/squint/string.js");
		expect(quoted).not.toContain("from 'clojure.string'");
		expect(compileCljs(`(require '["clojure.set" :as set])`)).toContain("squint-cljs/src/squint/set.js");
	});

	it("rewrites quoted do-require imports without touching string literals", () => {
		const code = compileCljs(`(do (require '["clojure.string" :as str]) (println "from 'clojure.string'"))`);
		expect(code).toMatch(/import \* as str from "squint-cljs\/src\/squint\/string\.js"/);
		expect(code).not.toMatch(/import \* as str from ['"]clojure\.string['"]/);
		expect(code).toContain(`println("from 'clojure.string'")`);
	});

	it("compiles bare replace to squint_core.replace", () => {
		expect(compileCljs('(replace "aa" "a" "b")')).toContain("squint_core.replace");
	});

	it("rethrows a thrown native reset", async () => {
		const tool = createCljsEvalTool(fakePi);
		const execute = tool.execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: { invokeTool: InvokeTool },
		) => Promise<unknown>;
		const ctx = {
			invokeTool: async () => {
				throw new Error("native eval threw");
			},
		};
		await expect(execute("reset-throw", { language: "cljs", code: "(+ 1 2)", reset: true }, undefined, undefined, ctx)).rejects.toThrow(
			"native eval threw",
		);
	});
});
