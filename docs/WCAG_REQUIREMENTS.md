# Project Silk — WCAG 2.1 AA Technical Minimums

Per Section 0 Task 10 of the Project Silk brief, this document records the WCAG 2.1 AA accessibility requirements agreed in writing **before** any new ESOL frontend work begins.

The standards below are the floor, not the ceiling. Retrofitting accessibility is significantly more expensive than building it in — every component built from here on bakes these in by default.

> **Scope**: every learner-facing screen — D1 onboarding wizard, EsolLearnerHome, EsolSession, EsolVocab, RARPA Stage 5 review, plus any future learner-touching screens. Marketing pages and admin dashboards aim for the same minimums but are not gated on them at launch.

## Sign-off

| Role  | Name          | Date      | Status     |
| ----- | ------------- | --------- | ---------- |
| Owner | Joey          | _pending_ | Not signed |
| Dev   | Collins Sanni | _pending_ | Not signed |

This document must be checked in to the repo with both signatures before any new learner-facing screen is merged.

---

## 1. Colour contrast — 4.5:1 minimum for body text

WCAG 2.1 AA requires a 4.5:1 contrast ratio for body text (under 18 pt) and 3:1 for large text (18 pt+). All UI text — including placeholders, helper text, disabled states, and error messages — must meet 4.5:1 unless it falls into the large-text exemption.

**Approved Tailwind colour pairs** (pre-verified ≥ 4.5:1; see [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)):

| Context              | Background      | Text                | Ratio                                                                      |
| -------------------- | --------------- | ------------------- | -------------------------------------------------------------------------- |
| Primary body text    | `bg-white`      | `text-[#0B2343]`    | ~14:1                                                                      |
| Muted helper text    | `bg-white`      | `text-[#0B2343]/60` | ~6:1                                                                       |
| **Disabled text** ⚠ | `bg-white`      | `text-[#0B2343]/40` | ~3.8:1 — only valid on text ≥ 18 pt or as decoration                       |
| Primary CTA          | `bg-[#ff7c22]`  | `text-white`        | ~3.2:1 — **fails 4.5:1 for body**; only valid on text ≥ 18 pt / 14 pt bold |
| Error                | `bg-red-50`     | `text-red-700`      | ~7.2:1                                                                     |
| Success              | `bg-emerald-50` | `text-emerald-700`  | ~6.4:1                                                                     |

**Pattern**: every new screen runs the WebAIM contrast checker on each text-on-background pair before merge. The orange CTA combo passes only because button text is set to `font-bold text-base` (≥ 14 pt bold) — if a smaller weight is used the colour pair changes.

**Tailwind utilities to avoid for body text**: anything with opacity < `/60` over white, `text-gray-400` on white (3.0:1), `text-slate-500` on white (4.0:1).

**Enforcement**:

- Component `<MutedText>` wraps `text-[#0B2343]/60` — use instead of inventing new muted shades
- axe DevTools scan (see Definition of Done) catches violations at review time

---

## 2. ARIA labels on every form field and button

Every interactive element must have an accessible name. The accessible name comes from one of, in order of preference: visible `<label>` linked via `htmlFor`, `aria-labelledby`, `aria-label`, or visible button text content.

**React patterns**:

```tsx
// ✅ Preferred — visible label linked by htmlFor
<label htmlFor="firstname" className="...">First name</label>
<input id="firstname" name="firstname" ... />

// ✅ Acceptable — icon-only button with aria-label
<button aria-label="Close" className="min-h-11 min-w-11 ...">
  <X size={20} />
</button>

// ❌ Forbidden — input with no label of any kind
<input placeholder="Enter your name" />   // placeholder is NOT an accessible name

// ❌ Forbidden — div with onClick
<div onClick={...}>Submit</div>           // use <button>
```

**Shared component**: a `<Field label required>{children}</Field>` wrapper is in [`EsolOnboardingWizard.tsx`](../../amber-esol-mvp/src/modules/dashboard/components/onboarding/EsolOnboardingWizard.tsx) — every form input must use it (or be wrapped in an equivalent label-linked pattern).

**Enforcement**:

- ESLint plugin `eslint-plugin-jsx-a11y` rules `label-has-associated-control` and `interactive-supports-focus` block merges if violated
- axe DevTools `name-role-value` rule catches missed cases at review

