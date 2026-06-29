/**
 * useLauncherHealthGate
 * Polls Launcher health every N seconds.
 * Kicks user back to Launcher if service becomes unhealthy.
 * Desktop WebUI wrapper only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getLauncherHealth } from "../api/chatApi";
import type { LauncherHealthStatus } from "../types/chat";

const POLL_MS = 15_000;

export interface HealthGate {
	healthy: boolean;
	status: LauncherHealthStatus | null;
	lastChecked: string | null;
	checking: boolean;
	/** Force an immediate re-check */
	recheck(): void;
}

export function useLauncherHealthGate(onUnhealthy?: () => void): HealthGate {
	const [status, setStatus] = useState<LauncherHealthStatus | null>(null);
	const [checking, setChecking] = useState(false);
	const [lastChecked, setLastChecked] = useState<string | null>(null);
	const onUnhealthyRef = useRef(onUnhealthy);
	onUnhealthyRef.current = onUnhealthy;

	const check = useCallback(async () => {
		setChecking(true);
		try {
			const s = await getLauncherHealth();
			setStatus(s);
			setLastChecked(new Date().toISOString());
			if (!s.healthy && onUnhealthyRef.current) {
				onUnhealthyRef.current();
			}
		} catch {
			// bridge not reachable — treat as unhealthy
			const s: LauncherHealthStatus = {
				healthy: false,
				phase: "error",
				endpoint: null,
				checkedAt: new Date().toISOString(),
			};
			setStatus(s);
			if (onUnhealthyRef.current) onUnhealthyRef.current();
		} finally {
			setChecking(false);
		}
	}, []);

	useEffect(() => {
		check();
		const timer = setInterval(check, POLL_MS);
		return () => clearInterval(timer);
	}, [check]);

	return {
		healthy: status?.healthy ?? false,
		status,
		lastChecked,
		checking,
		recheck: check,
	};
}
