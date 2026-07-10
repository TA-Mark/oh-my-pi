import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

const THEME_KEY = "omp-theme";
type Theme = "light" | "dark";

function readTheme(): Theme {
	const saved = window.localStorage.getItem(THEME_KEY);
	return saved === "dark" ? "dark" : "light";
}

/** Toggles the app between light and dark by setting `data-theme` on <html>.
 * Persists to localStorage under the same key main.tsx reads at boot. */
export function ThemeToggle({ collapsed }: { collapsed?: boolean }) {
	const [theme, setTheme] = useState<Theme>(readTheme);

	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
		window.localStorage.setItem(THEME_KEY, theme);
	}, [theme]);

	const next = theme === "light" ? "dark" : "light";
	const label = `Switch to ${next} theme`;

	return (
		<button
			type="button"
			className="top-icon-button theme-toggle"
			title={label}
			aria-label={label}
			onClick={() => setTheme(next)}
		>
			{theme === "light" ? <Moon size={16} strokeWidth={1.8} /> : <Sun size={16} strokeWidth={1.8} />}
			{!collapsed ? <span className="theme-toggle-label">{theme === "light" ? "Dark" : "Light"}</span> : null}
		</button>
	);
}
