// Alias the global eval once -> indirect (global-scope) evaluation of the exact shipped widget runtime source,
// so runtime tests exercise production with zero drift and no build step.
// biome-ignore lint/security/noGlobalEval: running the shipped runtime source is the point of these tests.
export const runWidgetRuntimeSource = eval as (src: string) => unknown;
