# Tech Design Template

**Author:**
**Date:**
**Tag Stakeholders:**

### Summary

2–4 sentences: what this plan does and why — pinned at the top of the
dashboard's Plan tab.

### Feature Overview

Explain the feature briefly

### Effort Estimation

### Open Questions

### Timetable

Plan what you are going to do each day, including when it will be in qa, cr, plan an extra day for fixes for each milestone

### Resources

| | |
|---|---|
| **Brief** | |
| **Figma** | |
| **Jira Ticket** | |
| **Slack Channel** | |
| **Branch name** | |
| **PR links** | |
| **Deploy command** | |

### Audiance

Who's going to see the feature

### AB Test / Rollout

| | |
|---|---|
| **Feature Gates** | |
| **Experiment** | |
| **Variants** | |

### Backend integration

| Request | Payload | Response |
|---|---|---|
| | | |
| | | |
| | | |

### UI Description

Explain in your own words what are you going to do.

### Milestones

Split the UI Description into a deliverable milestones

### Current State

Describe how this feature is working today, the current logic. to make sure all is covered.

### Components

We don't like renames, so try to think ahead whats the components you're going to add to the app, their hierarchy, the folder structure, etc

### Dev QA Cases

*Try to think about test cases for the feature. What should be tested etc. example: check that modal is shown after sending an invoice, check that modal is shown after sending an invoice from an automation.*

| **Scenario** | **Expected** | **Notes** |
|---|---|---|
| | | |
| | | |
| | | |
| | | |
| | | |

### Monitor error tracking

| **Milestone** | **What can go wrong** | **How to monitor** |
|---|---|---|
| **M0** | | |
| **M1** | | |
| **M1** | | |
| **M2** | | |

### System tests

### Analytics Data

| **Event Name** | **Event Props** | **When to show** | **Done** |
|---|---|---|---|
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |
| | | | |

### QA notes

### Rollout Plan

### Dependencies & Risks

**Plan the milestone that we will get unknowns and deps as fast as possible.**

- [ ] This feature involves research on new technology (etc - working with videos, frameworks etc)
- [ ] This feature involves research on unfamiliar areas (regions in code you don't know)
- [ ] This feature involves working with legacy code
- [ ] This feature involves processes that are new to the developer - tests, lint
- [ ] Is it an API? is it changing or create boundary.
- [ ] This feature involves working with new people / cross teams

### Calendar deps

- [ ] During dev phase of this feature, do you expect to perform unrelated tasks - hotfixes, alerts, help other team members.
- [ ] During dev phase of this feature, do you expect time off due to private reasons.

**IMPORTANT!** If you marked anything, take this in mind while giving a time estimation.

### Time Estimations

day = look for free time in the calendar
as for estimate 1 day ~ 5 working hours
Time estimations for a task should be the total time, end-to-end, it takes from dev to production including:

| **What** | **M1** | **M2** | **M3** | **M4** |
|---|---|---|---|---|
| Dev time | | | | |
| 20% dev buffer | | | | |
| 10% Dev QA | | | | |
| Tests | | | | |
| Monitors | | | | |
| — | | | | |
| 20% Code Review Fixes | | | | |
| 20% Data review fixes | | | | |
| Level of confidence | | | | |
| | | | | |
| | | | | |
| Sum M1-4 | | | | |
| Self QA E2E | | | | |
| 10% PM Review Fixes | | | | |
| 20% QA Review Fixes | | | | |
| 5% E2E Fixes | | | | |
| 15% Dependancies & Risk | | | | |
| **Total** | | | | |

### Deployment checklist

- [ ] Done task
- [ ] QA approved
- [ ] E2E passed
- [ ] Tests passes
- [ ] Analytics events approved
- [ ] Final sync with PM

### Keep tracking and iterating the process

Maintain the Task Breakdown in a table where you can not only see the estimation but also the actual time it took. This will help you know your pace.
