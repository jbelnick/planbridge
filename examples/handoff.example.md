---
schema_version: "1.0"
objective: Harden the example API authentication middleware.
project: example-api
non_goals:
  - Do not replace the auth provider.
  - Do not modify unrelated routing code.
likely_files:
  - src/auth/middleware.ts
  - tests/auth/middleware.test.ts
verification:
  - npm test
  - npm run build
stop_conditions:
  - A required secret or production credential is needed.
  - The repo HEAD no longer matches the approved plan.
---

## Objective
Harden the example API authentication middleware.

## Context
PlanBridge prepared a bounded context pack at commit
`0123456789abcdef0123456789abcdef01234567`. The planner identified
`src/auth/middleware.ts` as the main implementation surface and
`tests/auth/middleware.test.ts` as the regression-test surface.

## Constraints
Keep the change focused, preserve the current auth provider, and do not expose
secrets in logs, test output, or tool responses.

## Verification
- npm test
- npm run build

## Stop Conditions
- A required secret or production credential is needed.
- The repo HEAD no longer matches the approved plan.
