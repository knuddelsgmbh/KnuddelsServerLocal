/**
 * Node.js rejects setTimeout / setInterval delays above 2^31-1 ms (~24.8 days).
 * UserApps (e.g. long-running tournaments) often schedule farther out; without
 * chunking, Node emits TimeoutOverflowWarning and clamps the delay to 1 ms.
 */

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

function normalizeDelay(delay: number | undefined): number {
	if (typeof delay !== 'number' || !Number.isFinite(delay) || delay <= 0) {
		return 0;
	}
	return delay;
}

// Node timer overloads disagree on return type (number vs Timeout); keep loose here.
type ScheduleFn = (handler: TimerHandler, delay?: number, ...args: unknown[]) => unknown;

export function createSafeTimer(schedule: ScheduleFn): ScheduleFn {
	const safeSchedule: ScheduleFn = (handler, delay?, ...args) => {
		let remaining = normalizeDelay(delay);
		if (remaining <= MAX_TIMER_DELAY_MS) {
			return schedule(handler, remaining, ...args);
		}
		return schedule(() => {
			safeSchedule(handler, remaining - MAX_TIMER_DELAY_MS, ...args);
		}, MAX_TIMER_DELAY_MS);
	};
	return safeSchedule;
}
