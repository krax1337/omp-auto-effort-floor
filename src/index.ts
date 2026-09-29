/**
 * omp-auto-effort-floor — minimum reasoning effort for `auto` thinking mode.
 *
 * omp's `auto` classifier picks an effort per prompt, capped above by
 * `providers.autoThinkingMaxEffort`, but has no lower bound. This extension
 * raises the effort on outgoing provider requests to a floor, only while the
 * session's configured thinking selector is `auto`. Pinned levels (e.g. an
 * explicit `/thinking low`) are left alone.
 *
 * Floor source, highest precedence first: `/auto-floor <level>` (session),
 * `OMP_AUTO_EFFORT_FLOOR` env, default `medium`. `/auto-floor off` disables.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

export const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

const isLevel = (value: unknown): value is Level => typeof value === "string" && LEVELS.includes(value as Level);
const rank = (level: Level): number => LEVELS.indexOf(level);

export function parseFloor(raw: string | undefined): Level | undefined {
	const value = raw?.trim().toLowerCase();
	if (!value) return "medium";
	if (value === "off") return undefined;
	return isLevel(value) ? value : "medium";
}

/** True when the latest thinking change on the active branch was made in auto mode. */
export function autoActive(sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">): boolean {
	const branch = sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry?.type === "thinking_level_change") return entry.configured === "auto";
	}
	return false;
}

type EffortChange = { from: Level; to: Level };

/** Raises `holder[key]` to `floor` when it holds a known level below it. */
function raiseField(holder: unknown, key: string, floor: Level): EffortChange | undefined {
	if (!holder || typeof holder !== "object" || !(key in holder)) return undefined;
	const record = holder as Record<string, unknown>;
	const current = record[key];
	if (!isLevel(current) || rank(current) >= rank(floor)) return undefined;
	record[key] = floor;
	return { from: current, to: floor };
}

/**
 * Mutates the effort field in place for the wire shapes omp emits:
 * - Anthropic Messages: `output_config.effort` (adaptive / budget-effort Claude models)
 * - OpenAI Responses / Codex: `reasoning.effort`
 * - OpenAI-compatible chat: `reasoning_effort`
 * Only raises an effort already present, so the required betas/flags are already on the request.
 */
export function applyFloor(payload: unknown, floor: Level): EffortChange | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const p = payload as Record<string, unknown>;
	// Anthropic has no `minimal`; its lowest wire effort is `low`.
	return (
		raiseField(p.output_config, "effort", floor === "minimal" ? "low" : floor) ??
		raiseField(p.reasoning, "effort", floor) ??
		raiseField(p, "reasoning_effort", floor)
	);
}

export default function autoEffortFloor(pi: ExtensionAPI): void {
	let floor = parseFloor(process.env.OMP_AUTO_EFFORT_FLOOR);

	pi.on("before_provider_request", (event, ctx) => {
		if (!floor || !autoActive(ctx.sessionManager)) return undefined;
		const change = applyFloor(event.payload, floor);
		if (!change) return undefined;
		pi.logger.debug("auto-effort-floor: raised effort", { ...change, model: ctx.model?.id });
		return event.payload;
	});

	pi.registerCommand("auto-floor", {
		description: `Minimum effort for auto thinking: ${LEVELS.join("|")}|off (no arg shows current)`,
		getArgumentCompletions: prefix =>
			[...LEVELS, "off"].filter(v => v.startsWith(prefix)).map(value => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim().toLowerCase();
			if (value === "off") floor = undefined;
			else if (isLevel(value)) floor = value;
			else if (value) {
				ctx.ui.notify(`auto-floor: unknown level "${value}" (${LEVELS.join("|")}|off)`, "error");
				return;
			}
			const state = autoActive(ctx.sessionManager) ? "auto active" : "auto not active, floor idle";
			ctx.ui.notify(`auto-floor: ${floor ?? "off"} (${state})`, "info");
		},
	});
}
