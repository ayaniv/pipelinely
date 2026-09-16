# Wave-batch parent fixture — plan

Fixture plan for the wave-batch-run e2e suite. Wave 2 deliberately holds TWO
queued-and-unblocked milestones (M1, M2 — both `needs: M0`, which is merged),
which is the shape `fanout-parent` does not have and this feature needs.

## Milestones
- M0: Foundation — needs: none — est: 1h
- M1: Left rail — needs: M0 — est: 2h
- M2: Right rail — needs: M0 — est: 2h
- M3: Polish — needs: M1, M2 — est: 1h
