---
name: nextjs-modules
description: "Creates and edits Next.js modules using the existing project conventions: hooks, services, dto requests/responses, types, validation, multilingual forms, and react-query flows. Use when adding or changing a module."
---

# Next.js Modules

Use this skill for any new module or module change in this codebase.

## Rule 1: learn the local pattern first
Before editing, inspect:
- the target module folder
- at least 2 hooks from different modules
- the related service files
- the dto/request and dto/response mappers
- the related `types` and `validation` files

Do not invent a new pattern if an existing module already solves the same problem.

## Rule 2: keep responsibilities separated
### Hooks
Hooks orchestrate UI behavior:
- `react-hook-form`
- `zod`
- `zodResolver`
- `react-query`
- `next/navigation`
- `next-intl`
- `sonner` toasts
- local pending/error state

Hooks should not contain API logic beyond calling services.
Hooks are allowed to coordinate state, query invalidation, routing, and form population/cleanup.

### React Hook Form + Zod
When a module uses forms:
- build schemas with Zod
- wire them through `useForm` + `zodResolver`
- define `defaultValues` explicitly
- keep all inputs controlled through react-hook-form (`Form`, `FormField`, `Controller`, or equivalent shadcn/RHF bindings)
- every user-editable field should be connected to RHF; avoid local uncontrolled form state unless it is a deliberate exception
- use `onInvalid` to surface validation errors
- keep form normalization in DTO request mappers, not inside UI components
- support localized schemas with `next-intl` translation functions
- extract the form UI into a separate component unless the form is very small and minimal
- prefer one reusable form component over mixing page logic and form markup

### next-intl + Zod
Validation messages must be translated when they are shown to users.
Use the existing pattern:
- pass `t` / `useTranslations(...)` into schema factory functions
- use translated `message` / `required_error` / `invalid_type_error`
- keep a fallback only for non-user-facing developer paths if truly needed

Examples in this codebase:
- `getBlogFormSchema(tValidation)`
- `getProjectFormSchema(tValidation)`
- `getCareerFormSchema(t)`
- `getResetPasswordSchema(t)`
- `getSignUpFormSchema(t)`


### Services
Services are UI-agnostic and should:
- call `backendApi`
- handle endpoint selection
- normalize or rethrow errors as `CustomError`
- never show toasts
- never navigate
- never touch component state

### DTOs
- `dto/requests/*` converts form/domain data into backend payloads
- `dto/responses/*` converts backend responses into frontend types
- keep mappers pure and deterministic
- never store backend response shapes directly in UI state
- use these files to bridge backend shape ↔ UI shape

### Types
- `types/*` defines frontend and backend response shapes
- keep multilingual/editable/view types separate
- model section/content variants explicitly

### Validation
- keep Zod schemas in `validation/schema`
- use localized schema builders when validation messages are translated

## Rule 3: follow the module layout
Prefer this structure when a module needs it:
- `components/`
- `hooks/`
- `services/`
- `dto/requests/`
- `dto/responses/`
- `types/`
- `validation/schema/`

## Rule 3.1: keep page files thin
`app/**/page.tsx` must stay minimal:
- one line to render a component, or
- one line to extract `slug` / `id` and pass it to a component

No extra logic, no data fetching, no transformations, no local helpers in page files.

## Rule 3.2: use shadcn/ui as the design system
- install and compose UI from shadcn/ui when building components
- prefer shadcn primitives over raw HTML controls for reusable UI
- always choose shadcn `Button` over a plain `<button>` when a button is needed
- use shadcn form controls (`Input`, `Textarea`, `Select`, `Dialog`, `Sheet`, `DropdownMenu`, etc.) unless there is a strong reason not to
- all visible form fields must be wired through shadcn `FormField` + `FormItem` + `FormControl` + `FormMessage` patterns
- mirror the form composition style used in `src/modules/blogs/components/blog-upload/index.tsx`
- keep styling aligned with the shadcn/TweakCN theme tokens defined in `app/[locale]/globals.css`
- do not introduce ad-hoc colors when an existing theme token exists

## Rule 4: preserve the working style
Use these patterns when appropriate:
- upload/edit forms: `useForm`, `zodResolver`, default values, `onInvalid`, `onSubmit`, `isPending`, `error`
- multilingual edit pages: `useQueries` across languages, `keepPreviousData`, merge into one editable type
- list pages: `useQuery` plus `select` mapper for normalized output
- success flow: reset form, invalidate relevant queries, redirect to dashboard/list page
- auth failure: on `401`, redirect to login when the action requires auth
- server validation failure: surface localized message from `CustomError`
- any text shown to the user must be translated with `next-intl`

## Rule 5: module-specific conventions to preserve
### Multilingual content
If a module already supports multiple languages:
- use `useLanguages()` as the source of truth for available languages
- initialize `defaultValues` from the languages list
- store content per language in arrays
- keep hidden language fields registered through RHF
- normalize/clean multilingual form values in the custom hook, not in the page or component
- merge editable data through a cast function in `dto/responses`
- follow this reusable sequence for multilingual forms:
  1. read languages from `useLanguages()`
  2. build `defaultValues` from the language list
  3. populate edit mode with `setValue` / `replace` / `reset` in the hook
  4. map display-only fields into the form shape
  5. clean and normalize on submit through DTO request mappers
  6. keep the component presentational
  7. no business logic in components: components should render, bind form fields, and emit user actions only

### Multilingual form cleanup in hooks
When editing multilingual forms:
- create the initial field arrays from `languages.map(...)`
- use `setValue` / `replace` / `reset` in the hook to populate edit data
- strip or convert display-only values before submit via DTO request mappers
- keep cleanup logic in the hook so the form component stays presentational

### Editable entities
For edit screens with sections/media/KPIs:
- separate new vs updated vs deleted items in the request payload when needed
- keep uploads as `FormData` only when the module already uses files
- preserve image/video deletion semantics used by the module

### Query keys
Keep query keys consistent with the module name and entity id/slug.
Invalidate the same family of keys after mutations.

## Rule 6: before changing a module
Check for:
- existing hooks/services with the same responsibility
- existing DTO mappers that can be reused
- existing translation keys and error messages
- existing query keys
- existing auth redirect behavior
- existing response nullability behavior

## Rule 7: if you are unsure
Stop and ask before:
- changing backend contract names
- changing DTO field meanings
- flattening multilingual structures
- introducing a new module architecture
- replacing a pattern used by nearby modules
- introducing any unlocalized user-facing text

## Practical checklist
When adding a module, ensure you created or updated:
- hook(s)
- service(s)
- request DTO(s)
- response DTO mapper(s)
- types
- validation schema
- translations if needed
- query invalidation and routing

When editing a module, ensure you preserved:
- folder structure
- naming style
- translation namespace style
- error handling behavior
- query key family
- multilingual mapping logic
- API contract shape

## Reference style seen in this codebase
Common libraries and patterns include:
- Next.js App Router
- shadcn/ui
- React Hook Form
- Zod
- TanStack React Query
- next-intl
- sonner
- backendApi + CustomError

Use the existing module as the source of truth.
