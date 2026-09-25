import { describe, expect, it } from "vitest";
import { fileChangeReason } from "../src/command-review.ts";

describe("fileChangeReason", () => {
	it.each([
		["rm -rf dist", "deletes files (rm)"],
		["cd src && /bin/rm old.ts", "deletes files (rm)"],
		["Remove-Item -Recurse build", "deletes files (remove-item)"],
		["del /q *.log", "deletes files (del)"],
		["mv a.txt b.txt", "moves or renames files (mv)"],
		["Rename-Item a.txt b.txt", "moves or renames files (rename-item)"],
		["cp -r src backup", "writes files (cp)"],
		["mkdir -p out/logs", "writes files (mkdir)"],
		['echo "hello" > notes.txt', "writes to a file (> notes.txt)"],
		["cat a.txt >> 'all logs.txt'", "writes to a file (> all logs.txt)"],
		["Get-Content a.txt | Set-Content b.txt", "writes files (set-content)"],
		["sed -i 's/a/b/' file.txt", "edits files in place (sed -i)"],
		["find . -name '*.tmp' -delete", "changes files found by find (-delete or -exec)"],
		["git checkout -- src/a.ts", "changes files with git checkout"],
		["git -C repo reset --hard", "changes files with git reset"],
		["npm install lodash", "changes dependencies (npm install)"],
		["ls | xargs rm", "deletes files (rm)"],
		["sudo chmod +x run.sh", "writes files (chmod)"],
	])("reviews %s", (command, reason) => {
		expect(fileChangeReason(command)).toBe(reason);
	});

	it.each([
		"ls -la",
		"cat package.json | grep version",
		"git status && git diff",
		"git log --oneline -5",
		"find . -name '*.ts'",
		"grep -rn TODO src 2>&1",
		"npm test > /dev/null",
		"Get-ChildItem | Out-Null",
		"echo done 2>$null",
		'node -e "console.log(1 >= 0)"',
	])("lets %s run without review", (command) => {
		expect(fileChangeReason(command)).toBeUndefined();
	});
});
