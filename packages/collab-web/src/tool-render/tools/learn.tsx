import type { ReactNode } from "react";
import { Badge, Kv, KvGrid, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, isRecord, normalizeWs, str, truncate } from "../util";

function skillOf(args: Record<string, unknown>): Record<string, unknown> | null {
	return isRecord(args.skill) ? args.skill : null;
}

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const skill = skillOf(args);
	const skillName = str(detailsRecord(result)?.skill) ?? str(skill?.name);
	const memory = str(args.memory);
	return (
		<>
			<Badge tone={result?.isError ? "warn" : result ? "ok" : "accent"}>memory</Badge>
			{skillName ? <Badge tone="accent">skill {skillName}</Badge> : null}
			{memory ? <span>{truncate(normalizeWs(memory), 76)}</span> : null}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const skill = skillOf(args);
	return (
		<>
			{str(args.memory) ? <Output title="Lesson" text={str(args.memory) ?? ""} maxLines={12} /> : null}
			<KvGrid>
				{str(args.context) ? <Kv k="context">{str(args.context)}</Kv> : null}
				{skill ? <Kv k="skill action">{str(skill.action) ?? "?"}</Kv> : null}
				{skill ? <Kv k="skill name">{str(skill.name) ?? "?"}</Kv> : null}
			</KvGrid>
			<ResultText result={result} maxLines={8} />
		</>
	);
}

export const learnRenderer: ToolRenderer = { Summary, Body };
