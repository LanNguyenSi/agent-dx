# Carry-forward review (illustrative manual comparison)

- Reviewer: orchestrator
- From baseline: baseline-demo / r1
- To baseline: baseline-demo / r2
- Criterion: P1-AC1
- Original records: [r1 baseline](../00-goal.md)
- Revised records: [r2 baseline](../revised-00-goal.md)
- Producer artifact: [attempt-01](../results/attempt-01.json)
- Artifact SHA-256: d649399b8c34a052845f4138ccd2a91348517a12244c24a4b4d8b991ded0782c
- Repository: demo/repository
- Checked revision: abc123+dirty:sha256:example
- Working directory: packages/demo
- Applied check: npm test
- Expected outcome: exit 0
- Method: compare the P1-AC1 records byte for byte and the producer artifact's baseline, criteria, repository, checked revision including dirty state, working directory, command, and outcome with the r2 task's unchanged requirements.
- Reasoned result: carry forward P1-AC1 only; its record, check and repository state are unchanged and the referenced attempt exited 0 without abort. P1-AC2 changed and its prior manual review remains invalidated pending rerun.
