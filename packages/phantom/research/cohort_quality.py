"""Offline cross-check of a forward journal against its original baseline corpus.

No networking, database writes, fitting, parameter selection, retries or activation.
This checks saved local evidence, not provider authenticity or attainable returns.
"""
from __future__ import annotations

import argparse
from collections import Counter
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import statistics

from forward_cohort import Invalid as ForwardInvalid, WSOL, evaluate as evaluate_forward, quote_valid


class Invalid(ValueError):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def same(left, right):
    return canonical(left) == canonical(right)


def integer(value):
    if not isinstance(value, int) or isinstance(value, bool) or value < 0 or value > 2**53-1:
        raise Invalid('INVALID_CAPTURE_INTEGER')
    return value


def exact(value):
    value = Fraction(value)
    return {'numerator': str(value.numerator), 'denominator': str(value.denominator)}


def clean_quote(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise Invalid('QUOTE_MUST_BE_AN_OBJECT_OR_ABSENT')
    keys = ('inputMint', 'outputMint', 'inAmount', 'outAmount', 'minOutAmount', 'observedAt', 'requestedAt')
    return {key: value[key] for key in keys if key in value}


def _audit(data):
    export, rows, capture = data['cohort'], data['observations'], data['capture']
    report = evaluate_forward(export)
    if report['datasetStatus'] != 'VALIDATED_OFFLINE_RECORD_CONTRACT':
        raise Invalid('FORWARD_RECORD_CONTRACT_INVALID')
    p = export['protocol']
    cutoff = integer(export['exportedAt'])
    if capture['sourceVersion'] != p['runtimeSourceVersion'] or capture['configurationHash'] != p['configurationHash']:
        raise Invalid('CAPTURE_SOURCE_OR_PROTOCOL_MISMATCH')
    if capture['enrollmentStable'] is not True or capture['taggedInventoryStable'] is not True:
        raise Invalid('UNSTABLE_CAPTURE_RETRY_REQUIRED')
    if not isinstance(rows, list) or integer(capture['observationCount']) != len(rows):
        raise Invalid('CORPUS_ROW_COUNT_MISMATCH')
    limit = integer(capture['apiObservationLimit'])
    if not limit or len(rows) >= limit:
        raise Invalid('CORPUS_COVERAGE_UNPROVEN_AT_API_LIMIT')
    if any(not isinstance(r, dict) or not isinstance(r.get('id'), str) or not r['id'] for r in rows):
        raise Invalid('CORPUS_RECORD_MUST_HAVE_STRING_ID')
    if len({r['id'] for r in rows}) != len(rows):
        raise Invalid('DUPLICATE_CORPUS_RECORD_ID')
    delivery = export.get('probeDeliveryAudit')
    if not delivery or delivery.get('status') != 'COMPLETE':
        raise Invalid('TAGGED_DELIVERY_NOT_COMPLETE')

    tagged, untagged_in_window = [], []
    for row in rows:
        if row.get('phase') != 'BASELINE':
            continue
        completed, started, received = (integer(row[k]) for k in ('completedAt', 'startedAt', 'eventObservedAt'))
        if not received <= started <= completed:
            raise Invalid('CORPUS_BASELINE_CHRONOLOGY_INVALID')
        if completed > cutoff:
            continue
        if row.get('forwardExperimentId') == p['experimentId']:
            tagged.append(row)
        elif row.get('forwardExperimentId') is None and row.get('schedulingPolicy') == 'FORWARD_BUDGET_RESERVED_V3':
            if p['enrollmentStart'] <= received <= started <= completed <= p['enrollmentEnd']:
                untagged_in_window.append(row['id'])
    if untagged_in_window:
        raise Invalid('PROSPECTIVE_V3_BASELINE_WITHOUT_DELIVERY_TAG')
    if len(tagged) != delivery['taggedBaselineRows']:
        raise Invalid('TAGGED_CORPUS_COUNT_DIFFERS_FROM_NATIVE_INVENTORY')

    first = {}
    ordered = sorted(tagged, key=lambda r: (integer(r['startedAt']), r['id']))
    if any(b['startedAt'] <= a['completedAt'] for a, b in zip(ordered, ordered[1:])):
        raise Invalid('OVERLAPPING_BASELINES_CANNOT_ESTABLISH_FIRST_PROBE_ORDER')
    for row in ordered:
        probe = row['forwardProbe']
        if not isinstance(probe, dict):
            raise Invalid('DURABLE_PACKET_MUST_BE_AN_OBJECT')
        expected = {'id': row['id'], 'mint': row['mint'], 'signature': row['signature'], 'slot': row['slot'],
                    'eventObservedAt': row['eventObservedAt'], 'startedAt': row['startedAt'],
                    'completedAt': row['completedAt'], 'amountLamports': row['amountLamports']}
        if any(not same(probe.get(k), v) for k, v in expected.items()):
            raise Invalid('DURABLE_PACKET_DIFFERS_FROM_ORIGINAL_BASELINE')
        if not p['enrollmentStart'] <= probe['eventObservedAt'] <= probe['startedAt'] <= probe['completedAt'] <= p['enrollmentEnd']:
            raise Invalid('TAGGED_PROBE_OUTSIDE_PROSPECTIVE_WINDOW')
        for side in ('buy', 'sell'):
            if not same(clean_quote(probe.get(side)), clean_quote(row.get(side))):
                raise Invalid('DURABLE_PACKET_QUOTE_DIFFERS_FROM_ORIGINAL_BASELINE')
        first.setdefault(row['mint'], row)
    enrollments = {r['mint']: r for r in export['records'] if r['phase'] == 'ENROLLMENT'}
    if set(first) != set(enrollments):
        raise Invalid('RAW_CORPUS_AND_ENROLLED_MINTS_DIFFER')
    if len(first) != delivery['distinctTaggedMints']:
        raise Invalid('DISTINCT_TAGGED_MINT_COUNT_MISMATCH')

    lags, costs, discounts, floor_matches = [], [], [], Counter()
    for mint, row in first.items():
        e, probe = enrollments[mint], row['forwardProbe']
        d = e['data']
        mapping = {'probeId': 'id', 'signature': 'signature', 'slot': 'slot', 'protocol': 'protocol', 'kind': 'kind',
                   'eventObservedAt': 'eventObservedAt', 'probeStartedAt': 'startedAt',
                   'probeCompletedAt': 'completedAt', 'amountLamports': 'amountLamports'}
        if d['probeId'] != row['id']:
            raise Invalid('FIRST_PROBE_DISPLACED_BY_LATER_PROBE')
        if any(not same(d.get(k), probe.get(v)) for k, v in mapping.items()):
            raise Invalid('ENROLLMENT_METADATA_DIFFERS_FROM_FIRST_RAW_PROBE')
        if e['at'] < probe['completedAt'] or d['decisionAt'] != e['at']:
            raise Invalid('DECISION_PRECEDES_COMPLETED_PROBE')
        lags.append(e['at'] - probe['completedAt'])
        # A valid original quote cannot be removed to manufacture an unavailable
        # probe and suppress an otherwise eligible enrollment. Validate the same
        # sequential quote projections as the frozen collector before requiring
        # their journal presence; invalid originals may legitimately be omitted.
        valid_sides = set()
        try:
            qty = quote_valid(probe.get('buy'), WSOL, mint, p['amountLamports'],
                              probe['completedAt'], probe['startedAt'], p['maxQuoteAgeMs'], p['slippageBps'])
            valid_sides.add('buy')
            quote_valid(probe.get('sell'), mint, WSOL, str(qty), probe['completedAt'],
                        probe['buy']['observedAt'], p['maxQuoteAgeMs'], p['slippageBps'])
            valid_sides.add('sell')
        except (ForwardInvalid, KeyError, TypeError, ValueError, OverflowError):
            pass
        for side, recorded in (('buy', 'probeBuy'), ('sell', 'probeSell')):
            if (recorded in d or side in valid_sides) and not same(clean_quote(d.get(recorded)), clean_quote(probe.get(side))):
                raise Invalid('ENROLLMENT_QUOTE_DIFFERS_FROM_FIRST_RAW_PROBE')
        if not d['admitted']:
            continue
        if e['at'] - probe['completedAt'] > p['maxQuoteAgeMs']:
            raise Invalid('ADMITTED_PROBE_WAS_NOT_FRESH_AT_DECISION')
        amount, fee = int(probe['amountLamports']), int(p['networkFeePerLegLamports'])
        cost = Fraction((amount+2*fee-int(probe['sell']['minOutAmount']))*10000, amount)
        if cost > p['maximumProbeCostBps']:
            raise Invalid('RAW_EXACT_COST_EXCEEDS_FROZEN_CAP')
        costs.append(exact(cost))
        for side in ('buy', 'sell'):
            q = probe[side]
            output, minimum = int(q['outAmount']), int(q['minOutAmount'])
            configured = output*(10000-p['slippageBps'])//10000
            floor_matches['atConfiguredFloor' if minimum == configured else 'aboveConfiguredFloor'] += 1
            discounts.append(Fraction((output-minimum)*10000, output))

    reference = data.get('referenceCohort')
    retained = None
    if 'referenceCohort' in data:
        if not isinstance(reference, dict) or not isinstance(reference.get('protocol'), dict) or not isinstance(reference.get('records'), list):
            raise Invalid('REFERENCE_COHORT_SCHEMA_INVALID')
        if not same(reference['protocol'], p):
            raise Invalid('REFERENCE_PROTOCOL_CHANGED')
        current = {r['id']: r for r in export['records']}
        if any(not same(current.get(r['id']), r) for r in reference['records']):
            raise Invalid('PREVIOUSLY_SAVED_RECORD_CHANGED_OR_DISAPPEARED')
        retained = len(reference['records'])

    timing = {'ENTRY': [], 'EXIT': []}
    failures = []
    requests = {(r['mint'], r['phase'].split('_')[0]): r for r in export['records']
                if r['phase'] in ('ENTRY_REQUEST', 'EXIT_REQUEST')}
    # The frozen evaluator accepts identical retransmissions once, so the
    # orthogonal timing summaries must count those same logical records once.
    for row in {r['id']: r for r in export['records']}.values():
        if row['phase'] not in ('ENTRY_RESULT', 'EXIT_RESULT'):
            continue
        d, phase = row['data'], row['phase'].split('_')[0]
        if d['status'] == 'QUOTED':
            q = d['timedQuote']
            evidence = q.get('timingEvidence', 'LEGACY_REQUEST_TIME_UNPROVEN')
            reported = evidence == 'PROVIDER_REPORTED_REQUEST_START'
            timing[phase].append({'recordId': row['id'], 'mint': row['mint'],
                                 'completionDelayMs': q['receivedAt']-d['dueAt'],
                                 'reportedNetworkStart': q.get('requestedAt') if reported else None,
                                 'legacyOrInvocationTimeLowerBound': q.get('requestedAt', q.get('providerInvocationAt')) if not reported else None,
                                 'networkStartEvidence': evidence,
                                 'queueDelayMs': q['requestedAt']-q['providerInvocationAt']
                                     if reported and q.get('requestedAt') is not None and q.get('providerInvocationAt') is not None else None})
        else:
            request = requests.get((row['mint'], phase))
            deadline = d.get('deadlineAt', request['data']['deadlineAt'] if request else None)
            failures.append({'recordId': row['id'], 'mint': row['mint'],
                             'phase': phase, 'status': d['status'], 'error': d.get('error'),
                             'observedBeforeDeadline': row['at'] <= deadline if deadline is not None else None,
                             'exactProviderFailureCause': 'UNIDENTIFIABLE_FROM_GENERIC_RECORDED_ERROR'})
    entered = report['allEnteredConservativeBound']
    complete = report['onTimeCompleteCase']
    bound = int(entered['netLamportsSum']) if entered['count'] else None
    complete_net = int(complete['netLamportsSum']) if complete['count'] else None
    missing = report['coverage']['validFreshEntries']-report['coverage']['onTimeExits']
    candidate_fields = list(report['candidateGates'])
    return {'auditStatus': 'CONSISTENT_SAVED_CORPUS', 'scope': 'OFFLINE_FIRST_PROBE_AND_COLLECTION_QUALITY',
            'profitabilityConclusion': 'UNPROVEN', 'liveApproved': False, 'configurationHash': p['configurationHash'],
            'runtimeSourceVersion': p['runtimeSourceVersion'], 'exportedAt': cutoff,
            'inputSha256': digest(data), 'originalObservationRows': len(rows),
            'taggedBaselineRows': len(tagged), 'distinctFirstProbes': len(first), 'retainedReferenceRecords': retained,
            'decisionDelayAfterProbeMsMedian': statistics.median(lags) if lags else None,
            'admittedExactProbeCostsBps': costs,
            'observedMinimumOutputDiscountsBps': {'minimum': exact(min(discounts)) if discounts else None,
                 'maximum': exact(max(discounts)) if discounts else None, 'floorCounts': dict(floor_matches),
                 'interpretation': 'Actual quote thresholds, not an executable rescaling or an attribution of venue friction versus temporal drift.'},
            'quoteTiming': timing, 'unavailableObservations': failures,
            'missingOutcomeSensitivity': {'entered': report['coverage']['validFreshEntries'],
                 'onTimeComplete': report['coverage']['onTimeExits'], 'unobservedExits': missing,
                 'completeCaseCount': complete['count'],
                 'completeCaseQuotedNetLamports': str(complete_net) if complete_net is not None else None,
                 'allEnteredZeroProceedsBoundLamports': str(bound) if bound is not None else None,
                 'unobservedAggregateProceedsForBreakEvenLamports': str(max(0, -bound)) if missing else None,
                 'unobservedAggregateProceedsForStrictlyPositiveLamports': str(max(0, 1-bound)) if missing else None,
                 'interpretation': 'Algebraic sensitivity only. Missing quotes are not zero observed returns, actual liquidation values, or realized losses; do not retry/backfill them to improve the frozen experiment.'},
            'forwardContractClassification': report['classification'], 'candidateGates': {k: report['candidateGates'][k] for k in candidate_fields},
            'limitations': ['Saved-corpus consistency cannot attest provider authenticity or complete chain/launch coverage.',
                 'Native inventory counts are cross-checked against a stable API corpus below its truncation limit.',
                 'First-probe chronology uses non-overlapping saved collection intervals and the frozen serial collector; database insertion order and monotonic host clocks are not attested by this API.',
                 'This read-only audit never changes source, eligibility, timing, risk rules or the active cohort window.',
                 'Small sequential samples and complete-case selection cannot establish profitability.']}


def audit(data):
    try:
        return _audit(data)
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        return {'auditStatus': 'INVALID_OR_INCOMPLETE_SAVED_CORPUS', 'scope': 'OFFLINE_FIRST_PROBE_AND_COLLECTION_QUALITY',
                'errors': [str(error)], 'profitabilityConclusion': 'UNPROVEN', 'liveApproved': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = audit(json.loads(args.input.read_text(encoding='utf-8')))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'auditStatus': result['auditStatus'], 'output': str(args.output), 'profitabilityConclusion': 'UNPROVEN'}))
    return 0 if result['auditStatus'] == 'CONSISTENT_SAVED_CORPUS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
