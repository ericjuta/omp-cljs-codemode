import { rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import { compileCljs, createCljsEvalTool } from "./index.js";

const fakePi = {
	typebox: { Type },
	registerTool: () => {},
};

async function evaluateCljsDefinition(source: string): Promise<unknown> {
	const file = `/tmp/omp-cljs-codemode-${crypto.randomUUID()}.mjs`;
	try {
		await Bun.write(file, `${compileCljs(source)}\nexport default result;`);
		// Each cell is emitted to a fresh runtime-selected module, so a static import cannot name it.
		return (await import(pathToFileURL(file).href)).default;
	} finally {
		await rm(file, { force: true });
	}
}

async function executeDelegated(tool: Record<string, unknown>, params: Record<string, unknown>) {
	const calls: Array<Record<string, unknown>> = [];
	const invokeTool = async (nextParams: Record<string, unknown>) => {
		calls.push(nextParams);
		return { content: [{ type: "text", text: "delegated" }], details: { delegated: true } };
	};
	const execute = tool.execute as (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: ((update: unknown) => void) | undefined,
		ctx: { invokeTool: typeof invokeTool },
	) => Promise<unknown>;
	const result = await execute("test-call", params, undefined, undefined, { invokeTool });
	return { calls, result };
}

describe("CLJS codemode plugin", () => {
	it("compiles an expression for the native eval backend", async () => {
		const value = await evaluateCljsDefinition("(def result (+ 1 2))");
		expect(value).toBe(3);
	});

	it("rewrites Squint's core import to the pinned runtime", () => {
		const code = compileCljs("(+ 1 2)");
		expect(code).toContain(import.meta.resolve("squint-cljs/core.js"));
		expect(code).not.toContain("from 'squint-cljs/core.js'");
	});

	it("preserves the native eval tool contract metadata", () => {
		const tool = createCljsEvalTool(fakePi);
		expect(tool.name).toBe("eval");
		expect(tool.loadMode).toBe("essential");
		expect(tool.strict).toBe(true);
		expect(tool.concurrency).toBe("exclusive");
	});

	it("preserves async CLJS expressions for JavaScript eval", async () => {
		const value = await evaluateCljsDefinition("(def result (js/await (js/Promise.resolve 7)))");
		expect(value).toBe(7);
	});

	it("reports invalid CLJS as a compiler error", () => {
		expect(() => compileCljs("(")).toThrow();
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

	it("delegates CLJS as JavaScript while retaining the call metadata", async () => {
		const tool = createCljsEvalTool(fakePi);
		const { calls, result } = await executeDelegated(tool, {
			language: "cljs",
			code: "(js/await (.read tool {:path \"package.json\"}))",
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

	it("passes native eval languages through without compiling them", async () => {
		const tool = createCljsEvalTool(fakePi);
		const { calls } = await executeDelegated(tool, { language: "js", code: "1 + 2" });
		expect(calls).toEqual([{ language: "js", code: "1 + 2" }]);
	});

	it("forwards abort and progress channels to native eval", async () => {
		const tool = createCljsEvalTool(fakePi);
		let seenSignal: AbortSignal | undefined;
		let seenUpdate: ((update: unknown) => void) | undefined;
		const signal = new AbortController().signal;
		const onUpdate = (_update: unknown) => {};
		const execute = tool.execute as (
			toolCallId: string,
			params: Record<string, unknown>,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: {
				invokeTool: (
					params: Record<string, unknown>,
					options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
				) => Promise<unknown>;
			},
		) => Promise<unknown>;
		await execute("forwarding-call", { language: "js", code: "1 + 2" }, signal, onUpdate, {
			invokeTool: async (_params, options) => {
				seenSignal = options?.signal;
				seenUpdate = options?.onUpdate;
				return { content: [] };
			},
		});
		expect(seenSignal).toBe(signal);
		expect(seenUpdate).toBe(onUpdate);
	});
});
