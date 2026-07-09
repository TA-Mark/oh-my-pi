interface WelcomeScreenProps {
	onOpenFolder: () => void;
	error?: string;
}

export function WelcomeScreen({ onOpenFolder, error }: WelcomeScreenProps) {
	return (
		<div className="welcome">
			<div className="welcome-mark">OMP</div>
			<h1>Choose a project</h1>
			<p>Start a desktop coding session with the local OMP engine.</p>
			<button type="button" className="btn btn-primary" onClick={onOpenFolder}>
				Open Folder...
			</button>
			{error ? <p className="status-detail">{error}</p> : null}
		</div>
	);
}
