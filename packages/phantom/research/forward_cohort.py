"""Independent, offline evaluation of frozen PHANTOM forward quote cohorts.

No networking, trading, ledger access, fitting, or rule activation. Synthetic tests
verify the evaluator, not a profitable strategy. Quote observations are not fills.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import random
import re

SCOPE = 'FORWARD_QUOTE_COHORT_NOT_TRADES'
WSOL = 'So11111111111111111111111111111111111111112'
SAFE = 2**53 - 1
U64 = 2**64 - 1
PHASES = ('ENROLLMENT', 'ENTRY_REQUEST', 'ENTRY_RESULT', 'EXIT_REQUEST', 'EXIT_RESULT')
B58 = r'[1-9A-HJ-NP-Za-km-z]'
SAFE_QUOTE_ERRORS = {'FORWARD_INVALID_AMOUNT', 'FORWARD_AMOUNT_OUTSIDE_U64',
    'FORWARD_QUOTE_IDENTITY_SIZE_OR_TIMING_INVALID', 'FORWARD_PROVIDER_REQUEST_TIMING_INVALID',
    'FORWARD_CLOCK_REGRESSED', 'FORWARD_RESPONSE_AFTER_DEADLINE', 'FORWARD_REQUEST_START_AFTER_DEADLINE',
    'FORWARD_QUOTE_PROVIDER_UNAVAILABLE', 'FORWARD_INTENT_PERSISTENCE_DELAY'}


class Invalid(ValueError):
    pass


def integer(value, positive=False):
    if type(value) is not int or value < (1 if positive else 0) or value > SAFE:
        raise Invalid('NONCANONICAL_INTEGER_OR_TIMESTAMP')
    return value


def raw(value):
    if not isinstance(value, str) or not re.fullmatch(r'(0|[1-9][0-9]*)', value):
        raise Invalid('INVALID_INTEGER_AMOUNT')
    amount = int(value)
    if not 0 < amount <= U64:
        raise Invalid('AMOUNT_OUTSIDE_U64')
    return amount


def canonical(value):
    if value is None or type(value) in (str, bool):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    if type(value) is int:
        if abs(value) > SAFE:
            raise Invalid('NONCANONICAL_INTEGER')
        return str(value)
    if isinstance(value, list):
        return '[' + ','.join(canonical(x) for x in value) + ']'
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        # UTF-16 lexical order matches JavaScript string comparison.
        keys = sorted(value, key=lambda k: k.encode('utf-16-be', 'surrogatepass'))
        return '{' + ','.join(canonical(k) + ':' + canonical(value[k]) for k in keys) + '}'
    raise Invalid('NONCANONICAL_VALUE')


def configuration_hash(protocol):
    body = {k: v for k, v in protocol.items() if k != 'configurationHash'}
    return hashlib.sha256(canonical(body).encode('utf-8')).hexdigest()


def protocol_valid(p):
    if not isinstance(p, dict):
        raise Invalid('PROTOCOL_UNAVAILABLE')
    if type(p.get('version')) is not int or p['version'] != 1 or p.get('scope') != SCOPE:
        raise Invalid('UNSUPPORTED_PROTOCOL')
    if not isinstance(p.get('experimentId'), str) or not re.fullmatch(r'[a-zA-Z0-9:_-]{1,128}', p['experimentId']):
        raise Invalid('INVALID_EXPERIMENT_ID')
    for key, pattern in [('runtimeSourceVersion', r'[a-f0-9]{64}'), ('sourceCommit', r'[a-f0-9]{40}'), ('configurationHash', r'[a-f0-9]{64}')]:
        if not isinstance(p.get(key), str) or not re.fullmatch(pattern, p[key]):
            raise Invalid('INVALID_PROTOCOL_SOURCE_OR_HASH')
    if configuration_hash(p) != p['configurationHash']:
        raise Invalid('CONFIGURATION_HASH_MISMATCH')
    for key in ('frozenAt', 'enrollmentStart', 'enrollmentEnd'):
        integer(p[key])
    if not p['frozenAt'] < p['enrollmentStart'] < p['enrollmentEnd']:
        raise Invalid('INVALID_FROZEN_WINDOW')
    for key in ('minimumEntryDelayMs', 'entryToleranceMs', 'primaryHorizonMs', 'horizonToleranceMs', 'maxQuoteAgeMs', 'researchMinimumTurnSpacingMs', 'maxActiveEpisodes', 'minimumDistinctEnteredTokens', 'minimumUtcDays'):
        integer(p[key], True)
    if p['minimumEntryDelayMs'] < p['researchMinimumTurnSpacingMs']:
        raise Invalid('ENTRY_DELAY_BELOW_FROZEN_RESEARCH_TURN_SPACING')
    for key in ('maximumProbeCostBps', 'slippageBps'):
        if integer(p[key]) >= 10000:
            raise Invalid('INVALID_PROTOCOL_BPS')
    if p['maximumProbeCostBps'] != 150:
        raise Invalid('UNSUPPORTED_V1_COST_CAP_EXPECTED_150')
    raw(p['amountLamports'])
    raw(p['networkFeePerLegLamports'])
    if p.get('selection') != 'FIRST_PROBE_PER_MINT' or p.get('control') != 'PAIRED_NO_TRADE_ZERO' or p.get('security') != 'UNASSESSED_NOT_TRADABLE':
        raise Invalid('UNSUPPORTED_SELECTION_CONTROL_OR_SECURITY')
    return p


def quote_valid(q, input_mint, output_mint, amount, at, not_before, max_age, slippage_bps):
    if not isinstance(q, dict) or q.get('inputMint') != input_mint or q.get('outputMint') != output_mint or q.get('inAmount') != amount:
        raise Invalid('QUOTE_MINT_OR_EXACT_SIZE_MISMATCH')
    raw(q['inAmount'])
    minimum, output = raw(q['minOutAmount']), raw(q['outAmount'])
    observed = integer(q['observedAt'])
    if 'requestedAt' in q and not not_before <= integer(q['requestedAt']) <= observed <= at:
        raise Invalid('QUOTE_PROVIDER_REQUEST_TIMING_INVALID')
    if minimum > output or minimum < output*(10000-slippage_bps)//10000 or not not_before <= observed <= at or at - observed > max_age:
        raise Invalid('QUOTE_TIMING_OR_MINIMUM_INVALID')
    return minimum


def timing_lower_bound(value, intent, received, deadline, quote=None):
    if quote is not None and not isinstance(quote, dict):
        raise Invalid('TIMED_QUOTE_OBJECT_INVALID')
    kind = value.get('timingEvidence')
    if 'timingEvidence' not in value:
        start = integer(value['requestedAt'])
        if not intent <= start <= received or 'providerInvocationAt' in value or (isinstance(quote, dict) and 'requestedAt' in quote):
            raise Invalid('LEGACY_REQUEST_TIMING_INVALID_OR_RELABELLED')
        return start, 'LEGACY_REQUEST_TIME_UNPROVEN'
    invocation = integer(value['providerInvocationAt'])
    if not intent <= invocation <= deadline or invocation > received:
        raise Invalid('PROVIDER_INVOCATION_TIMING_INVALID')
    if kind == 'PROVIDER_INVOCATION_ONLY':
        if 'requestedAt' in value or (isinstance(quote, dict) and 'requestedAt' in quote):
            raise Invalid('INVOCATION_ONLY_CANNOT_CLAIM_NETWORK_REQUEST')
        return invocation, kind
    if kind != 'PROVIDER_REPORTED_REQUEST_START':
        raise Invalid('REQUEST_TIMING_EVIDENCE_KIND_INVALID')
    start = integer(value['requestedAt'])
    if not invocation <= start <= received or (quote is not None and quote.get('requestedAt') != start):
        raise Invalid('PROVIDER_REPORTED_REQUEST_TIMING_INVALID')
    return start, kind


def ceiling_signed(n, d):
    return (n + d - 1) // d if n > 0 else -((-n) // d)


def exact(value):
    if value is None:
        return None
    value = Fraction(value)
    with localcontext() as context:
        context.prec = 80
        display = format(Decimal(value.numerator) / Decimal(value.denominator), '.12f')
    return {'numerator': str(value.numerator), 'denominator': str(value.denominator), 'decimalDisplay': display}


def stats(values):
    return {'count': len(values), 'netLamportsSum': str(sum(values)) if values else None,
            'meanNetLamportsExact': exact(Fraction(sum(values), len(values))) if values else None,
            'positiveCount': sum(v > 0 for v in values), 'negativeCount': sum(v < 0 for v in values),
            'pairedNoTradeNetLamportsSum': '0',
            'pairedDifferenceMeanLamportsExact': exact(Fraction(sum(values), len(values))) if values else None}


def bootstrap(clusters, seed, minimum_clusters, iterations=2000):
    if len(clusters) < minimum_clusters:
        return {'status': 'INSUFFICIENT_CLUSTERS', 'clusters': len(clusters), 'minimumClusters': minimum_clusters, 'mean95Lamports': None}, None
    rng = random.Random(seed)
    groups = list(clusters.values())
    estimates = []
    for _ in range(iterations):
        chosen = rng.choices(groups, k=len(groups))
        estimates.append(Fraction(sum(sum(v) for v in chosen), sum(len(v) for v in chosen)))
    estimates.sort()
    lower = estimates[int((iterations - 1) * .025)]
    upper = estimates[int((iterations - 1) * .975)]
    return {'status': 'DESCRIPTIVE_CLUSTER_BOOTSTRAP_ONLY', 'clusters': len(clusters), 'iterations': iterations,
            'mean95Lamports': {'lower': exact(lower), 'upper': exact(upper)},
            'caveat': 'Observed quote cohort only; no live-fill, independence, market-regime, or selection guarantee.'}, lower


def probe_delivery_audit(export, protocol, as_of, enrollment_count):
    """Check the producer's tagged-corpus reconciliation, not provider authenticity."""
    scope = 'EXPLICITLY_TAGGED_BASELINES_ONLY'
    if 'probeDeliveryAudit' not in export:
        return {'status': 'UNKNOWN', 'scope': scope,
                'reason': 'LEGACY_EXPORT_WITHOUT_TAGGED_DELIVERY_AUDIT'}
    audit = export['probeDeliveryAudit']
    if not isinstance(audit, dict) or type(audit.get('version')) is not int or audit['version'] != 1 or audit.get('scope') != scope:
        raise Invalid('PROBE_DELIVERY_AUDIT_VERSION_OR_SCOPE_INVALID')
    if audit.get('experimentId') != protocol['experimentId'] or integer(audit.get('exportedAt')) != as_of:
        raise Invalid('PROBE_DELIVERY_AUDIT_CONTEXT_OR_CUTOFF_MISMATCH')
    keys = ('taggedBaselineRows', 'distinctTaggedMints', 'missingEnrollmentMints',
            'displacedFirstProbeMints', 'unmatchedEnrollmentMints')
    counts = {key: integer(audit.get(key)) for key in keys}
    rows, distinct, missing, displaced, unmatched = (counts[key] for key in keys)
    matched = distinct - missing
    if (rows < distinct or (rows == 0) != (distinct == 0) or missing > distinct
            or unmatched > enrollment_count or displaced > matched
            or matched + unmatched != enrollment_count):
        raise Invalid('PROBE_DELIVERY_AUDIT_CARDINALITY_INVALID')
    complete = missing == displaced == unmatched == 0 and distinct == enrollment_count
    expected_status = 'COMPLETE' if complete else 'INCOMPLETE'
    if audit.get('status') != expected_status:
        raise Invalid('PROBE_DELIVERY_AUDIT_STATUS_INCONSISTENT')
    return {'version': 1, 'scope': scope, 'experimentId': protocol['experimentId'],
            'exportedAt': as_of, **counts, 'status': expected_status}


