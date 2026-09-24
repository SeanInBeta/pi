import { describe, expect, it } from "vitest";
import { FILE_CHANGE_KIND, isFileChangeMetadata } from "../src/file-change.ts";

describe("isFileChangeMetadata", () => {
	it("accepts only complete file change metadata", () => {
		expect(isFileChangeMetadata({ kind: FILE_CHANGE_KIND, tool: "write", path: "/a", content: "" })).toBe(true);
		expect(isFileChangeMetadata({ kind: FILE_CHANGE_KIND, tool: "bash", path: "/a", content: "" })).toBe(false);
		expect(isFileChangeMetadata({ kind: "other", tool: "edit", path: "/a", content: "" })).toBe(false);
		expect(isFileChangeMetadata({ kind: FILE_CHANGE_KIND, tool: "edit", path: "/a" })).toBe(false);
		expect(isFileChangeMetadata(undefined)).toBe(false);
	});
});
