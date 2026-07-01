/**
 * Minimal standard 5-field cron evaluator ("minute hour day month weekday").
 * Supports wildcards, step values (every n-th unit), lists ("a,b") and ranges ("a-b", "a-b" with a step).
 *
 * There is no cron daemon in Workers, so scheduled tasks are driven by a
 * single Durable Object alarm set to the soonest `nextRun` across all tasks.
 * This function computes that next run by scanning minute-by-minute, which
 * is only ever called when a task is created or fires (not per-request).
 */

const FIELD_RANGES = [
	[0, 59], // minute
	[0, 23], // hour
	[1, 31], // day of month
	[1, 12], // month
	[0, 6], // day of week (0 = Sunday)
] as const;

function parseField(field: string, min: number, max: number): Set<number> {
	const values = new Set<number>();
	for (const part of field.split(",")) {
		const stepMatch = part.match(/^(\*|\d+-\d+|\d+)(?:\/(\d+))$/);
		let base = stepMatch ? stepMatch[1] : part;
		const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;

		let lo = min;
		let hi = max;
		if (base !== "*") {
			const rangeMatch = base.match(/^(\d+)-(\d+)$/);
			if (rangeMatch) {
				lo = parseInt(rangeMatch[1], 10);
				hi = parseInt(rangeMatch[2], 10);
			} else if (/^\d+$/.test(base)) {
				lo = hi = parseInt(base, 10);
			} else {
				throw new Error(`Invalid cron field segment: ${part}`);
			}
		}
		for (let v = lo; v <= hi; v += step) {
			values.add(v);
		}
	}
	return values;
}

export function parseCron(expr: string): Set<number>[] {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error("Cron expression must have 5 fields: minute hour day month weekday");
	}
	return fields.map((f, i) => parseField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]));
}

/** Finds the next Date (minute resolution, seconds/ms zeroed) matching the cron expression, strictly after `from`. */
export function nextRunFromCron(expr: string, from: Date): Date {
	const [minutes, hours, days, months, weekdays] = parseCron(expr);

	const candidate = new Date(from.getTime());
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	const MAX_STEPS = 60 * 24 * 366 * 4; // scan up to ~4 years ahead
	for (let i = 0; i < MAX_STEPS; i++) {
		const minuteOk = minutes.has(candidate.getMinutes());
		const hourOk = hours.has(candidate.getHours());
		const dayOk = days.has(candidate.getDate());
		const monthOk = months.has(candidate.getMonth() + 1);
		const weekdayOk = weekdays.has(candidate.getDay());

		if (minuteOk && hourOk && dayOk && monthOk && weekdayOk) {
			return candidate;
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error("Could not find a matching run time for this cron expression");
}

/** Parses interval shorthand like "30s", "5m" or a bare number of minutes. */
export function parseIntervalMs(args: string): number {
	const trimmed = args.trim();
	if (trimmed.endsWith("s")) {
		return parseInt(trimmed.slice(0, -1), 10) * 1000;
	}
	if (trimmed.endsWith("m")) {
		return parseInt(trimmed.slice(0, -1), 10) * 60 * 1000;
	}
	if (trimmed.endsWith("h")) {
		return parseInt(trimmed.slice(0, -1), 10) * 60 * 60 * 1000;
	}
	const asNumber = parseInt(trimmed, 10);
	if (Number.isNaN(asNumber)) {
		throw new Error(`Invalid interval: ${args}`);
	}
	return asNumber * 60 * 1000;
}

export function computeNextRun(type: "interval" | "cron", args: string, from: Date): number {
	if (type === "cron") {
		return nextRunFromCron(args, from).getTime();
	}
	return from.getTime() + parseIntervalMs(args);
}
