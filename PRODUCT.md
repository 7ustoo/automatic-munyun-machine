# Product

## Register

product

## Platform

web

## Users

One user: the operator who runs Automatic Munyun Machine on their own Windows/macOS/Linux machine — a job seeker driving their own search, not a developer and not a team. They open the localhost dashboard to answer one question fast each morning ("what's worth looking at today?"), kick off scrapes, tune what gets searched, and check that the machine is actually healthy. The virtual assistant who eventually applies to jobs never touches this UI; they receive the tailored `.txt` batch. So the dashboard serves a single operator in full control, on their own hardware, offline-capable.

## Product Purpose

AMM is a local-first job-search assistant: it collects jobs from hiring.cafe (plus optional Greenhouse / Lever / Ashby feeds), ranks 50–200 of them against the operator's resume, and lays them out here strongest-match-first. The dashboard is the primary surface — it runs the scrape, explains every score (the `raw → filtered → fresh → above-floor → delivered` funnel and per-job `/why`), manages resume/profiles/searches, and wires up optional Telegram and Gmail delivery. Success is the operator trusting the ranked batch enough to hand the top of it straight to their VA without second-guessing it.

## Positioning

A job search that runs itself on your own machine and shows its work — no hosted backend, no black-box ranking, every match explained and every setting yours to change.

## Brand Personality

Confident and direct. A power tool for one person, not a toy and not enterprise software. It should read as a capable console that respects the operator's intelligence: plain language, honest about state, quick to act. The current GitHub-console restraint is the floor, not the ceiling — the design should lean **bolder and punchier** than it does today: stronger hierarchy, a more decisive accent, more visual confidence, while staying scannable. Energy through typography, contrast, and one committed accent — never through decoration.

## Anti-references

Not generic AI/SaaS slop: no gradient-text hero metrics, no identical icon-heading-text card grids repeated down the page, no decorative glassmorphism, nothing that would make a viewer say "AI made that." Equally, not timid or plain — "bolder" is a direction, so blandness is also a failure. Keep it a distinctive operator's console, not a template.

## Design Principles

Confidence at a glance — the operator opens the dashboard to make one fast decision; the strongest matches and true system health must read instantly, before any scrolling or clicking.

Show your work — ranking is never a black box. The score funnel, per-job `/why`, and missing-keyword chips are core to trust, not an afterthought; surface reasoning, don't hide it.

Honest about state — a failed 7am scrape, stale hiring.cafe auth, or a dead bot must be visible plainly and immediately. Never mask failure behind a spinner or an empty view.

Bold, not busy — push hierarchy, accent, and typographic energy hard, but every added weight must earn its place by making the batch faster to scan, not slower.

Offline and self-contained — no CDNs, external fonts, or network dependencies in the UI; the design must work fully offline on the operator's machine, the same constraint the code already holds.

## Accessibility & Inclusion

Target WCAG AA: body text ≥4.5:1 (both dark and light themes), visible `:focus-visible` indicators, full keyboard operability, and status never conveyed by color alone (pair every color band with a label, number, or icon — as the match meter already does). Honor `prefers-reduced-motion` for every animation, and respect the operator's OS light/dark preference on first paint.
