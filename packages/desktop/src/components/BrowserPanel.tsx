import {
	ArrowLeft,
	ArrowRight,
	CircleAlert,
	ExternalLink,
	Globe2,
	Plus,
	RefreshCw,
	Search,
	SquarePlus,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface BrowserPanelProps {
	onClosePanel: () => void;
	onAddContext: (url: string, text: string) => void;
	onExternal: (url: string) => void;
}

const EMPTY_BROWSER_STATE: DesktopBrowserViewState = { tabs: [], activeId: null };

function displayAddress(url: string): string {
	return url === "about:blank" ? "" : url;
}

export function BrowserPanel({ onClosePanel, onAddContext, onExternal }: BrowserPanelProps) {
	const [state, setState] = useState<DesktopBrowserViewState>(EMPTY_BROWSER_STATE);
	const [address, setAddress] = useState("");
	const [panelError, setPanelError] = useState<string | null>(null);
	const [addingContext, setAddingContext] = useState(false);
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const addressRef = useRef<HTMLInputElement | null>(null);
	const active = useMemo(
		() => state.tabs.find(tab => tab.id === state.activeId) ?? null,
		[state.activeId, state.tabs],
	);

	const syncBounds = useCallback((): void => {
		const viewport = viewportRef.current;
		if (!viewport?.isConnected) return;
		const rect = viewport.getBoundingClientRect();
		void window.desktop
			.setBrowserViewBounds({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		let disposed = false;
		const offState = window.desktop.onBrowserViewState(next => {
			if (!disposed) setState(next);
		});
		void window.desktop
			.listBrowserViews()
			.then(async next => {
				if (disposed) return;
				if (next.tabs.length > 0) {
					setState(next);
					return;
				}
				await window.desktop.createBrowserView();
			})
			.catch(error => {
				if (!disposed) setPanelError(error instanceof Error ? error.message : String(error));
			});
		void window.desktop.setBrowserViewVisible(true).catch(() => undefined);
		return () => {
			disposed = true;
			offState();
			void window.desktop.setBrowserViewVisible(false).catch(() => undefined);
		};
	}, []);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		let frame = 0;
		const schedule = (): void => {
			window.cancelAnimationFrame(frame);
			frame = window.requestAnimationFrame(syncBounds);
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(viewport);
		window.addEventListener("resize", schedule);
		window.addEventListener("scroll", schedule, true);
		schedule();
		return () => {
			window.cancelAnimationFrame(frame);
			observer.disconnect();
			window.removeEventListener("resize", schedule);
			window.removeEventListener("scroll", schedule, true);
		};
	}, [syncBounds]);

	useEffect(() => {
		if (document.activeElement !== addressRef.current) setAddress(displayAddress(active?.url ?? ""));
		const frame = window.requestAnimationFrame(syncBounds);
		return () => window.cancelAnimationFrame(frame);
	}, [active?.url, syncBounds]);

	const createTab = (): void => {
		setPanelError(null);
		void window.desktop.createBrowserView().catch(error => {
			setPanelError(error instanceof Error ? error.message : String(error));
		});
	};

	const selectTab = (id: string): void => {
		setPanelError(null);
		void window.desktop.activateBrowserView(id).catch(error => {
			setPanelError(error instanceof Error ? error.message : String(error));
		});
	};

	const closeTab = (id: string): void => {
		setPanelError(null);
		void window.desktop
			.closeBrowserView(id)
			.then(() => {
				if (state.tabs.length === 1) onClosePanel();
			})
			.catch(error => setPanelError(error instanceof Error ? error.message : String(error)));
	};

	const navigate = (value: string): void => {
		const target = value.trim();
		if (!target) return;
		setPanelError(null);
		const operation = active
			? window.desktop.navigateBrowserView(active.id, target)
			: window.desktop.createBrowserView(target);
		void operation.catch(error => setPanelError(error instanceof Error ? error.message : String(error)));
	};

	const history = (action: "back" | "forward" | "reload" | "stop"): void => {
		if (!active) return;
		setPanelError(null);
		void window.desktop
			.browserViewHistory(active.id, action)
			.catch(error => setPanelError(error instanceof Error ? error.message : String(error)));
	};

	const addPageContext = (): void => {
		if (!active || active.url === "about:blank") return;
		setAddingContext(true);
		setPanelError(null);
		void window.desktop
			.extractBrowserView(active.id)
			.then(page => {
				const content = [`# ${page.title || page.url}`, page.url, page.text].filter(Boolean).join("\n\n");
				onAddContext(page.url, content);
			})
			.catch(error => setPanelError(error instanceof Error ? error.message : String(error)))
			.finally(() => setAddingContext(false));
	};

	const effectiveError = panelError ?? active?.error ?? null;
	return (
		<div className="browser-panel">
			<div className="browser-tabs" role="tablist" aria-label="Browser tabs">
				{state.tabs.map(tab => (
					<div
						key={tab.id}
						className={tab.id === state.activeId ? "browser-tab browser-tab--active" : "browser-tab"}
						role="presentation"
					>
						<button
							type="button"
							className="browser-tab-main"
							role="tab"
							aria-selected={tab.id === state.activeId}
							title={tab.title}
							onClick={() => selectTab(tab.id)}
						>
							<Globe2 size={13} strokeWidth={1.8} />
							<span>{tab.title}</span>
							{tab.loading ? <i className="browser-tab-loading" aria-label="Loading" /> : null}
						</button>
						<button
							type="button"
							className="browser-tab-close"
							aria-label={`Close ${tab.title}`}
							onClick={() => closeTab(tab.id)}
						>
							<X size={12} strokeWidth={1.8} />
						</button>
					</div>
				))}
				<button type="button" className="browser-tab-add" onClick={createTab} aria-label="New browser tab">
					<Plus size={16} strokeWidth={1.8} />
				</button>
			</div>

			<div className="browser-toolbar">
				<div className="browser-history-controls">
					<button type="button" disabled={!active?.canGoBack} onClick={() => history("back")} aria-label="Go back">
						<ArrowLeft size={15} strokeWidth={1.8} />
					</button>
					<button
						type="button"
						disabled={!active?.canGoForward}
						onClick={() => history("forward")}
						aria-label="Go forward"
					>
						<ArrowRight size={15} strokeWidth={1.8} />
					</button>
					<button
						type="button"
						disabled={!active || active.url === "about:blank"}
						onClick={() => history(active?.loading ? "stop" : "reload")}
						aria-label={active?.loading ? "Stop loading" : "Reload page"}
					>
						{active?.loading ? <X size={15} strokeWidth={1.8} /> : <RefreshCw size={15} strokeWidth={1.8} />}
					</button>
				</div>
				<form
					className="browser-address"
					onSubmit={event => {
						event.preventDefault();
						navigate(address);
					}}
				>
					<Search size={14} strokeWidth={1.8} />
					<input
						ref={addressRef}
						value={address}
						onChange={event => setAddress(event.currentTarget.value)}
						onFocus={event => event.currentTarget.select()}
						placeholder="Search or enter address"
						aria-label="Search or enter address"
						spellCheck={false}
					/>
				</form>
				<button
					type="button"
					disabled={!active || active.url === "about:blank" || addingContext}
					onClick={addPageContext}
					title="Add page to context"
					aria-label="Add page to context"
				>
					<SquarePlus size={15} strokeWidth={1.8} />
				</button>
				<button
					type="button"
					disabled={!active || active.url === "about:blank"}
					onClick={() => active && onExternal(active.url)}
					title="Open in default browser"
					aria-label="Open in default browser"
				>
					<ExternalLink size={15} strokeWidth={1.8} />
				</button>
			</div>

			<div className="browser-stage" ref={viewportRef}>
				{effectiveError ? (
					<div className="browser-empty browser-empty--error">
						<CircleAlert size={24} strokeWidth={1.5} />
						<strong>Couldn&apos;t open this page</strong>
						<span>{effectiveError}</span>
						<button type="button" onClick={() => navigate(address || active?.url || "")}>
							Try again
						</button>
					</div>
				) : !active || active.url === "about:blank" ? (
					<div className="browser-empty">
						<Globe2 size={26} strokeWidth={1.35} />
						<strong>Browse alongside your task</strong>
						<span>Search the web, inspect a page, then add useful content directly to context.</span>
					</div>
				) : null}
			</div>
		</div>
	);
}
