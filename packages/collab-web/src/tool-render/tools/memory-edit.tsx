import type { ReactNode } from "react";
import { Badge, Kv, KvGrid, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, num, str } from "../util";

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	const op = str(args.op) ?? "edit";
	const id = str(args.id) ?? "unknown";
	const status = str(details?.status);
	return (
		<>
			<Badge tone={result?.isError ? "warn" : status && status !== "not_found" ? "ok" : undefined}>{op}</Badge>
			<span>{id}</span>
			{status ? <span className="tv-faint">{status}</span> : null}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const details = detailsRecord(result);
	return (
		<>
			<KvGrid>
				<Kv k="operation">{str(args.op) ?? "?"}</Kv>
				<Kv k="memory id">{str(args.id) ?? "?"}</Kv>
				{str(details?.status) ? <Kv k="status">{str(details?.status)}</Kv> : null}
				{str(details?.bank) ? <Kv k="bank">{str(details?.bank)}</Kv> : null}
				{str(details?.store) ? <Kv k="store">{str(details?.store)}</Kv> : null}
				{num(args.importance) !== null ? <Kv k="importance">{num(args.importance)}</Kv> : null}
				{str(args.replacement_id) ? <Kv k="replacement">{str(args.replacement_id)}</Kv> : null}
			</KvGrid>
			<ResultText result={result} maxLines={8} />
		</>
	);
}

export const memoryEditRenderer: ToolRenderer = { Summary, Body };
