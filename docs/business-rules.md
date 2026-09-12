# Business rules

## Question quota

Every confirmed initial workflow uses exactly 20 questions:

| Category | Count | Meaning |
| --- | ---: | --- |
| `recommendation` | 10 | Whether the site/service is recommended for a need |
| `selection` | 6 | Which option the model selects and why |
| `decision` | 4 | Decision-oriented comparisons or next steps |

The constants live in `src/business-rules.ts`. The UI, server validation and tests must derive their totals from those constants rather than duplicating a second quota.

## Workflow

1. Create or edit an unconfirmed project profile.
2. Generate or inspect the 20-question set.
3. Confirm and lock the set; the confirmed timestamp is the hand-off to diagnosis.
4. Run the initial diagnosis and retain each answer, response model, citation URLs, recommendation flag and official-citation flag.
5. Review a summary and create optimization tasks. A generated task is not an external publication.
6. Generate a body, then require a separate manual publish confirmation.
7. Start a monitoring round with the same question positions so the comparison remains meaningful.

## Evidence and rates

Recommendation rate and official-citation rate are separate metrics. A citation URL is evidence provenance, not proof that the page is authoritative or that the model response is correct. Synthetic demo evidence is deliberately labeled and must not be mixed with real customer results.

## Unsupported or future behavior

No public README, demo screen or API response may claim automatic publishing, complete multi-user authorization, default scheduling, multi-model selection or global monitoring unless the implementation and acceptance evidence exist. PDF is disabled in the synthetic demo because the demo does not persist or generate a report binary.
