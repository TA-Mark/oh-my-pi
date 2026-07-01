/**
 * useChatStateMachine
 * Manages Main Chat UI state on top of GuestClient's snapshot.
 * Handles: session list, open tab list (Phase 1), data sources, runtime
 * config, sidebar tab, errors. Desktop WebUI wrapper only.
 *
 * Tab model (Phase 1):
 *   `openSessionIds` is the ordered list of sessions the user has open as
 *   tabs across the top of the chat area (VS Code style). `activeSessionId`
 *   is the currently-focused tab. Activating a session that isn't open yet
 *   auto-inserts it at the end of the list. Deleting a session removes it
 *   from both `sessions` and `openSessionIds`. The whole tab list persists
 *   to localStorage so a restart restores the workspace.
 */

import { useCallback, useEffect, useReducer } from "react";
import type { ChatError, ChatSession, DataSource, RuntimeConfig } from "../types/chat";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SidebarTab =
	| "controls"
	| "providers"
	| "todos"
	| "sources"
	| "sessions"
	| "settings"
	// Phase 4 tabs
	| "tools"
	| "mcp"
	| "files"
	| "usage"
	| "diff";

export interface ChatUiState {
	sidebarOpen: boolean;
	sidebarTab: SidebarTab;
	sessions: ChatSession[];
	/** Ordered ids of sessions rendered as tabs across the top of the chat area. */
	openSessionIds: string[];
	activeSessionId: string | null;
	activeSessionLink: string | null;
	dataSources: DataSource[];
	runtimeConfig: RuntimeConfig | null;
	availableModels: string[];
	error: ChatError | null;
	sessionLoading: boolean;
	configLoading: boolean;
}

const TABS_STORAGE_KEY = "omp.desktop.tabs";

interface PersistedTabs {
	openSessionIds: string[];
	activeSessionId: string | null;
}

/**
 * Read the persisted tab list on hook init. Returns empty values on any
 * failure — we don't want a corrupt localStorage entry to wedge the UI.
 */
function loadPersistedTabs(): PersistedTabs {
	if (typeof localStorage === "undefined") return { openSessionIds: [], activeSessionId: null };
	try {
		const raw = localStorage.getItem(TABS_STORAGE_KEY);
		if (!raw) return { openSessionIds: [], activeSessionId: null };
		const parsed = JSON.parse(raw) as Partial<PersistedTabs>;
		const openSessionIds = Array.isArray(parsed.openSessionIds)
			? parsed.openSessionIds.filter((x): x is string => typeof x === "string")
			: [];
		const activeSessionId = typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null;
		return { openSessionIds, activeSessionId };
	} catch {
		return { openSessionIds: [], activeSessionId: null };
	}
}