---

## 3. Full keyboard navigation

Every interactive element must be reachable and operable via Tab/Shift+Tab/Enter/Space/Escape/Arrow keys. No `<div onClick>` interactive surfaces.

**Patterns**:

```tsx
// ✅ Native interactive element — tab order automatic
<button onClick={...} className="...">Submit</button>

// ✅ Custom interactive element — opt in explicitly
<div
  role="button"
  tabIndex={0}
  onClick={handle}
  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handle()}
>
```

**Visible focus ring — required Tailwind classes on every interactive element**:

```
focus-visible:outline-none
focus-visible:ring-2
focus-visible:ring-[#ff7c22]
focus-visible:ring-offset-2
```

`focus-visible:` (not `focus:`) so the ring shows on keyboard focus but not mouse clicks — UX standard.

**Modal trap**: Headless UI's `<Dialog>` handles focus trap and restore-on-close out of the box. Use it; do not roll your own modal.

**Enforcement**: manually navigate every new screen with Tab alone before requesting review. If something is unreachable or has no visible focus indicator, fix before merging.

---

## 4. Minimum 44×44 px touch targets

Tap targets must be at least 44 × 44 CSS pixels (WCAG 2.5.5 Level AAA — adopted as our floor because many ESOL learners use older phones with smaller screens). This applies to **all** interactive elements, including icon-only buttons and link chips.

**Tailwind utility**: `min-h-11 min-w-11` (11 × 4 px = 44 px) — apply to every `<button>` and clickable `<a>`.

For inline text links inside paragraphs (where 44 px height would break layout), increase the surrounding `line-height` to give 24 px line spacing — keeps the touch target hittable without disrupting reading flow.

**Patterns**:

```tsx
// ✅ Standard CTA — comfortably exceeds 44×44
<button className="min-h-11 px-7 py-3.5 ...">Continue</button>

// ✅ Icon-only — forced to 44×44 minimum
<button aria-label="Close" className="min-h-11 min-w-11 flex items-center justify-center">
  <X size={20} />
</button>

// ❌ Common mistake — visual 32×32 icon button
<button className="p-2"><X size={16} /></button>
```

---

## 5. Font-size toggle on learner screens

Learners have a control to scale the page font size. Implementation: a context provider stores the user's font-size preference (small/medium/large/x-large), persists to `localStorage`, and applies to `<html>` via the `style` attribute. All component styles use `rem` units so they scale.

**React pattern** (canonical implementation):

```tsx
// src/modules/dashboard/lib/contexts/FontSizeContext.tsx
type FontSize = "sm" | "md" | "lg" | "xl";
const SIZES: Record<FontSize, string> = {
  sm: "14px",
  md: "16px",
  lg: "18px",
  xl: "20px",
};

// Apply on mount and on change:
useEffect(() => {
  document.documentElement.style.fontSize = SIZES[size];
  localStorage.setItem("amber.font-size", size);
}, [size]);
```

**UI**: the toggle lives in the learner header next to the language selector — four buttons (A · A · A · A) with active state. Required on every ESOL learner screen.

**Tailwind constraint**: do not use absolute pixel units in classNames for learner-facing typography. Stick to `text-sm`, `text-base`, `text-lg`, etc. — those resolve to `rem` and scale with the root font-size. **Forbidden** for body text on learner screens: `text-[14px]`, `text-[15px]`, etc.

---

## 6. `<html lang="…">` set dynamically to the learner's L1

Screen readers pronounce text differently based on the document language. The `lang` attribute must reflect the language of the content being rendered — not just stay on `"en"`.

**Hook pattern**:

```tsx
// src/modules/dashboard/lib/utils/useDocumentLang.ts
export const useDocumentLang = (lang?: string | null) => {
  useEffect(() => {
    if (!lang) return;
    document.documentElement.lang = lang;
  }, [lang]);
};

// In the learner layout:
const learner = useCurrentLearner();
useDocumentLang(learner?.l1Language);
```

Acceptable values:

- `"en"` — English
- `"ar"` — Arabic
- `"so"` — Somali
- `"fa-AF"` — Dari (Afghan Persian)
- `"ps"` — Pashto
- `"zh-HK"` — Cantonese (Traditional Chinese)

