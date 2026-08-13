import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import { applyCompilerStateResult, AWAIT_IN_SYNC_DEFN_MESSAGE, compileCljs, compileCljsCell, createCljsEvalTool, ENV_HELPER_MESSAGE, MISSING_NATIVE_EVAL_MESSAGE } from "./index.js";

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

async function evaluateCljsCell(source: string): Promise<unknown> {
	const code = compileCljs(source).replace(/^import .+;\n/gm, "");
	return await new AsyncFunction(code)();
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

	it("compiles and executes nested async CLJS expressions", async () => {
		const value = await evaluateCljsCell(
			"(def result (let [value (js/await (js/Promise.resolve 7))] value))\nresult",
		);
		expect(value).toBe(7);
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
			'(js/JSON.parse (js-await (js/read "package.json")))',
			'(js-await (sh "git status --short"))',
		] as const;
		expect(description).toContain("<examples>");
		expect(description).toContain("</examples>");
		for (const code of examples) {
			expect(description).toContain(`code=${code.includes("\n") ? `\"\"\"${code}\"\"\"` : JSON.stringify(code)}`);
			expect(() => compileCljs(code)).not.toThrow();
		}
		expect(description).toContain("direct Squint");
		expect(description).toContain("Vite");
		expect(description).toContain("final expression or display");
		expect(description).toContain("def alone has no visible output");
		expect(description).toContain("Compiler aliases");
		expect(description).toContain("project-local CLJS require resolution");
		expect(description).toContain("js-await");
		expect(description).toContain("^:async defn");
		expect(description).toContain("Codemode is more effective long term than direct tools");
		expect(description).toContain('(js-await (js/read "package.json"))');
		expect(description).toContain('(js-await ((aget tool "tool-name") {:arg "value"}))');
		expect(description).toContain("There is no js/bash helper");
		expect(description).toContain("Multiple top-level forms execute in order");
		expect(description).toContain("output(...)");
		expect(description).toContain("this tool cannot create one");
		expect(description).toContain("Do not retry eval");
		expect(description).toContain("Do not use eval to discover cwd");
		expect(description).toContain("xd://report_issue");
		expect(description).toContain("Experimental compiler ns-state");
		expect(description).toContain('host bash tool via tool["bash"]');
		expect(description).toContain("truncated CLJS-shaped view");
		expect(description).toContain("There is no env helper");
		expect(description).toContain("Do not expose host environment from a cell");
		expect(description).not.toContain("write(), env(), output()");
		expect(description).not.toContain("process.env");
		expect(description).not.toContain("Bun.env");
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

	it("returns experimental ns-state from a require cell", () => {
		const first = compileCljsCell("(require (quote [clojure.string :as str]))");
		expect(first.compilerState).toBeDefined();
		const second = compileCljsCell('(str/upper-case "ab")', { compilerState: first.compilerState });
		expect(second.code).toContain("str.upper_case");
	});

	it("scopes experimental compiler state to a session and clears it on reset", async () => {
		const tool = createCljsEvalTool(fakePi);
		const execute = tool.execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: { invokeTool: InvokeTool; sessionManager: { getSessionId: () => string } },
		) => Promise<unknown>;
		const firstCalls: Array<Record<string, unknown>> = [];
		const secondCalls: Array<Record<string, unknown>> = [];
		const firstCtx = {
			invokeTool: async (params: Record<string, unknown>) => {
				firstCalls.push(params);
				return { content: [] };
			},
			sessionManager: { getSessionId: () => "session-a" },
		};
		const secondCtx = {
			invokeTool: async (params: Record<string, unknown>) => {
				secondCalls.push(params);
				return { content: [] };
			},
			sessionManager: { getSessionId: () => "session-b" },
		};
		await execute("one", { language: "cljs", code: "(require (quote [clojure.string :as str]))" }, undefined, undefined, firstCtx);
		await execute("two", { language: "cljs", code: '(str/upper-case "ab")' }, undefined, undefined, firstCtx);
		await execute("other", { language: "cljs", code: '(str/upper-case "ab")' }, undefined, undefined, secondCtx);
		await execute("reset", { language: "cljs", code: "(+ 1 2)", reset: true }, undefined, undefined, firstCtx);
		expect(firstCalls).toHaveLength(3);
		expect(String(firstCalls[1].code)).toContain("str.upper_case");
		expect(secondCalls).toHaveLength(1);
		expect(String(firstCalls[2].code)).toContain("return (1) + (2)");
	});

	it("keeps prior compiler state when compile fails after reset", async () => {
		const tool = createCljsEvalTool(fakePi);
		const execute = tool.execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: { invokeTool: InvokeTool; sessionManager: { getSessionId: () => string } },
		) => Promise<unknown>;
		const calls: Array<Record<string, unknown>> = [];
		const ctx = {
			invokeTool: async (params: Record<string, unknown>) => {
				calls.push(params);
				return { content: [] };
			},
			sessionManager: { getSessionId: () => "session-reset-fail" },
		};
		await execute("seed", { language: "cljs", code: "(require (quote [clojure.string :as str]))" }, undefined, undefined, ctx);
		await expect(execute("bad-reset", { language: "cljs", code: "(", reset: true }, undefined, undefined, ctx)).rejects.toThrow(/unmatched parentheses/);
		expect(calls).toHaveLength(1);
	});

	it("rethrows a thrown native reset", async () => {
		const tool = createCljsEvalTool(fakePi);
		const execute = tool.execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: { invokeTool: InvokeTool; sessionManager: { getSessionId: () => string } },
		) => Promise<unknown>;
		const ctx = {
			invokeTool: async () => {
				throw new Error("native eval threw");
			},
			sessionManager: { getSessionId: () => "session-thrown-reset" },
		};
		await expect(execute("reset-throw", { language: "cljs", code: "(+ 1 2)", reset: true }, undefined, undefined, ctx)).rejects.toThrow(
			"native eval threw",
		);
	});


	it("applies compiler state only after a successful native result", () => {
		const map = new Map<string, unknown>();
		const prior = { kind: "prior" };
		const candidate = { kind: "candidate" };
		map.set("session", prior);
		applyCompilerStateResult(map, "session", candidate, false, { details: { isError: true } });
		expect(map.get("session")).toBe(prior);
		applyCompilerStateResult(map, "session", candidate, true, { details: { isError: true } });
		expect(map.has("session")).toBe(false);
		map.set("session", prior);
		applyCompilerStateResult(map, "session", candidate, false, { details: {} });
		expect(map.get("session")).toBe(candidate);
		map.set("session", prior);
		applyCompilerStateResult(map, "session", candidate, false, undefined, true);
		expect(map.get("session")).toBe(prior);
		applyCompilerStateResult(map, "session", candidate, true, undefined, true);
		expect(map.has("session")).toBe(false);
	});





});