function makeInitial(): ChatUiState {
	const persisted = loadPersistedTabs();
	return {
		sidebarOpen: true,
		sidebarTab: "controls",
		sessions: [],
		openSessionIds: persisted.openSessionIds,
		activeSessionId: persisted.activeSessionId,
		activeSessionLink: null,
		dataSources: [],
		runtimeConfig: null,
		availableModels: [],
		error: null,
		sessionLoading: false,
		configLoading: false,
	};
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type Action =
	| { type: "TOGGLE_SIDEBAR" }
	| { type: "SET_SIDEBAR_TAB"; tab: SidebarTab }
	| { type: "SESSIONS_LOADED"; sessions: ChatSession[] }
	| { type: "SESSION_CREATED"; session: ChatSession }
	| { type: "SESSION_DELETED"; id: string }
	| { type: "SESSION_RENAMED"; id: string; name: string }
	| { type: "SESSION_ACTIVATED"; id: string; link: string }
	| { type: "TAB_CLOSED"; id: string }
	| { type: "SESSION_LOADING"; loading: boolean }
	| { type: "DATA_SOURCES_LOADED"; sources: DataSource[] }
	| { type: "DATA_SOURCE_STATUS"; id: string; status: DataSource["status"] }
	| { type: "CONFIG_LOADED"; config: RuntimeConfig; availableModels: string[] }
	| { type: "CONFIG_UPDATED"; config: RuntimeConfig }
	| { type: "CONFIG_LOADING"; loading: boolean }
	| { type: "SESSION_MESSAGE_COUNT"; id: string; count: number }
	| { type: "SET_ERROR"; error: ChatError }
	| { type: "CLEAR_ERROR" };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function reducer(state: ChatUiState, action: Action): ChatUiState {
	switch (action.type) {
		case "TOGGLE_SIDEBAR":
			return { ...state, sidebarOpen: !state.sidebarOpen };

		case "SET_SIDEBAR_TAB":
			return { ...state, sidebarTab: action.tab, sidebarOpen: true };

		case "SESSIONS_LOADED":
			return { ...state, sessions: action.sessions };

		case "SESSION_CREATED":
			return { ...state, sessions: [...state.sessions, action.session] };

		case "SESSION_DELETED": {
			const newOpen = state.openSessionIds.filter(id => id !== action.id);
			const newActive =
				state.activeSessionId === action.id ? pickNeighbor(state.openSessionIds, action.id) : state.activeSessionId;
			return {
				...state,
				sessions: state.sessions.filter(s => s.id !== action.id),
				openSessionIds: newOpen,
				activeSessionId: newActive,
				activeSessionLink: newActive === state.activeSessionId ? state.activeSessionLink : null,
			};
		}

		case "SESSION_RENAMED":
			return {
				...state,
				sessions: state.sessions.map(s => (s.id === action.id ? { ...s, name: action.name } : s)),
			};

		case "SESSION_ACTIVATED": {
			// Auto-insert into open tabs on first activation. Existing tab stays put
			// (no reorder-on-focus — VS Code doesn't reorder either).
			const openSessionIds = state.openSessionIds.includes(action.id)
				? state.openSessionIds
				: [...state.openSessionIds, action.id];
			return {
				...state,
				activeSessionId: action.id,
				activeSessionLink: action.link,
				openSessionIds,
				sessions: state.sessions.map(s => ({ ...s, isActive: s.id === action.id })),
			};
		}

		case "TAB_CLOSED": {
			const newOpen = state.openSessionIds.filter(id => id !== action.id);
			// Close semantics: only strip active pointers when we closed the active
			// tab. Neighbor selection stays in the caller so activation flows through
			// the same session-activate pipeline (which also spins up the client).
			if (state.activeSessionId !== action.id) {
				return { ...state, openSessionIds: newOpen };
			}
			const neighbor = pickNeighbor(state.openSessionIds, action.id);
			return {
				...state,
				openSessionIds: newOpen,
				activeSessionId: neighbor,
				activeSessionLink: null,
				sessions: state.sessions.map(s => ({ ...s, isActive: false })),
			};
		}

		case "SESSION_LOADING":
			return { ...state, sessionLoading: action.loading };

		case "DATA_SOURCES_LOADED":
			return { ...state, dataSources: action.sources };

		case "DATA_SOURCE_STATUS":
			return {
				...state,
				dataSources: state.dataSources.map(d => (d.id === action.id ? { ...d, status: action.status } : d)),
			};

		case "CONFIG_LOADED":
			return { ...state, runtimeConfig: action.config, availableModels: action.availableModels };

		case "CONFIG_UPDATED":
			return { ...state, runtimeConfig: action.config };

		case "CONFIG_LOADING":
			return { ...state, configLoading: action.loading };

		case "SESSION_MESSAGE_COUNT":
			return {
				...state,
				sessions: state.sessions.map(s =>
					s.id === action.id ? { ...s, messageCount: action.count, lastActiveAt: new Date().toISOString() } : s,
				),
			};

		case "SET_ERROR":
			return { ...state, error: action.error };

		case "CLEAR_ERROR":
			return { ...state, error: null };

		default:
			return state;
	}
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface ChatUiActions {
	toggleSidebar(): void;
	setSidebarTab(tab: SidebarTab): void;
	sessionsLoaded(sessions: ChatSession[]): void;
	sessionCreated(session: ChatSession): void;
	sessionDeleted(id: string): void;
	sessionRenamed(id: string, name: string): void;
	sessionActivated(id: string, link: string): void;
	tabClosed(id: string): void;
	sessionLoading(loading: boolean): void;
	dataSourcesLoaded(sources: DataSource[]): void;
	dataSourceStatus(id: string, status: DataSource["status"]): void;
	configLoaded(config: RuntimeConfig, availableModels: string[]): void;
	configUpdated(config: RuntimeConfig): void;
	configLoading(loading: boolean): void;
	sessionMessageCount(id: string, count: number): void;
	setError(error: ChatError): void;
	clearError(): void;
}

/**
 * Pick a neighbor tab id when we close `removed`. Prefers the tab to the
 * right; falls back to the left; null if the list becomes empty. Mirrors the
 * VS Code editor tab close behavior most users have muscle memory for.
 */
function pickNeighbor(openIds: readonly string[], removed: string): string | null {
	const idx = openIds.indexOf(removed);
	if (idx < 0) return null;
	const rest = openIds.filter(id => id !== removed);
	if (rest.length === 0) return null;
	// After removal, the "right neighbor" is at the same index in the shrunk
	// list, capped to length-1.
	return rest[Math.min(idx, rest.length - 1)] ?? null;
}

export function useChatStateMachine(): [ChatUiState, ChatUiActions] {
	const [state, dispatch] = useReducer(reducer, undefined, makeInitial);

	// Persist tab list on every change. Only two keys land in localStorage
	// (open ids + active id); everything else (sessions, dataSources,
	// runtimeConfig) is refetched from the bridge on load.
	useEffect(() => {
		if (typeof localStorage === "undefined") return;
		try {
			const payload: PersistedTabs = {
				openSessionIds: state.openSessionIds,
				activeSessionId: state.activeSessionId,
			};
			localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(payload));
		} catch {
			/* storage full / quota / private-mode — swallow, non-critical */
		}
	}, [state.openSessionIds, state.activeSessionId]);

	const actions: ChatUiActions = {
		toggleSidebar: useCallback(() => dispatch({ type: "TOGGLE_SIDEBAR" }), []),
		setSidebarTab: useCallback(tab => dispatch({ type: "SET_SIDEBAR_TAB", tab }), []),
		sessionsLoaded: useCallback(sessions => dispatch({ type: "SESSIONS_LOADED", sessions }), []),
		sessionCreated: useCallback(session => dispatch({ type: "SESSION_CREATED", session }), []),
		sessionDeleted: useCallback(id => dispatch({ type: "SESSION_DELETED", id }), []),
		sessionRenamed: useCallback((id, name) => dispatch({ type: "SESSION_RENAMED", id, name }), []),
		sessionActivated: useCallback((id, link) => dispatch({ type: "SESSION_ACTIVATED", id, link }), []),
		tabClosed: useCallback(id => dispatch({ type: "TAB_CLOSED", id }), []),
		sessionLoading: useCallback(loading => dispatch({ type: "SESSION_LOADING", loading }), []),
		dataSourcesLoaded: useCallback(sources => dispatch({ type: "DATA_SOURCES_LOADED", sources }), []),
		dataSourceStatus: useCallback((id, status) => dispatch({ type: "DATA_SOURCE_STATUS", id, status }), []),
		configLoaded: useCallback(
			(config, availableModels) => dispatch({ type: "CONFIG_LOADED", config, availableModels }),
			[],
		),
		configUpdated: useCallback(config => dispatch({ type: "CONFIG_UPDATED", config }), []),
		configLoading: useCallback(loading => dispatch({ type: "CONFIG_LOADING", loading }), []),
		sessionMessageCount: useCallback(
			(id: string, count: number) => dispatch({ type: "SESSION_MESSAGE_COUNT", id, count }),
			[],
		),
		setError: useCallback(error => dispatch({ type: "SET_ERROR", error }), []),
		clearError: useCallback(() => dispatch({ type: "CLEAR_ERROR" }), []),
	};

	return [state, actions];
}
