---
"@moonshot-ai/kimi-code": minor
---

Add password authentication to `kimi ssh` connections. Run `kimi ssh passwd <name>` to save a password, or pass `--password` to `kimi ssh add`, `kimi ssh test`, or `kimi ssh connect` to enter one via a hidden prompt; `kimi ssh add` now probes the connection and prints the authentication status, and `kimi ssh list` shows each connection's auth method.
