import { describe, expect, test } from "bun:test";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

describe("session artifact preview", () => {
	test("returns a byte-bounded preview without exposing a filesystem path", async () => {
		const manager = SessionManager.inMemory();
		const artifactId = await manager.saveArtifact("abcdefgh", "bash");
		expect(artifactId).toBe("0");
		expect(await manager.readArtifact(artifactId!, 4)).toEqual({
			id: "0",
			content: "abcd",
			size: 8,
			truncated: true,
		});
	});

	test("rejects IDs that could match arbitrary artifact filenames", async () => {
		const manager = SessionManager.inMemory();
		expect(manager.readArtifact("../0", 1024)).rejects.toThrow("Artifact ID must be numeric");
	});
});
