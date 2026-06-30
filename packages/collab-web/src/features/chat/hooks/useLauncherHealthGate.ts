/**
 * useLauncherHealthGate
 * Polls Launcher health every N seconds + subscribes to /launcher/stream
 * for realtime install_progress updates (so the install banner ticks
 * instead of waiting for the next poll).
 * Desktop WebUI wrapper only.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { getLauncherHealth } from "../api/chatApi";
import type { InstallProgress, LauncherHealthStatus } from "../types/chat";

const POLL_MS = 20_000;
const POLL_MS_FAST = 2000; // while installing — pick up post-install probe quickly
const UNHEALTHY_THRESHOLD = 8;
const WS_URL = "ws://localhost:8787/api/v1/launcher/stream";

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
	const statusRef = useRef<LauncherHealthStatus | null>(null);
	statusRef.current = status;

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

	// Initial check + poll loop. Rate adapts to phase: slow normally, fast
	// while installing so the post-install state lands quickly.
	useEffect(() => {
		check();
	}, [check]);

	useEffect(() => {
		const installing = status?.phase === "installing" || status?.installProgress != null;
		const interval = installing ? POLL_MS_FAST : POLL_MS;
		const timer = setInterval(check, interval);
		return () => clearInterval(timer);
	}, [check, status?.phase, status?.installProgress]);

	// Realtime install progress via WS. Reconnect on close so the banner
	// keeps animating even when the bridge restarts.
	useEffect(() => {
		let ws: WebSocket | null = null;
		let alive = true;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

		const connect = (): void => {
			if (!alive) return;
			try {
				ws = new WebSocket(WS_URL);
			} catch {
				reconnectTimer = setTimeout(connect, 3000);
				return;
			}
			ws.onmessage = (ev: MessageEvent) => {
				try {
					const payload = JSON.parse(typeof ev.data === "string" ? ev.data : "") as
						| { type: "install_progress"; progress: InstallProgress }
						| { type: "health"; healthy: boolean; error?: string }
						| { type: "status_change"; status: string; phase: string };
					if (payload.type === "install_progress") {
						setStatus(prev => ({
							healthy: prev?.healthy ?? true,
							phase: prev?.phase ?? "installing",
							endpoint: prev?.endpoint ?? null,
							checkedAt: new Date().toISOString(),
							installProgress: payload.progress,
						}));
					} else if (payload.type === "health") {
						setStatus(prev => ({
							healthy: payload.healthy,
							phase: prev?.phase ?? (payload.healthy ? "running_healthy" : "error"),
							endpoint: prev?.endpoint ?? null,
							checkedAt: new Date().toISOString(),
							installProgress: prev?.installProgress ?? null,
						}));
					} else if (payload.type === "status_change") {
						setStatus(prev => ({
							healthy: prev?.healthy ?? false,
							phase: payload.phase,
							endpoint: prev?.endpoint ?? null,
							checkedAt: new Date().toISOString(),
							installProgress: payload.phase === "installing" ? prev?.installProgress ?? null : null,
						}));
					}
				} catch {
					/* malformed frame — ignore */
				}
			};
			ws.onclose = () => {
				if (!alive) return;
				reconnectTimer = setTimeout(connect, 3000);
			};
			ws.onerror = () => {
				// onclose follows, no extra handling
			};
		};

		connect();
		return () => {
			alive = false;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			ws?.close();
		};
	}, []);

	return {
		healthy: status?.healthy ?? false,
		status,
		lastChecked,
		checking,
		recheck: check,
	};
}