The same hook updates `document.documentElement.dir` for RTL (see §7).

---

## 7. RTL support — Arabic, Dari, Pashto

The four MVP languages that use right-to-left script need full RTL layout: text direction, padding/margin/border sides mirrored, icons that imply direction (chevrons, arrows) flipped.

**Direction control**:

```tsx
// In useDocumentLang (extended)
const RTL_LANGUAGES = new Set(["ar", "fa-AF", "ps"]);
document.documentElement.dir = lang && RTL_LANGUAGES.has(lang) ? "rtl" : "ltr";
```

**Tailwind utilities — use logical properties**:

| Don't use            | Do use              | Notes                      |
| -------------------- | ------------------- | -------------------------- |
| `ml-4` / `mr-4`      | `ms-4` / `me-4`     | margin-inline-start/end    |
| `pl-2` / `pr-2`      | `ps-2` / `pe-2`     | padding-inline-start/end   |
| `border-l-2`         | `border-s-2`        | border-inline-start        |
| `rounded-l-md`       | `rounded-s-md`      | border-radius logical      |
| `left-0` / `right-0` | `start-0` / `end-0` | inset-inline-start/end     |
| `text-left`          | `text-start`        | follows document direction |

**Tailwind `rtl:` modifier** for things logical properties don't cover (icon flips):

```tsx
<ChevronRight className="rtl:rotate-180" />
```

**Verification per screen**: open the screen, run in browser console:

```js
document.documentElement.dir = "rtl";
```

Layout should remain coherent. If padding collapses or icons point the wrong way, fix before merging.

**Font fallback**: ensure the system font stack includes Arabic / Cantonese fallbacks. Tailwind default `font-sans` falls back to system UI fonts which handle this automatically; do not override with a Latin-only webfont on learner screens.

---

## Definition of Done

A learner-facing screen is **NOT complete** until all of the following pass:

1. **axe DevTools scan**: install <https://www.deque.com/axe/devtools/>, run on the rendered screen, report shows **zero critical** and **zero serious** violations. Moderate violations are reviewed case-by-case; cosmetic is acceptable to defer with a TODO.
2. **Keyboard navigation walkthrough**: Tab through the entire screen using only the keyboard. Every interactive element reachable, every focus state visible, no traps.
3. **Screen reader smoke test**: load the screen with VoiceOver (macOS, Cmd+F5) or NVDA (Windows, free). Read the page top to bottom. Confirm form fields announce their labels, buttons announce their purpose, headings form a coherent outline.
4. **Touch target measurement**: in DevTools, hover over every button/link and confirm the rendered box is ≥ 44 × 44 px.
5. **Font scale stress test**: trigger the in-app font-size toggle from small to x-large. Layout must remain usable at every level (no overlap, no hidden controls).
6. **RTL stress test** (only required for screens that will render in `ar`, `fa-AF`, or `ps`): toggle `document.documentElement.dir = "rtl"` in the console. Layout must remain coherent, directional icons must flip, text must read right-to-left.

A screen that fails any of the above blocks the PR merge.

## Tooling

- **axe DevTools** — <https://www.deque.com/axe/devtools/> — Chrome / Firefox / Edge extension. Required.
- **WebAIM Contrast Checker** — <https://webaim.org/resources/contrastchecker/> — quick contrast verification for new colour pairs.
- **NVDA** (Windows, free) — <https://www.nvaccess.org/> — for screen reader smoke tests on Windows.
- **VoiceOver** (macOS, built in) — Cmd+F5 to toggle.
- **Headless UI** — <https://headlessui.com> — already a project dep; use its `Dialog`, `Combobox`, `Listbox` rather than rolling custom accessible components.
- **eslint-plugin-jsx-a11y** — should be enabled in the frontend's ESLint config; if not, the dev's first task on the next frontend touch is to enable it.

## Out of scope (AAA targets, not gated for MVP)

- 7:1 contrast (AAA) — we hit it for body text incidentally but don't enforce
- Sign language interpretation (AAA)
- Live captioning (AAA — applies if/when we add real-time tutor video)
- Extended audio descriptions (AAA)

These may be addressed in v1.1 or later if a customer requires.
