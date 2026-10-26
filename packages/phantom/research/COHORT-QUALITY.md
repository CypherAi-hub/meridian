# Saved forward collection quality

This optional, offline audit cross-checks the frozen forward journal against
its original quote-research baseline corpus. It never creates positions, retries
missing quotes, fits parameters, approves trading, or changes a cohort window.
Run it in a separate checkout while the deployed source remains frozen.

Python 3.12 and the standard library are sufficient. From `packages/phantom`:

```powershell
python research/capture_cohort_quality.py --port 8790 --reference earlier-forward-export.json --output quality-snapshot.json
python research/cohort_quality.py --input quality-snapshot.json --output quality-analysis.json
python -m unittest discover -s research -p 'test_*.py'
```

The optional `--reference` accepts an earlier export of this exact protocol and
checks that every previously saved record remains unchanged. Omit the argument
when no prior checkpoint exists. An explicitly malformed reference fails.

The capture helper uses four loopback GETs across three fixed paths, with HTTP
redirects refused and environment proxy routing disabled. It compares the
before/after protocol, complete journal and tagged inventory, checks the runtime
source, and retries at most three times. It removes unrelated runtime state and
quote route metadata. The raw API has a 10,000-row limit: reaching that limit
blocks a completeness claim. A changing or inconsistent snapshot is not saved.

The auditor independently checks original baseline identity, durable delivery
packet, per-mint first-probe selection, original valid quote projections, exact
cost limits, missing outcomes and retained checkpoints. Identical journal
retransmissions count once. Missing/no-complete-case estimates remain null rather
than masquerading as zero observed returns. Provider-reported network request
starts are distinguished from legacy or invocation-only lower bounds.

`CONSISTENT_SAVED_CORPUS` means consistency within these saved records. Ordering
uses strictly non-overlapping collection intervals and the frozen serial
collector; the API does not attest hidden database insertion order or monotonic
host clocks. Capture flags and hashes are local evidence, not cryptographic
provider attestation. Missing historical protocol fields prevent a complete
protocol-specific population count. Neither a positive complete-case result nor
any audit status establishes profitability or attainable execution. Every result
remains `UNPROVEN` with `liveApproved: false`.

The mutation tests use clearly synthetic fixtures. Test returns are not market
results. Runtime source and strategy eligibility are unaffected by this tool.
