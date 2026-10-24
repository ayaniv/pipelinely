---
name: pipelinely-design-intake
description: Reads a design change (a Figma component node or a Linear design-change ticket), finds the matching code component, and works out what changed — the first stage of a design-system (ds) task. Runs inside the planning worker's own tab, before it plans; writes INTAKE.md and a design-intake TIMELINE line. Invoke directly inside the planning tab as `/pipelinely-design-intake`. Do NOT open a new tab for yourself.
---

# Cockpit Design Intake

The ds pipeline gives its first steps — read the change, find the code, work out what changed — to the same agent that then plans, so this is **not** dispatched into a tab of its own. `pipelinely-planning`'s design-change branch tells the planning worker to invoke it first thing; there is no `TASK.md`-writing or tab-opening step here, and it never writes `STATUS`: planning carries on afterwards and owns the hand-off.

## Step 1 — Read the change

Open the Figma node (or the Linear ticket's linked node) through the Figma MCP and record which component it is, which of its variants and states changed, and what changed in each (spacing, radius, colour tokens, type, states). If the Figma MCP is not authenticated, or the link does not point at a component node: report exactly what is missing and stop. Never write an intake from a guess.

## Step 2 — Find the code

Locate the component in the repo (for example `coreui/Button`) and the Storybook stories that cover it. If no component clearly matches, or several do, stop and ask the developer which one rather than picking.

## Step 3 — Work out what changed

Compare the Figma change with what the code does today, variant by variant, and write down each real difference with the values on both sides (for example `border radius 6px vs 8px`). Also list the apps that consume the component: the plan's `## Affected apps` section is built from this.

## Step 4 — Write `INTAKE.md` and report

1. Write `${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/INTAKE.md`: the component, its Figma node link, the code path, the variants that changed and the differences from Step 3, and the consuming apps.
2. Append the `TIMELINE` line: `echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) design-intake <summary>" >> ${TASKS_DIR:-$HOME/Dev/pipelinely/tasks}/<slug>/TIMELINE`, where `<summary>` reads like `Button: 2 variants changed, matched coreui/Button`.
3. Return to planning. Do not write `STATUS` and do not start dev.
