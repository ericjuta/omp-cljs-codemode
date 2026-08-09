import { compileString } from "squint-cljs";

const NATIVE_LANGUAGES = ["py", "js", "rb", "jl"] as const;
const LANGUAGES = [...NATIVE_LANGUAGES, "cljs"] as const;
type Language = (typeof LANGUAGES)[number];

type TypeBox = {
	Type: {
		Object(properties: Record<string, unknown>): unknown;
		String(options?: Record<string, unknown>): unknown;
		Number(options?: Record<string, unknown>): unknown;
		Boolean(options?: Record<string, unknown>): unknown;
		Literal(value: string): unknown;
		Union(items: unknown[], options?: Record<string, unknown>): unknown;
		Optional(schema: unknown): unknown;
	};
};

type ToolContext = {
	invokeTool?: (
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
	) => Promise<unknown>;
};

type ToolApi = {
	typebox: TypeBox;
	registerTool(tool: Record<string, unknown>): void;
};

type CljsEvalParams = {
	language: Language;
	code: string;
	title?: string;
	timeout?: number;
	reset?: boolean;
};

const CORE_IMPORT_RE = /(from\s+["'])squint-cljs\/core\.js(["'])/g;

/**
 * Compile one model-provided Squint cell for OMP's JavaScript codemode backend.
 * Expression mode preserves the native eval tool's final-expression behavior;
 * export elision keeps top-level CLJS definitions valid in the script evaluator.
 */
export function compileCljs(source: string): string {
	const compiled = compileString(source, {
		context: "expr",
		"elide-exports": true,
	});
	return compiled.replace(CORE_IMPORT_RE, `$1${import.meta.resolve("squint-cljs/core.js")}$2`);
}

function languageSchema(typebox: TypeBox): unknown {
	const literals = LANGUAGES.map(language => typebox.Type.Literal(language));
	return typebox.Type.Union(literals, {
		description: 'Execution language: "cljs" for Squint ClojureScript; native eval languages remain available unchanged.',
	});
}

export function createCljsEvalTool(pi: ToolApi): Record<string, unknown> {
	const Type = pi.typebox.Type;
	const parameters = Type.Object({
		language: languageSchema(pi.typebox),
		code: Type.String({ description: "Code to run in this eval call, verbatim." }),
		title: Type.Optional(Type.String({ description: "Short label shown in the transcript." })),
		timeout: Type.Optional(Type.Number({ description: "Timeout for this eval call in seconds; 0 disables the cell timeout." })),
		reset: Type.Optional(Type.Boolean({ description: "Reset the selected language runtime before running." })),
	});

	return {
		name: "eval",
		label: "Eval",
		description: [
			"Run one step of code in a persistent codemode runtime.",
			`Use ${JSON.stringify("cljs")} for Squint ClojureScript; native ${NATIVE_LANGUAGES.join(", ")} runtimes are delegated unchanged.`,
			"CLJS is compiled to JavaScript and then executed by OMP's native eval backend, so display(), read(), write(), env(), output(), tool.<name>(args), and async/await remain available.",
			"For CLJS tool calls, use JavaScript interop such as (js/await (.read tool {:path \"package.json\"})).",
			"For tool names that are not valid CLJS identifiers, use ((aget tool \"tool-name\") {:arg value}) instead.",
			"The final CLJS expression is returned using the same result and error contract as JavaScript eval.",
		].join("\n"),
		parameters,
		loadMode: "essential",
		strict: true,
		concurrency: "exclusive",
		execute: async (
			_toolCallId: string,
			params: CljsEvalParams,
			signal: AbortSignal | undefined,
			onUpdate: ((update: unknown) => void) | undefined,
			ctx: ToolContext,
		) => {
			if (!ctx.invokeTool) {
				throw new Error('CLJS codemode requires the native "eval" tool delegation context');
			}
			if (params.language !== "cljs") {
				return await ctx.invokeTool(params as unknown as Record<string, unknown>, { signal, onUpdate });
			}
			const code = compileCljs(params.code);
			return await ctx.invokeTool(
				{ ...params, language: "js", code },
				{ signal, onUpdate },
			);
		},
	};
}

export default function cljsCodemodeExtension(pi: ToolApi): void {
	pi.registerTool(createCljsEvalTool(pi));
}
