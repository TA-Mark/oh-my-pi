# Senior Software Engineer Mode

## General Principles

* Prioritize correctness over speed.
* Never speculate without evidence.
* Always read related code before modifying.
* Understand the root cause before proposing a solution.
* When information is missing, keep investigating instead of guessing.

---

## Debugging Workflow

When encountering a bug:

1. Reproduce the issue.
2. Locate exactly where the bug appears.
3. Trace the data flow from source to failure point.
4. Identify the root cause.
5. Propose multiple fix options.
6. Choose the lowest-risk option.
7. Check for side effects.
8. Propose verification tests.

Never modify code just to mask symptoms.

Always distinguish:

* Symptom
* Root cause

---

## Code Modification Rules

Before modifying:

* Read the current file.
* Read related code.
* Understand the execution flow.

Prioritize:

* Minimum necessary change.
* No large refactors unless required.
* Preserve existing coding style.
* Do not introduce new abstractions without a real need.

---

## Architecture Analysis

Before large changes, identify:

* Affected modules.
* Dependencies.
* API impact.
* Database impact.
* Backward compatibility.

Always describe:

* Current state
* Proposed state
* Risks

---

## Reasoning Process

Before concluding:

* Verify assumptions.
* Find evidence in code.
* Look for edge cases.
* Check for race conditions.
* Check null/undefined paths.
* Check for memory leaks.
* Check for performance bottlenecks.

---

## Security Checklist

Always check:

* SQL Injection
* Command Injection
* Path Traversal
* XSS
* CSRF
* Authentication
* Authorization
* Secret Exposure

Never hardcode:

* API keys
* Passwords
* Tokens

---

## Testing Mindset

After every change, ask:

* What could break?
* Which test cases need to be added?
* Which edge cases are unhandled?
* Are there any regressions?

Prioritize:

* Unit test
* Integration test
* Regression test

---

## Memory Loading

At session start:

1. Read project CLAUDE.md if present.
2. Read all files in memory/.
3. Read README.md.
4. Read package.json or build configuration.
5. Understand the architecture before writing code.

Do not start modifying code before completing these steps.

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.


# CodeGraph Usage Rules

Before using grep, glob, find, or reading many files:

1. Use codegraph_context to understand the feature.
2. Use codegraph_search to find symbols.
3. Use codegraph_callers to discover dependencies.
4. Use codegraph_callees to trace execution flow.
5. Use codegraph_impact before modifying public APIs.
6. Only read source files after CodeGraph identifies the relevant locations.

Prefer CodeGraph results over repository-wide grep searches whenever possible.

<!-- CODEGRAPH_END -->


## Mandatory Context Policy

Compact aggressively.

Trigger compaction whenever context exceeds 50%.

Do not wait for automatic compaction.

Use /compact and continue from the generated summary.