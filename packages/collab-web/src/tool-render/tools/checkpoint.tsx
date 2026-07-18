import type { ReactNode } from "react";
import { Badge, Kv, KvGrid, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, normalizeWs, str, truncate } from "../util";

function CheckpointSummary({ args, result }: ToolRenderProps): ReactNode {
	const goal = str(detailsRecord(result)?.goal) ?? str(args.goal);
	return (
		<>
			{result && !result.isError ? <Badge tone="ok">active</Badge> : null}
			{goal ? <span>{truncate(normalizeWs(goal), 84)}</span> : <span>investigation checkpoint</span>}
		</>
	);
}

function CheckpointBody({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const goal = str(details?.goal) ?? str(args.goal);
	const startedAt = str(details?.startedAt);
	return (
		<>
			<KvGrid>
				{goal ? <Kv k="goal">{goal}</Kv> : null}
				{startedAt ? <Kv k="started">{startedAt}</Kv> : null}
			</KvGrid>
			<ResultText result={result} maxLines={6} />
		</>
	);
}

function RewindSummary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const report = str(details?.report) ?? str(args.report);
	return (
		<>
			{details?.rewound === true ? <Badge tone="ok">rewound</Badge> : null}
			{report ? <span>{truncate(normalizeWs(report), 84)}</span> : <span>retain investigation report</span>}
		</>
	);
}

function RewindBody({ args, result }: ToolRenderProps): ReactNode {
	const report = str(detailsRecord(result)?.report) ?? str(args.report);
	return (
		<>
			{report ? <Output title="Retained report" text={report} maxLines={16} /> : null}
			<ResultText result={result} maxLines={6} />
		</>
	);
}

export const checkpointRenderer: ToolRenderer = { Summary: CheckpointSummary, Body: CheckpointBody };
export const rewindRenderer: ToolRenderer = { Summary: RewindSummary, Body: RewindBody };
