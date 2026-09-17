---
"@moonshot-ai/ssh-remote": minor
---

Add password authentication for SSH connections: batch-mode key auth is tried first, a provided or saved password is retried through SSH_ASKPASS on auth failure, failures surface a structured needs-password error, and passwords can optionally be saved and cleared in a private secrets.json next to connections.json.
