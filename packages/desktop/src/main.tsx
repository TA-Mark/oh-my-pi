import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/index.css";

// Apply the persisted theme (defaults to light, matching the current shell).
const savedTheme = localStorage.getItem("omp-theme") ?? "light";
document.documentElement.setAttribute("data-theme", savedTheme);

const container = document.getElementById("root");
if (!container) throw new Error("#root element not found");

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
