# User Study Survey Instrument

## Purpose

This instrument measures whether the blockchain trust framework (milestone escrow,
reputation, verifiable identity, dispute resolution) changes **perceived trust and
willingness to contribute** in a crowdfunding context, compared to a traditional
platform.

## Administration

- **Platform**: Google Forms (paste each question verbatim; use 1–5 Likert radio
  buttons, "Linear scale" for Q10, long-answer text for the open items).
- **Before/after design**: the participant answers the **Trust–Before** block (Q1–Q6)
  *before* using the dApp, and the **Trust–After** block (Q7–Q12) *after* a scripted
  5-minute walkthrough. Q1–Q6 and Q7–Q12 are item-for-item identical except the
  referent ("this platform" vs "the prototype") so the paired difference isolates the
  effect of using the system.
- **SUS block** (Q13–Q22) is administered once, after the walkthrough. Standard SUS
  wording, unmodified.
- **Analysis**: `analysis.py` in this folder.

## Scales

- Likert items use a 1–5 scale. For analysis, recode **higher = more agreement**, so
  negatively-worded items are reversed before averaging.
- The SUS uses the standard odd/even item structure; `analysis.py` handles the
  reverse-scoring of odd items.

---

## Part A — Perceived Trust (BEFORE using the prototype)

_Intro shown to all participants: "You are about to evaluate a crowdfunding platform.
Please answer based on your general experience with crowdfunding today."_

1. I believe crowdfunding platforms use funds the way creators promise. (Likert 1–5)
2. I trust that campaign creators are who they say they are. (Likert 1–5)
3. I believe milestones on a campaign are usually completed as described. (Likert 1–5)
4. I have confidence that if a campaign fails, backers get their money back. (Likert 1–5)
5. I feel that disputes between creators and backers are resolved fairly. (Likert 1–5)
6. Overall, I trust crowdfunding platforms to protect backers' funds. (Likert 1–5)

---

## Part B — Perceived Trust (AFTER using the prototype)

_Intro: "Now that you have used the prototype, please answer the same statements about
**the prototype**."_

7. I believe crowdfunding platforms use funds the way creators promise. (Likert 1–5)
8. I trust that campaign creators are who they say they are. (Likert 1–5)
9. I believe milestones on a campaign are usually completed as described. (Likert 1–5)
10. I have confidence that if a campaign fails, backers get their money back. (Likert 1–5)
11. I feel that disputes between creators and backers are resolved fairly. (Likert 1–5)
12. Overall, I trust crowdfunding platforms to protect backers' funds. (Likert 1–5)

---

## Part C — System Usability Scale (SUS)

_Intro: "Please rate your agreement with each statement on a 1–5 scale."_

13. I would like to use this system frequently. (SUS)
14. I found the system unnecessarily complex. (SUS, reverse)
15. I thought the system was easy to use. (SUS)
16. I think I would need technical support to use this system. (SUS, reverse)
17. I found the various features in this system were well integrated. (SUS)
18. I thought there was too much inconsistency in this system. (SUS, reverse)
19. I can imagine most people would learn to use this system very quickly. (SUS)
20. I found the system too cumbersome to use. (SUS, reverse)
21. I felt confident using the system. (SUS)
22. I had to learn a lot before I could get going with this system. (SUS, reverse)

---

## Part D — Willingness to Contribute & Open Feedback

23. How large a contribution (in your currency) would you consider making to a campaign
    on this platform? (open numeric)
24. Would you use this platform for a real campaign you care about? (Likert 1–5)
25. What about this platform increased your trust? (open text)
26. What about this platform decreased your trust? (open text)
27. What is the single biggest trust concern this platform does NOT solve? (open text)

---

## Notes for the researcher

- Show the same 5-minute demo script to every participant so the "after" measurement is
  comparable. (`docs/DEMO_SCRIPT.md`)
- Do not tell participants the study is testing whether the system works; that biases
  the trust items toward agreement.
- Record a participant ID that is a **random code, not a name**, to keep responses
  pseudonymous. This study collects no PII.
- Recruit at least 30 participants for the paired before/after test to have a usable
  sample, and record `n` honestly in the report.

---

## Column mapping for `analysis.py`

`analysis.py` reads a CSV whose columns use these names. Note that the "after" trust
block reuses question numbers 1–6 (it asks the *same* six statements again, just about
the prototype), so "after" is distinguished by the `trust_after_` prefix, not by a
higher question number.

| Instrument question | CSV column |
|---|---|
| Q1–Q6 (trust, before) | `trust_before_q1` … `trust_before_q6` |
| Q7–Q12 (trust, after) | `trust_after_q1` … `trust_after_q6` |
| Q13–Q22 (SUS) | `sus_q1` … `sus_q10` |
| Q23 (contribution amount) | `contribution_amount` |
| Q24 (would use for real) | `would_use_real_campaign` |
| Q25–Q27 (open text) | `open_increased_trust`, `open_decreased_trust`, `open_remaining_concern` |
| — (provenance flag) | `is_sample` — set `false` only for genuine responses |

If the `is_sample` column is absent, `analysis.py` falls back to inspecting the filename
for "SAMPLE". If in doubt the data is treated as sample and the output is stamped.

---

## IMPORTANT — status of the study data

**No real participant data has been collected.** This project is a prototype and no
user study was run. The file `sample_responses_SAMPLE_ONLY.csv` next to this document
contains **synthetic responses generated purely to exercise and validate the analysis
pipeline**. Any SUS score, trust-before/after comparison, or chart produced from that
file describes generated numbers and **must never be reported as a finding**. To report
real results, replace that CSV with genuine responses, keep the same column names, and
re-run `analysis.py`.