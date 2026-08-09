import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import { compileCljs, createCljsEvalTool } from "./index.js";

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

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (body: string) => () => Promise<unknown>;

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

	it("reports invalid CLJS as a compiler error", () => {
		expect(() => compileCljs("(")).toThrow();
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
			'native "eval" tool delegation context',
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
			'(js/JSON.parse (js/await (js/read "package.json")))',
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
		expect(description).toContain("Nested async is supported");
		expect(description).toContain('(js/await (js/read "package.json"))');
		expect(description).toContain('(js/await ((aget tool "tool-name") {:arg "value"}))');
		expect(description).toContain("Multiple top-level forms execute in order");
		expect(description).toContain("output(...)");
	});

	it("compiles arbitrary dynamic tool names", () => {
		const code = compileCljs('((aget tool "arbitrary-tool-name") {:arg 1})');
		expect(code).toContain("arbitrary-tool-name");
	});

});
