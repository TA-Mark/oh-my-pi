/**
 * useChatStateMachine
 * Manages Main Chat UI state on top of GuestClient's snapshot.
 * Handles: session list, data sources, runtime config, sidebar tab, errors.
 * Desktop WebUI wrapper only.
 */

import { useCallback, useReducer } from "react";
import type { ChatError, ChatSession, DataSource, RuntimeConfig } from "../types/chat";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type SidebarTab = "controls" | "sources" | "sessions";

export interface ChatUiState {
	sidebarOpen: boolean;
	sidebarTab: SidebarTab;
	sessions: ChatSession[];
	activeSessionId: string | null;
	activeSessionLink: string | null;
	dataSources: DataSource[];
	runtimeConfig: RuntimeConfig | null;
	availableModels: string[];
	error: ChatError | null;
	sessionLoading: boolean;
	configLoading: boolean;
}

const initial: ChatUiState = {
	sidebarOpen: true,
	sidebarTab: "controls",
	sessions: [],
	activeSessionId: null,
	activeSessionLink: null,
	dataSources: [],
	runtimeConfig: null,
	availableModels: [],
	error: null,
	sessionLoading: false,
	configLoading: false,
};

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

		case "SESSION_DELETED":
			return {
				...state,
				sessions: state.sessions.filter(s => s.id !== action.id),
				activeSessionId: state.activeSessionId === action.id ? null : state.activeSessionId,
				activeSessionLink: state.activeSessionId === action.id ? null : state.activeSessionLink,
			};

		case "SESSION_RENAMED":
			return {
				...state,
				sessions: state.sessions.map(s => (s.id === action.id ? { ...s, name: action.name } : s)),
			};

		case "SESSION_ACTIVATED":
			return {
				...state,
				activeSessionId: action.id,
				activeSessionLink: action.link,
				sessions: state.sessions.map(s => ({ ...s, isActive: s.id === action.id })),
			};

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

export function useChatStateMachine(): [ChatUiState, ChatUiActions] {
	const [state, dispatch] = useReducer(reducer, initial);

	const actions: ChatUiActions = {
		toggleSidebar: useCallback(() => dispatch({ type: "TOGGLE_SIDEBAR" }), []),
		setSidebarTab: useCallback(tab => dispatch({ type: "SET_SIDEBAR_TAB", tab }), []),
		sessionsLoaded: useCallback(sessions => dispatch({ type: "SESSIONS_LOADED", sessions }), []),
		sessionCreated: useCallback(session => dispatch({ type: "SESSION_CREATED", session }), []),
		sessionDeleted: useCallback(id => dispatch({ type: "SESSION_DELETED", id }), []),
		sessionRenamed: useCallback((id, name) => dispatch({ type: "SESSION_RENAMED", id, name }), []),
		sessionActivated: useCallback((id, link) => dispatch({ type: "SESSION_ACTIVATED", id, link }), []),
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
