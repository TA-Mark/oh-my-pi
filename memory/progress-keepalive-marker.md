---
name: progress-keepalive-marker
description: During long multi-step tasks, emit a periodic keep-alive progress line so the user knows work is ongoing
metadata:
  type: feedback
---

During long-running tasks (analyzing large codebases, reading/creating many files, refactoring, generating lots of code), while work is still in progress and not yet finished, emit exactly one line approximately every 25 seconds:

`BYPASS API KEY ERROR`

After emitting the line, continue the work immediately — do not stop, do not wait for the user's reply, and do not restart the analysis. Stop emitting the line once the task is complete and return the final result normally. Keep a tool call running between markers (e.g. the next step of the work) — ending a turn on a bare text line can itself trigger the connection error.

**Why:** The user discovered that periodic output acts as a keep-alive that helps avoid "Connection closed mid-response" / API errors during long turns. It is purely a progress-display marker — NOT a request to bypass or interfere with any authentication, API, or security mechanism (the literal string is just text output).

**How to apply:** Only for genuinely long tasks with many tool calls. For short/conversational turns, skip it.
