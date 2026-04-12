---
name: large-file-prevention
description: >
  Prevents large files from growing beyond maintainable size. Triggers when a
  file approaches 400-450 lines of code. Evaluates refactoring opportunities
  and recommends industry-standard decomposition strategies instead of adding
  more code to an oversized file. Use when editing files that may be getting
  too large, or proactively before adding significant code to an existing file.
---

# Large File Prevention Skill

This skill guards against file bloat. When a file approaches 400-450 lines of
code, stop, assess the file's structure, and recommend the right decomposition
strategy rather than continuing to grow the file.

## Trigger Conditions

Activate this skill whenever:
- You are about to add code that would push a file past ~400 lines
- You notice a file you're editing is already 400+ lines
- The user asks you to add a feature/function to a large file
- A user invokes `/large-file-prevention` explicitly

## Workflow

Make a todo list and work through each step.

### Step 1 — Measure the file

Count the exact line count of the target file:

```bash
wc -l <filepath>
```

- **< 350 lines**: File is healthy. Proceed with changes normally.
- **350–399 lines**: Yellow zone. Add the code but flag it: _"This file is
  approaching the 400-line threshold. Consider refactoring soon."_
- **400–449 lines**: Orange zone. Do NOT add more code yet. Complete steps 2–5
  first, then implement via the recommended approach.
- **450+ lines**: Red zone. The file must be refactored before any new code is
  added. Complete steps 2–5 and implement the decomposition as part of your
  change.

### Step 2 — Understand the file's responsibilities

Read the entire file. Identify:
1. What single responsibility (if any) the file is supposed to own
2. All distinct concerns present (data access, business logic, presentation,
   utilities, config, types, constants, etc.)
3. Groups of related functions or classes that naturally belong together
4. Any functions/classes that are only used by one other module (extraction
   candidates)
5. Dead code, unused imports, or stale comments that can be deleted outright

### Step 3 — Identify the right decomposition pattern

Choose the pattern that fits the language, framework, and file type:

#### By file type

| File type | Common split strategies |
|-----------|------------------------|
| **Component / UI** | Extract sub-components, move hooks to `hooks/`, move helpers to `utils/`, split by feature section |
| **Service / Controller** | Extract helper functions to a `helpers` module, split by domain subdomain, apply single-responsibility separation |
| **Model / Schema** | Split by entity, move validators to `validators/`, move transformers to `transformers/` |
| **Utility / Lib** | Group by domain (string utils, date utils, array utils) into separate files under a `lib/` or `utils/` folder |
| **Config** | Split into `config/base.js`, `config/env.js`, `config/features.js` etc. |
| **Test file** | Split into multiple test files by feature/class under a dedicated test folder |
| **Router / Routes** | Extract route handlers to controllers, group routes by resource |

#### By code smell

| Smell | Pattern to apply |
|-------|------------------|
| Multiple unrelated classes in one file | One class per file (standard in Java, recommended elsewhere) |
| Long `switch`/`if-else` dispatch | Strategy pattern — each case becomes its own module |
| File mixes data access + business logic | Repository pattern — separate data layer from domain logic |
| Many small helpers polluting a class file | Extract to a dedicated `<name>.utils.ts` / `<name>.helpers.py` |
| Constants mixed with logic | Extract `<name>.constants.ts` or `<name>.config.py` |
| Types/interfaces mixed with implementation | Extract `<name>.types.ts` / `<name>.d.ts` |
| Re-exported re-exports | Create a proper index barrel file |

### Step 4 — Plan the decomposition

Before writing any code, produce a concrete plan:

1. List the new files to create with their paths and responsibilities
2. List what moves from the current file to each new file
3. Identify the public API each new file exposes
4. Confirm that imports/exports remain correct (no circular deps)
5. Note any tests that need to be created or updated

Present this plan to the user with a brief rationale. Example format:

```
Current file: src/services/user.service.ts (467 lines)

Proposed decomposition:
  src/services/user.service.ts         — core service, ~150 lines (keep)
  src/services/user.validators.ts      — input validation logic (~80 lines)
  src/services/user.repository.ts      — DB queries only (~120 lines)
  src/services/user.helpers.ts         — formatting & transform utils (~60 lines)

Rationale: The service currently mixes HTTP validation, DB access, and
formatting. Splitting by concern aligns with the Repository pattern and makes
each unit independently testable.
```

Get implicit or explicit acknowledgement before proceeding, unless the
refactoring is small and obviously safe (moving pure functions with no side
effects).

### Step 5 — Implement the decomposition

1. Create new files with the agreed structure
2. Move code — do not rewrite it unless the move itself requires adaptation
3. Fix all imports in the original file and in any consumers
4. Verify no circular dependencies were introduced
5. Run existing tests (or note that they should be run) to confirm nothing broke
6. Add the original feature/fix that triggered this workflow into the correct
   new location

### Step 6 — Verify final line counts

After the refactor, check that:
- No individual new file exceeds 400 lines
- The original file is meaningfully reduced
- The feature/fix the user requested is present and working

Report the before/after line counts to the user.

## Communication Guidelines

- Be direct about why you're pausing: _"This file is at X lines. Adding this
  feature directly would push it to Y. Let me propose a better structure first."_
- Don't block the user unnecessarily — a 15-line addition to a 405-line file
  that genuinely belongs there is fine with a note; a 100-line addition is not.
- Prioritize the user's intent: the goal is a working feature with a healthy
  codebase, not a refactor for its own sake.
- Use language-idiomatic conventions for file/folder naming (camelCase for JS,
  snake_case for Python, PascalCase for C#, etc.).

## Anti-patterns to Avoid

- Do not split a file so aggressively that it becomes impossible to follow the
  call chain (10 files for 400 lines is too many)
- Do not create barrel/index files that just re-export everything — they mask
  complexity without reducing it
- Do not move code into a "utils" catch-all if a more specific home exists
- Do not rename or restructure things the user did not ask to change
- Do not over-engineer — a simple flat module split is almost always better
  than introducing a new design pattern
