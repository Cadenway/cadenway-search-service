---
name: wp-search-domain
description: "The data, rules, events and screens waypoint-search-service owns, taken from the mockup, the integration guide and the repositories document. Load it before naming, modeling or testing anything in this service."
---

# search-service domain

## What this service owns

The search index.

**Data**: A search index only: it is rebuilt from the other services and is the source of nothing.

**API**: Search by text and id, filtered by the user's rights.

**Events emitted**: none.

**Events consumed**: `task.*`, `list.*`, `space.*`, `doc.*`, `member.*`.

**External systems**: Meilisearch, on the VPS.

**Mockup screens**: The Ctrl + K command palette, the sidebar search.

## Rules this service guards

- Results never leak a private space or a task the user cannot open.
- The index can be rebuilt from scratch at any time.

## Notes

Created when database search is no longer enough.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). When the mockup and this skill disagree, the mockup wins and
this skill is corrected in the same change.
