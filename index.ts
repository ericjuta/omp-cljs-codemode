import { compileStringEx, type CompileStringExResult } from "squint-cljs";

type Language = "cljs";

type TypeBox = {
	Type: {
		Object(properties: Record<string, unknown>): unknown;
		String(options?: Record<string, unknown>): unknown;
		Number(options?: Record<string, unknown>): unknown;
		Boolean(options?: Record<string, unknown>): unknown;
		Literal(value: string): unknown;
		Optional(schema: unknown): unknown;
	};
};

type ToolContext = {
	invokeTool?: (
		params: Record<string, unknown>,
		options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
	) => Promise<unknown>;
};

export type ToolApi = {
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

const CORE_IMPORT = "import * as squint_core from 'squint-cljs/core.js';\n";


const CLJS_EXAMPLES = [
	{ caption: "Bare expression", code: "(+ 1 2)" },
	{ caption: "Define and display", code: "(def result (+ 1 2))\n(display result)" },
	{ caption: "Async read and JSON parse", code: '(js/JSON.parse (js/await (js/read "package.json")))' },
] as const;

const CLJS_BOUNDARIES = [
	"Write direct Squint forms; do not wrap a cell in Vite or JavaScript module scaffolding.",
	"Every cell needs a final expression or display(...); a def alone has no visible output.",
	"Use display(...) for visible intermediate output and output(...) to inspect prior tool output.",
	"Top-level defs persist until reset: true; other cells can reuse them.",
	"Compiler aliases and project-local CLJS require resolution are unavailable; do not use Clojure require for project-local modules.",
	"Nested async is supported.",
	'Prefer (js/await (js/read "package.json")).',
	'For names not valid CLJS identifiers, use (js/await ((aget tool "tool-name") {:arg "value"})).',
	"Multiple top-level forms execute in order; the final form supplies the cell result.",
] as const;

/**
 * Compile one complete cell through Squint's reader. Return context emits valid
 * statements for every form and returns only the effective final form, while
 * leaving top-level definitions in OMP's persistent JavaScript runtime.
 */
export function compileCljs(source: string): string {
	const compiled = compileStringEx(source, {
		context: "return",
		async: true,
		"elide-exports": true,
	});
	const imports = compiled.imports ?? "";
	const coreImportIndex = imports.indexOf(CORE_IMPORT);
	if (coreImportIndex < 0 || imports.indexOf(CORE_IMPORT, coreImportIndex + CORE_IMPORT.length) >= 0) {
		throw new Error("Squint compiler did not emit exactly one expected static core import");
	}
	const original = `${compiled.pragmas ?? ""}${imports}${compiled.body ?? ""}${compiled.exports ?? ""}`;
	if (original !== compiled.javascript) {
		throw new Error("Squint compiler returned an unsupported output layout");
	}
	const runtimeCoreImport = `import * as squint_core from ${JSON.stringify(import.meta.resolve("squint-cljs/core.js"))};\n`;
	const rewrittenImports =
		imports.slice(0, coreImportIndex) + runtimeCoreImport + imports.slice(coreImportIndex + CORE_IMPORT.length);
	return `${compiled.pragmas ?? ""}${rewrittenImports}${compiled.body ?? ""}${compiled.exports ?? ""}`;
}

function languageSchema(typebox: TypeBox): unknown {
	return typebox.Type.Literal("cljs");
}

function renderExampleCode(code: string): string {
	return code.includes("\n") ? `\"\"\"${code}\"\"\"` : JSON.stringify(code);
}



function modelGuidance(): string {
	const examples = CLJS_EXAMPLES.map(example =>
		`# ${example.caption}\n<example>\neval(language="cljs", code=${renderExampleCode(example.code)})\n</example>`,
	).join("\n");
	return [
		"Run one step of code in a persistent codemode runtime.",
		'Only "cljs" is accepted. Squint ClojureScript is compiled to the hidden JavaScript eval runtime.',
		"CLJS is compiled directly to JavaScript, so display(), read(), write(), env(), output(), tool, and async/await remain available.",
		...CLJS_BOUNDARIES,
		"The final CLJS expression uses the same result and error contract as JavaScript eval.",
		`<examples>\n${examples}\n</examples>`,
	].join("\n");
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
		description: modelGuidance(),
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
			if (params.language !== "cljs") {
				throw new Error(`CLJS eval only supports language "cljs"; received ${JSON.stringify(params.language)}`);
			}
			if (!ctx.invokeTool) {
				throw new Error('CLJS codemode requires the native "eval" tool delegation context');
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
