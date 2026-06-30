# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Email **support@trys.ai** with:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- any suggested fix.

We aim to acknowledge reports within a few business days and will keep you updated
as we investigate and ship a fix. Responsible disclosure is appreciated — please
give us a reasonable window to release a patch before any public disclosure.

## Scope notes

- Termany is **BYOK**: model-provider API keys are entered by the user and stored
  locally in `~/.termany/termany.db`. They are never committed to this repo or sent
  anywhere other than the provider the user configured.
- The desktop app runs a local PTY/API server bound to `localhost`. Reports about
  that surface (e.g. unauthenticated access, command injection) are in scope.
