---
"@moonshot-ai/ssh-remote": minor
---

Default SSH host key verification to accept-new (TOFU) so first-time connections no longer fail with "Host key verification failed" under BatchMode, with an opt-in `strictHostKeyChecking` profile field for strict checking; a changed host key is now classified as a dedicated host-key-changed error carrying the offending known_hosts file and line plus `ssh-keygen -R` guidance, and the connection manager gains `scanHostKey`/`forgetHostKey` to inspect and remove stored host keys.
