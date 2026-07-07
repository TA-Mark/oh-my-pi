interface WelcomeScreenProps {
	onOpenFolder: () => void;
	error?: string;
}

export function WelcomeScreen({ onOpenFolder, error }: WelcomeScreenProps) {
	return (
		<div className="welcome">
			<h1>OMP Desktop</h1>
			<p>Open a project folder to start a session. The agent runs in the folder you choose.</p>
			<button type="button" className="btn btn-primary" onClick={onOpenFolder}>
				Open Folder…
			</button>
			{error ? <p className="status-detail">{error}</p> : null}
		</div>
	);
}
