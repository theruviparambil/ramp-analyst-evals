# Archived receipts

These runs are **not comparable** to the current ones in `out/`, and are kept
only so the earlier claims stay auditable.

| receipt | model | questions | why it is archived |
| --- | --- | --- | --- |
| `gpt-5.1-*` | openai:gpt-5.1 | 12 | predates the harder question set and the provenance fingerprint |
| `gpt-5.5/` | openai:gpt-5.5 | 12 | same |
| `claude-agent/` | bedrock:claude-sonnet-4-6 | 12 | same |

None of them carries a `harness.gradingHash`, because that field did not exist
when they were written. They were produced against 12 questions and a rubric
with several defects since fixed: entity names matched by bidirectional
substring, a money tolerance that scaled to plus or minus $94 on the largest
question, and precision graded as a bonus rather than a requirement on the
anomaly questions.

Re-grading those stored answers under the current rubric changes no verdict, so
the numbers they reported stand for what they measured. They simply measured a
different, easier suite.

Deleted rather than archived, because they were throwaway or superseded:
smoke runs (2 to 13 questions), the 18-question calibration pass, and the
single-sample 22-question runs. One of those, `v2-sonnet5`, reported 81.8% from
a run in which the Anthropic transport was capped at 1200 output tokens against
OpenAI's 4000, truncating answers mid-sentence after they had already reasoned
correctly. It carried the current `gradingHash`, since the fix was in the
transport rather than in a grading file, so it would have looked comparable
while being invalid. That is the strongest argument for not leaving stale
receipts lying next to current ones.
