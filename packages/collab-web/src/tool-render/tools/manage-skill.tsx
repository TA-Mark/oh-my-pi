import type { ReactNode } from "react";
import { Badge, Kv, KvGrid, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, str } from "../util";

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const action = str(details?.action) ?? str(args.action) ?? "manage";
	const name = str(details?.name) ?? str(args.name) ?? "skill";
	return (
		<>
			<Badge tone={result?.isError ? "warn" : result ? "ok" : "accent"}>{action}</Badge>
			<span>{name}</span>
			{details?.shadowed === true ? <Badge tone="warn">shadowed</Badge> : null}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	return (
		<>
			<KvGrid>
				<Kv k="action">{str(args.action) ?? "?"}</Kv>
				<Kv k="name">{str(args.name) ?? "?"}</Kv>
				{str(args.description) ? <Kv k="description">{str(args.description)}</Kv> : null}
			</KvGrid>
			{str(args.body) ? (
				<Output title="SKILL.md body" text={str(args.body) ?? ""} lang="markdown" maxLines={16} />
			) : null}
			<ResultText result={result} maxLines={8} />
		</>
	);
}

export const manageSkillRenderer: ToolRenderer = { Summary, Body };
