# Pipeline graph large parent — plan

## Milestones
- M0: Foundation — needs: none — est: 1h
- M1: Stream 1 — needs: M0 — est: 2h
- M2: Stream 2 — needs: M0 — est: 2h
- M3: Stream 3 — needs: M0 — est: 2h
- M4: Stream 4 — needs: M0 — est: 2h
- M5: Stream 5 — needs: M0 — est: 2h
- M6: Branch 6 — needs: M1 — est: 1h
- M7: Branch 7 — needs: M2 — est: 1h
- M8: Branch 8 — needs: M3 — est: 1h
- M9: Branch 9 — needs: M4 — est: 1h
- M10: Branch 10 — needs: M5 — est: 1h
- M11: Join 11 — needs: M1, M5 — est: 2h
- M12: Merge 12 — needs: M6, M7 — est: 2h
- M13: Merge 13 — needs: M8, M9 — est: 2h
- M14: Merge 14 — needs: M10 — est: 1h
- M15: Merge 15 — needs: M11 — est: 1h
- M16: Converge — needs: M12, M13, M14, M15 — est: 3h
- M17: Final 17 — needs: M16 — est: 1h
- M18: Final 18 — needs: M16 — est: 1h
- M19: Final 19 — needs: M16 — est: 1h
