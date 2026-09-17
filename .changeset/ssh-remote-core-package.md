---
"@moonshot-ai/ssh-remote": minor
---

Add the internal ssh-remote package for SSH-based remote connections: it stores connection profiles under KIMI_CODE_HOME, manages the system ssh/scp lifecycle with ControlMaster reuse, bootstraps kimi web on the remote host, and keeps an auto-reconnecting local port-forward tunnel to it.
