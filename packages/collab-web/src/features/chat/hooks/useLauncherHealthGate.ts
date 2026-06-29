/**
 * useLauncherHealthGate
 * Polls Launcher health every N seconds.
 * Kicks user back to Launcher if service becomes unhealthy.
 * Desktop WebUI wrapper only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getLauncherHealth } from "../api/chatApi";
import type { LauncherHealthStatus } from "../types/chat";

const POLL_MS = 20_000;
const UNHEALTHY_THRESHOLD = 8;

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
	const failCountRef = useRef(0);

	const check = useCallback(async () => {
		setChecking(true);
		try {
			const s = await getLauncherHealth();
			setStatus(s);
			setLastChecked(new Date().toISOString());
			if (s.healthy) {
				failCountRef.current = 0;
			} else {
				failCountRef.current++;
				if (failCountRef.current >= UNHEALTHY_THRESHOLD && onUnhealthyRef.current) {
					onUnhealthyRef.current();
				}
			}
		} catch {
			failCountRef.current++;
			const s: LauncherHealthStatus = {
				healthy: false,
				phase: "error",
				endpoint: null,
				checkedAt: new Date().toISOString(),
			};
			setStatus(s);
			if (failCountRef.current >= UNHEALTHY_THRESHOLD && onUnhealthyRef.current) {
				onUnhealthyRef.current();
			}
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