def _evaluate(export):
    if not isinstance(export, dict):
        raise Invalid('EXPORT_NOT_OBJECT')
    p = protocol_valid(export.get('protocol'))
    as_of = integer(export['exportedAt'])
    if as_of < p['frozenAt']:
        raise Invalid('EXPORT_PRECEDES_FREEZE')
    if not isinstance(export.get('records'), list):
        raise Invalid('RECORDS_UNAVAILABLE')
    by_id, duplicates, rows = {}, 0, []
    for index, row in enumerate(export['records']):
        if not isinstance(row, dict) or row.get('phase') not in PHASES or not isinstance(row.get('mint'), str) or not re.fullmatch(B58 + r'{32,44}', row['mint']) or row['mint'] == WSOL:
            raise Invalid('RECORD_IDENTITY_INVALID')
        phase, mint = row['phase'], row['mint']
        if row.get('experimentId') != p['experimentId'] or row.get('configurationHash') != p['configurationHash'] or row.get('scope') != SCOPE or row.get('id') != f"{p['experimentId']}:{mint}:{phase}":
            raise Invalid('RECORD_CONTEXT_OR_CONFIGURATION_CHANGED')
        at = integer(row['at'])
        if not p['frozenAt'] <= at <= as_of or not isinstance(row.get('data'), dict):
            raise Invalid('RECORD_TIME_OR_DATA_INVALID')
        canonical(row)
        if row['id'] in by_id:
            if canonical(row) != canonical(by_id[row['id']][0]):
                raise Invalid('CONFLICTING_DUPLICATE_RECORD')
            duplicates += 1
            continue
        by_id[row['id']] = (row, index)
        rows.append((row, index))
    groups = defaultdict(dict)
    for row, index in rows:
        groups[row['mint']][row['phase']] = (row, index)
    for group in groups.values():
        if 'ENROLLMENT' not in group:
            raise Invalid('ORPHAN_RECORD_WITHOUT_ENROLLMENT')
    enrollment_order = sorted((g['ENROLLMENT'] for g in groups.values()), key=lambda item: (item[0]['at'], item[1]))
    evaluated, probes, counts = {}, set(), Counter()
    amount, fee = raw(p['amountLamports']), raw(p['networkFeePerLegLamports'])
    cap = p['maximumProbeCostBps']

    def prior_at(pair, decision):
        return pair and (pair[0]['at'], pair[1]) < (decision[0]['at'], decision[1])

    for enrollment, index in enrollment_order:
        mint, d, at = enrollment['mint'], enrollment['data'], enrollment['at']
        if integer(d['decisionAt']) != at or not p['enrollmentStart'] <= at <= p['enrollmentEnd']:
            raise Invalid('ENROLLMENT_OUTSIDE_FROZEN_WINDOW')
        if not isinstance(d.get('probeId'), str) or not re.fullmatch(r'[a-zA-Z0-9:_-]{1,128}', d['probeId']) or d['probeId'] in probes:
            raise Invalid('PROBE_ID_MISSING_OR_REUSED')
        probes.add(d['probeId'])
        if not isinstance(d.get('signature'), str) or not re.fullmatch(B58 + r'{64,90}', d['signature']) or d.get('protocol') not in ('pump', 'pumpswap', 'raydium-cpmm') or d.get('kind') not in ('launch', 'pool', 'buy', 'sell', 'migrate', 'swap'):
            raise Invalid('PROBE_SOURCE_IDENTITY_INVALID')
        integer(d['slot'])
        event, started, completed = (integer(d[k]) for k in ('eventObservedAt', 'probeStartedAt', 'probeCompletedAt'))
        raw(d['amountLamports'])
        prospective = p['enrollmentStart'] <= event <= started <= completed <= at and at-completed <= p['maxQuoteAgeMs'] and d['amountLamports'] == p['amountLamports']
        try:
            quantity = quote_valid(d.get('probeBuy'), WSOL, mint, p['amountLamports'], completed, started, p['maxQuoteAgeMs'], p['slippageBps'])
            proceeds = quote_valid(d.get('probeSell'), mint, WSOL, str(quantity), completed, d['probeBuy']['observedAt'], p['maxQuoteAgeMs'], p['slippageBps'])
            loss = amount + fee * 2 - proceeds
            cost_pass = loss * 10000 <= cap * amount
            if d.get('sequentialStressCostBpsCeiling') != str(ceiling_signed(loss * 10000, amount)):
                raise Invalid('PROBE_EMBEDDED_COST_MISMATCH')
        except (KeyError, TypeError, Invalid) as error:
            if isinstance(error, Invalid) and str(error) == 'PROBE_EMBEDDED_COST_MISMATCH':
                raise
            loss, cost_pass = None, False
        qualified = prospective and cost_pass
        active = 0
        for other in evaluated.values():
            if not other['admitted']:
                continue
            og = groups[other['mint']]
            entry = og.get('ENTRY_RESULT')
            exit_result = og.get('EXIT_RESULT')
            if not prior_at(entry, (enrollment, index)) or (entry[0]['data'].get('status') == 'QUOTED' and not prior_at(exit_result, (enrollment, index))):
                active += 1
        admitted = qualified and active < p['maxActiveEpisodes']
        if type(d.get('costQualified')) is not bool or type(d.get('admitted')) is not bool or d['costQualified'] != qualified or d['admitted'] != admitted:
            raise Invalid('ENROLLMENT_FLAGS_CONTRADICT_RECOMPUTED_ELIGIBILITY')
        if not isinstance(d.get('reasons'), list) or any(not isinstance(reason, str) for reason in d['reasons']) or d.get('security') != p['security'] or d.get('controlNetLamports') != '0':
            raise Invalid('ENROLLMENT_CONTROL_OR_REASON_CONTRACT_INVALID')
        due, deadline = at + p['minimumEntryDelayMs'], at + p['minimumEntryDelayMs'] + p['entryToleranceMs']
        if integer(d['entryDueAt']) != due or integer(d['entryDeadlineAt']) != deadline:
            raise Invalid('ENTRY_SCHEDULE_CHANGED')
        evaluated[mint] = {'mint': mint, 'admitted': admitted, 'qualified': qualified, 'due': due, 'deadline': deadline, 'decision': at}
        counts['enrolled'] += 1
        counts['costQualified'] += qualified
        counts['admitted'] += admitted
        counts['capacityRejected'] += qualified and not admitted
        counts['invalidOrUnavailableProbe'] += loss is None or not prospective
        counts['overCap'] += loss is not None and not cost_pass

    timing_counts = Counter()
    def result_for(mint, entry, due, deadline, input_mint, output_mint, quantity):
        group = groups[mint]
        req_phase, result_phase = ('ENTRY_REQUEST', 'ENTRY_RESULT') if entry else ('EXIT_REQUEST', 'EXIT_RESULT')
        request_pair, result_pair = group.get(req_phase), group.get(result_phase)
        if request_pair:
            request, _ = request_pair
            rd = request['data']
            if integer(rd['requestIntentAt']) != request['at'] or not due <= request['at'] <= deadline or integer(rd['dueAt']) != due or integer(rd['deadlineAt']) != deadline or rd.get('inputMint') != input_mint or rd.get('outputMint') != output_mint or rd.get('amountRaw') != quantity:
                raise Invalid('REQUEST_IDENTITY_SIZE_OR_DUE_TIME_INVALID')
        if not result_pair:
            return None, 'PENDING' if as_of <= deadline else 'MISSING_RESULT_AFTER_DEADLINE'
        result, _ = result_pair
        data, status = result['data'], result['data'].get('status')
        if not entry and ((status == 'QUOTED' and ('originalEntryRecordId' not in data or 'originalQuantityRaw' not in data)) or ('originalEntryRecordId' in data and data['originalEntryRecordId'] != group['ENTRY_RESULT'][0]['id']) or ('originalQuantityRaw' in data and data['originalQuantityRaw'] != quantity)):
            raise Invalid('EXIT_CANONICAL_ENTRY_REFERENCE_OR_QUANTITY_CHANGED')
        if status == 'MISSED_DEADLINE_NO_QUOTE':
            if request_pair or result['at'] <= deadline or integer(data['dueAt']) != due or integer(data['deadlineAt']) != deadline:
                raise Invalid('INVALID_MISSED_DEADLINE_RECORD')
            return None, status
        if status not in ('INTERRUPTED_UNKNOWN_NO_RETRY', 'UNAVAILABLE_OR_LATE', 'QUOTED') or not request_pair or data.get('requestId') != request_pair[0]['id'] or result['at'] < request_pair[0]['at']:
            raise Invalid('RESULT_REQUEST_REFERENCE_INVALID')
        if status == 'INTERRUPTED_UNKNOWN_NO_RETRY':
            return None, status
        if integer(data['dueAt']) != due or integer(data['deadlineAt']) != deadline:
            raise Invalid('RESULT_SCHEDULE_CHANGED')
        if status == 'UNAVAILABLE_OR_LATE':
            if data.get('error') not in SAFE_QUOTE_ERRORS:
                raise Invalid('UNRECOGNIZED_QUOTE_ERROR_NOT_SAFE_TO_REEXPORT')
            if 'timedQuote' in data or integer(data['receivedAt']) != result['at']:
                raise Invalid('FAILURE_RESULT_TIMING_INVALID')
            if data.get('timingEvidence') == 'NO_PROVIDER_CALL':
                if data.get('providerCalled') is not False or data.get('error') != 'FORWARD_INTENT_PERSISTENCE_DELAY' or result['at'] <= deadline or 'requestedAt' in data or 'providerInvocationAt' in data:
                    raise Invalid('INVALID_INTENT_PERSISTENCE_DELAY_EVIDENCE')
            else:
                actual_request, kind = timing_lower_bound(data, request_pair[0]['at'], result['at'], deadline)
                if kind == 'LEGACY_REQUEST_TIME_UNPROVEN':
                    if not due <= actual_request <= deadline and not (actual_request > deadline and data.get('error') == 'FORWARD_INTENT_PERSISTENCE_DELAY' and data.get('providerCalled') is False):
                        raise Invalid('ACTUAL_REQUEST_OUTSIDE_WINDOW_WITHOUT_NO_CALL_EVIDENCE')
                    if data.get('error') == 'FORWARD_INTENT_PERSISTENCE_DELAY' and (data.get('providerCalled') is not False or actual_request <= deadline):
                        raise Invalid('INVALID_INTENT_PERSISTENCE_DELAY_EVIDENCE')
                elif data.get('providerCalled') is not True or (actual_request > deadline and not (kind == 'PROVIDER_REPORTED_REQUEST_START' and data.get('error') == 'FORWARD_REQUEST_START_AFTER_DEADLINE' and result['at'] > deadline)):
                    raise Invalid('ACTUAL_REQUEST_OUTSIDE_WINDOW_WITHOUT_NO_CALL_EVIDENCE')
            return None, status
        timed = data['timedQuote']
        if not isinstance(timed, dict):
            raise Invalid('TIMED_RESULT_UNAVAILABLE')
        actual_request, kind = timing_lower_bound(timed, request_pair[0]['at'], result['at'], deadline, timed['quote'])
        if actual_request < request_pair[0]['at'] or not due <= actual_request <= deadline or integer(timed['receivedAt']) != result['at'] or result['at'] < actual_request or result['at'] > deadline:
            raise Invalid('RESULT_RESPONSE_AFTER_DEADLINE_OR_REQUEST_MISMATCH')
        output = quote_valid(timed['quote'], input_mint, output_mint, quantity, result['at'], actual_request, p['maxQuoteAgeMs'], p['slippageBps'])
        timing_counts[kind] += 1
        return {'quote': timed['quote'], 'output': output, 'at': result['at']}, status

    outcomes, entry_statuses, exit_statuses, complete = [], Counter(), Counter(), []
    for mint, item in evaluated.items():
        group = groups[mint]
        if not item['admitted']:
            if any(key != 'ENROLLMENT' for key in group):
                raise Invalid('REQUEST_OR_RESULT_FOR_REJECTED_ENROLLMENT')
            continue
        entry, status = result_for(mint, True, item['due'], item['deadline'], WSOL, mint, p['amountLamports'])
        entry_statuses[status] += 1
        if not entry:
            if 'EXIT_REQUEST' in group or 'EXIT_RESULT' in group:
                raise Invalid('EXIT_WITHOUT_VALID_CANONICAL_ENTRY')
            continue
        entry_at, qty = entry['quote']['observedAt'], str(entry['output'])
        due = entry_at + p['primaryHorizonMs']
        deadline = due + p['horizonToleranceMs']
        exit_result, status = result_for(mint, False, due, deadline, mint, WSOL, qty)
        exit_statuses[status] += 1
        net = exit_result['output'] - amount - 2*fee if exit_result else -amount - 2*fee
        utc_day = datetime.fromtimestamp(entry_at/1000, timezone.utc).date().isoformat()
        outcome = {'mint': mint, 'entryObservedAt': entry_at, 'utcDay': utc_day, 'status': status, 'netLamports': str(net), 'pending': status == 'PENDING'}
        outcomes.append(outcome)
        if exit_result:
            complete.append(net)
    bound = [int(o['netLamports']) for o in outcomes]
    tokens = {o['mint']: [int(o['netLamports'])] for o in outcomes}
    days = defaultdict(list)
    for o in outcomes:
        days[o['utcDay']].append(int(o['netLamports']))
    seed = int(p['configurationHash'][:16], 16)
    token_ci, token_lower = bootstrap(tokens, seed, 30)
    day_ci, day_lower = bootstrap(days, seed ^ 0xF04A, 3)
    remainder = sum(sorted(bound)[:-3]) if len(bound) > 3 else None
    pending_entries, pending_exits = entry_statuses['PENDING'], exit_statuses['PENDING']
    delivery_audit = probe_delivery_audit(export, p, as_of, len(groups))
    gates = {
        'taggedProbeDeliveryComplete': delivery_audit['status'] == 'COMPLETE',
        'frozenEnrollmentWindowClosed': as_of >= p['enrollmentEnd'],
        'minimumDistinctEnteredTokens': len(tokens) >= max(100, p['minimumDistinctEnteredTokens']),
        'minimumUtcEntryDays': len(days) >= max(3, p['minimumUtcDays']),
        'noPendingEpisodes': pending_entries + pending_exits == 0,
        'positiveConservativeAllEnteredSum': bool(bound) and sum(bound) > 0,
        'tokenClusterLower95Positive': token_lower is not None and token_lower > 0,
        'utcDayClusterLower95Positive': day_lower is not None and day_lower > 0,
        'positiveAfterRemovingThreeLargestWinners': remainder is not None and remainder > 0,
    }
    synthetic = isinstance(export.get('fixtureKind'), str) and 'synthetic' in export['fixtureKind'].lower()
    evidence_kind = 'SYNTHETIC_CONTRACT_FIXTURE_ONLY' if synthetic else 'UNATTESTED_FORWARD_QUOTE_JOURNAL'
    opportunity_bound = bound + [0] * (counts['admitted']-len(outcomes))
    return {
        'inputEvidenceKind': evidence_kind,
        'datasetStatus': 'VALIDATED_OFFLINE_RECORD_CONTRACT', 'scope': SCOPE, 'experimentId': p['experimentId'], 'configurationHash': p['configurationHash'], 'exportedAt': as_of,
        'profitabilityConclusion': 'UNPROVEN', 'liveApproved': False,
        'classification': ('SYNTHETIC_THRESHOLDS_MET_NOT_MARKET_EVIDENCE' if synthetic else 'CANDIDATE_FOR_FURTHER_PAPER_VALIDATION') if all(gates.values()) else 'INSUFFICIENT_OR_NONPOSITIVE_FORWARD_QUOTE_EVIDENCE',
        'candidateGates': gates, 'opportunities': dict(counts),
        'probeDeliveryAudit': delivery_audit,
        'coverage': {'distinctEnrolledTokens': len(groups), 'entryRequests': sum('ENTRY_REQUEST' in group for group in groups.values()),
                     'validFreshEntries': len(outcomes), 'onTimeExits': len(complete), 'pendingEntries': pending_entries, 'pendingExits': pending_exits,
                     'entryStatuses': dict(entry_statuses), 'exitStatuses': dict(exit_statuses), 'identicalDuplicateRecordsIgnored': duplicates,
                     'requestTimingEvidence': dict(timing_counts),
                     'entryFillRateExact': exact(Fraction(len(outcomes), counts['admitted'])) if counts['admitted'] else None,
                     'exitOnTimeRateExact': exact(Fraction(len(complete), len(outcomes))) if outcomes else None},
        'onTimeCompleteCase': stats(complete), 'allEnteredConservativeBound': stats(bound),
        'allAdmittedOpportunityBound': stats(opportunity_bound),
        'pendingExposureIncludedAtZeroProceedsInBound': pending_exits,
        'tokenClusterUncertainty': token_ci, 'utcDayClusterUncertainty': day_ci,
        'conservativeNetAfterRemovingThreeLargestWinnersLamports': str(remainder) if remainder is not None else None,
        'outcomes': outcomes,
        'limitations': [
            'Quotes are indicative research observations, not autonomous trades, positions, realized P&L, or live-fill evidence.',
            'Provider-reported request starts are distinguished from invocation-only and legacy unproven request times; this export cannot attest provider authenticity.',
            'Unfilled quote-only opportunities contribute zero to the opportunity bound; failed submitted transactions and inclusion probability are unmeasured.',
            'Security is explicitly unassessed; no strategy activation or live approval follows from this report.',
            'Only the paired no-trade-zero control is specified; this does not prove superiority to a matched random-entry trading strategy.',
            'First-probe uniqueness is checked within the journal; omitted earlier probes and provider data authenticity cannot be proved from this export alone.',
            'Delivery reconciliation covers only explicitly tagged durable baseline rows; it does not attest provider authenticity, untagged probes, all launches, or market-wide coverage. Missing legacy audits leave tagged delivery completeness unknown and block candidate review.',
            'Pending and missing exits have zero proceeds in the all-entered bound; pending counts are also shown separately.',
            'Bootstrap intervals are descriptive; they do not establish independence, regime stability, attainable fills, or counterfactual market impact.',
        ],
    }


def evaluate(export):
    try:
        return _evaluate(export)
    except (Invalid, KeyError, TypeError, ValueError, OverflowError) as error:
        return {'datasetStatus': 'INVALID_DATASET_FAIL_CLOSED', 'scope': SCOPE, 'classification': 'INVALID_NO_CANDIDATE_CLASSIFICATION',
                'profitabilityConclusion': 'UNPROVEN', 'liveApproved': False, 'errors': [str(error)], 'outcomes': []}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path, help='Saved forward-cohort JSON export; no URL is accepted')
    parser.add_argument('--output', required=True, type=Path, help='Offline analysis JSON output')
    args = parser.parse_args(argv)
    data = json.loads(args.input.read_text(encoding='utf-8'))
    report = evaluate(data)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(args.output), 'datasetStatus': report['datasetStatus'], 'classification': report['classification'], 'profitabilityConclusion': 'UNPROVEN'}))
    return 2 if report['datasetStatus'] == 'INVALID_DATASET_FAIL_CLOSED' else 0


if __name__ == '__main__':
    raise SystemExit(main())
