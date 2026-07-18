import type { RpcCommand as DesktopRpcCommand } from "../../../desktop/src/lib/rpc-protocol";
import type { RpcCommand as CoreRpcCommand, RpcResponse as CoreRpcResponse } from "../../src/modes/rpc/rpc-types";

type AssertNever<T extends never> = T;
type DesktopCommandType = DesktopRpcCommand["type"];
type CoreCommandType = CoreRpcCommand["type"];
type CoreSuccessResponse = Extract<CoreRpcResponse, { success: true }>;

/** Desktop must neither invent a command nor omit a command exposed by the core. */
type DesktopOnlyCommand = AssertNever<Exclude<DesktopCommandType, CoreCommandType>>;
type CoreOnlyCommand = AssertNever<Exclude<CoreCommandType, DesktopCommandType>>;

/** Every command sent by Desktop must have a successful response arm in the core protocol. */
type CommandWithoutSuccessResponse = AssertNever<Exclude<DesktopCommandType, CoreSuccessResponse["command"]>>;

export type DesktopRpcParityContract = DesktopOnlyCommand | CoreOnlyCommand | CommandWithoutSuccessResponse;
