---
description: Review a Next.js module diff for exact adherence to the existing module pattern
argument-hint: "<module-name>"
---
Review the module named `$1` under `src/modules/` using the `strict-module-reviewer` persona.

Resolve the path as `src/modules/$1` and inspect all changed and related files in detail:
- `git status --short -- src/modules/$1`
- `git diff -- src/modules/$1`
- `git diff --cached -- src/modules/$1` if relevant

Apply the `nextjs-modules` skill and audit **category by category**:
- components
- hooks
- services
- dto requests / responses
- types
- validation
- utils / casting helpers
- query keys and invalidation
- translations / localized validation
- page thinness and routing

Do not skip categories; compare each one against the existing module pattern before moving on.

Return only:
- PASS or FAIL
- module path
- grouped exact mismatches, if any
- one-line verdict
