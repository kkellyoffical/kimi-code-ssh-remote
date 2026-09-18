---
"@moonshot-ai/kimi-code": minor
---

Add the `kimi ssh host-key` command to show a remote's host key fingerprint and forget a stale key with `--forget`; `kimi ssh test` and `kimi ssh connect` now warn with a stored-vs-presented fingerprint comparison when the host key changes and offer to remove the old key interactively.
