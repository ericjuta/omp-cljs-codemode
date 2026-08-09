declare module "squint-cljs" {
  export interface CompileStringExResult {
    pragmas?: string | null;
    imports?: string | null;
    body?: string | null;
    exports?: string | null;
    javascript: string;
    [key: string]: unknown;
  }

  export function compileString(source: string, options?: Record<string, unknown>): string;
  export function compileStringEx(
    source: string,
    options?: Record<string, unknown>,
    state?: Record<string, unknown>,
  ): CompileStringExResult;
}
