"""Synthetic contract fixtures only; no market return or profitability evidence."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch

import forward_cohort as f

BASE = 1_800_000_000_000
ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'


def protocol():
    p = {
        'version': 1, 'scope': f.SCOPE, 'experimentId': 'synthetic-forward-v1',
        'frozenAt': BASE, 'enrollmentStart': BASE+1000, 'enrollmentEnd': BASE+72*3_600_000,
        'runtimeSourceVersion': 'a'*64, 'sourceCommit': 'b'*40,
        'amountLamports': '10000000', 'maximumProbeCostBps': 150, 'slippageBps': 100,
        'networkFeePerLegLamports': '10000', 'minimumEntryDelayMs': 32000, 'researchMinimumTurnSpacingMs': 30000,
        'entryToleranceMs': 5000, 'primaryHorizonMs': 60000, 'horizonToleranceMs': 5000,
        'maxQuoteAgeMs': 5000, 'maxActiveEpisodes': 1, 'minimumDistinctEnteredTokens': 100,
        'minimumUtcDays': 3, 'selection': 'FIRST_PROBE_PER_MINT', 'control': 'PAIRED_NO_TRADE_ZERO',
        'security': 'UNASSESSED_NOT_TRADABLE',
    }
    p['configurationHash'] = f.configuration_hash(p)
    return p


def quote(input_mint, output_mint, amount, output, at):
    return {'inputMint': input_mint, 'outputMint': output_mint, 'inAmount': str(amount),
            'outAmount': str(output), 'minOutAmount': str(output), 'observedAt': at}


def fixture(count=1, proceeds=12_020_000):
    p, records = protocol(), []
    for i in range(count):
        mint = '2'*30 + ALPHABET[i//58] + ALPHABET[i%58]
        at = BASE+2000+i*30*60_000
        identity = lambda phase: f"{p['experimentId']}:{mint}:{phase}"
        def row(phase, when, data):
            return {'id': identity(phase), 'experimentId': p['experimentId'],
                    'configurationHash': p['configurationHash'], 'scope': f.SCOPE,
                    'mint': mint, 'phase': phase, 'at': when, 'data': data}
        records.append(row('ENROLLMENT', at, {
            'probeId': f'probe-{i}', 'signature': '1'*64, 'slot': i+1,
            'protocol': 'pump', 'kind': 'launch', 'eventObservedAt': at-250,
            'probeStartedAt': at-200, 'probeCompletedAt': at-10,
            'amountLamports': p['amountLamports'],
            'probeBuy': quote(f.WSOL, mint, 10_000_000, 1000, at-150),
            'probeSell': quote(mint, f.WSOL, 1000, 9_900_000, at-50),
            'sequentialStressCostBpsCeiling': '120', 'decisionAt': at,
            'costQualified': True, 'admitted': True, 'reasons': [],
            'entryDueAt': at+p['minimumEntryDelayMs'], 'entryDeadlineAt': at+p['minimumEntryDelayMs']+p['entryToleranceMs'],
            'controlNetLamports': '0', 'security': p['security'],
        }))
        req = at+p['minimumEntryDelayMs']
        records.append(row('ENTRY_REQUEST', req, {'requestIntentAt': req, 'dueAt': req,
            'deadlineAt': req+5000, 'inputMint': f.WSOL, 'outputMint': mint, 'amountRaw': '10000000'}))
        entry_quote = quote(f.WSOL, mint, 10_000_000, 2000, req+20)
        records.append(row('ENTRY_RESULT', req+50, {'status': 'QUOTED', 'requestId': identity('ENTRY_REQUEST'),
            'dueAt': req, 'deadlineAt': req+5000,
            'timedQuote': {'requestedAt': req, 'receivedAt': req+50, 'quote': entry_quote}}))
        due = entry_quote['observedAt']+60_000
        exit_req = due+100
        records.append(row('EXIT_REQUEST', exit_req, {'requestIntentAt': exit_req, 'dueAt': due,
            'deadlineAt': due+5000, 'inputMint': mint, 'outputMint': f.WSOL, 'amountRaw': '2000'}))
        records.append(row('EXIT_RESULT', exit_req+50, {'status': 'QUOTED', 'requestId': identity('EXIT_REQUEST'),
            'dueAt': due, 'deadlineAt': due+5000,
            'originalEntryRecordId': identity('ENTRY_RESULT'), 'originalQuantityRaw': '2000',
            'timedQuote': {'requestedAt': exit_req, 'receivedAt': exit_req+50,
                           'quote': quote(mint, f.WSOL, 2000, proceeds, exit_req+20)}}))
    return {'protocol': p, 'costAudit': {'arbitraryEmbeddedClaims': 'not trusted'},
            'records': records, 'exportedAt': p['enrollmentEnd']+120_000,
            'fixtureKind': 'SYNTHETIC_TEST_ONLY_NOT_MARKET_EVIDENCE'}


def phase(data, name, mint_index=0):
    return [r for r in data['records'] if r['phase'] == name][mint_index]


def with_delivery_audit(data, **overrides):
    count = len({r['mint'] for r in data['records'] if r['phase'] == 'ENROLLMENT'})
    audit = {'version': 1, 'scope': 'EXPLICITLY_TAGGED_BASELINES_ONLY',
             'experimentId': data['protocol']['experimentId'], 'exportedAt': data['exportedAt'],
             'taggedBaselineRows': count, 'distinctTaggedMints': count,
             'missingEnrollmentMints': 0, 'displacedFirstProbeMints': 0,
             'unmatchedEnrollmentMints': 0, 'status': 'COMPLETE'}
    audit.update(overrides)
    data['probeDeliveryAudit'] = audit
    return data


def with_retirement(data, cutoff=None):
    """Synthetic marker with the exact ForwardRuntime retirement wire schema."""
    old = data['protocol']
    cutoff = max([old['frozenAt']] + [r['at'] for r in data['records']]) if cutoff is None else cutoff
    target = copy.deepcopy(old)
    target.update(experimentId='post-probe-60s-v1-'+'c'*64, runtimeSourceVersion='c'*64,
                  sourceCommit='d'*40, frozenAt=cutoff, enrollmentStart=cutoff+1000,
                  enrollmentEnd=cutoff+1000+72*3_600_000)
    target['configurationHash'] = f.configuration_hash(target)
    data['retirement'] = {
        'schemaVersion': 1, 'status': 'INCOMPLETE', 'reason': 'SOURCE_CHANGED',
        'cutoffAt': cutoff, 'oldExperimentId': old['experimentId'],
        'oldRuntimeSourceVersion': old['runtimeSourceVersion'],
        'oldConfigurationHash': old['configurationHash'],
        'originalEnrollmentStart': old['enrollmentStart'], 'originalEnrollmentEnd': old['enrollmentEnd'],
        'newExperimentId': target['experimentId'], 'newRuntimeSourceVersion': target['runtimeSourceVersion'],
        'journalRecordCount': len(data['records']),
        'journalCanonicalSha256': hashlib.sha256(f.canonical(data['records']).encode()).hexdigest(),
        'targetProtocol': target,
    }
    return data


class ForwardCohortTests(unittest.TestCase):
    def invalid(self, data, reason=None):
        result = f.evaluate(data)
        self.assertEqual(result['datasetStatus'], 'INVALID_DATASET_FAIL_CLOSED', result)
        self.assertEqual(result['profitabilityConclusion'], 'UNPROVEN')
        self.assertFalse(result['liveApproved'])
        if reason:
            self.assertIn(reason, result['errors'][0])
        return result

    def test_synthetic_accounting_uses_new_entry_quantity_and_fees_once(self):
        report = f.evaluate(fixture())
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['onTimeCompleteCase']['netLamportsSum'], '2000000')
        self.assertEqual(report['allEnteredConservativeBound']['meanNetLamportsExact']['numerator'], '2000000')
        self.assertEqual(report['coverage']['validFreshEntries'], 1)
        self.assertEqual(report['onTimeCompleteCase']['pairedNoTradeNetLamportsSum'], '0')
        self.assertEqual(report['classification'], 'INSUFFICIENT_OR_NONPOSITIVE_FORWARD_QUOTE_EVIDENCE')

    def test_small_winning_sample_never_passes_candidate_gate(self):
        report = f.evaluate(fixture(5))
        self.assertFalse(report['candidateGates']['minimumDistinctEnteredTokens'])
        self.assertFalse(report['candidateGates']['minimumUtcEntryDays'])
        self.assertEqual(report['tokenClusterUncertainty']['status'], 'INSUFFICIENT_CLUSTERS')

    def test_large_synthetic_positive_sample_only_gets_research_candidate(self):
        report = f.evaluate(with_delivery_audit(fixture(100)))
        self.assertEqual(report['classification'], 'SYNTHETIC_THRESHOLDS_MET_NOT_MARKET_EVIDENCE', report)
        self.assertEqual(report['inputEvidenceKind'], 'SYNTHETIC_CONTRACT_FIXTURE_ONLY')
        self.assertEqual(report['profitabilityConclusion'], 'UNPROVEN')
        self.assertFalse(report['liveApproved'])
        self.assertEqual(report['coverage']['validFreshEntries'], 100)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '200000000')
        self.assertEqual(report['conservativeNetAfterRemovingThreeLargestWinnersLamports'], '194000000')

    def test_retired_positive_fixture_exported_after_old_window_never_becomes_candidate(self):
        data = with_delivery_audit(fixture(100))
        nonretired = f.evaluate(data)
        with_retirement(data)
        original = copy.deepcopy(data)
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertGreater(report['exportedAt'], data['protocol']['enrollmentEnd'])
        self.assertEqual(report['exportedAt'], data['exportedAt'])
        self.assertEqual(report['analysisAsOf'], data['retirement']['cutoffAt'])
        self.assertEqual(report['epochStatus'], 'INCOMPLETE_RETIRED')
        self.assertEqual(report['classification'], 'INCOMPLETE_RETIRED_FORWARD_QUOTE_EVIDENCE')
        self.assertFalse(report['candidateGates']['frozenEnrollmentWindowClosed'])
        self.assertFalse(report['candidateGates']['epochNotRetired'])
        self.assertEqual(report['retirement'], data['retirement'])
        self.assertEqual(report['allEnteredConservativeBound'], nonretired['allEnteredConservativeBound'])
        self.assertEqual(report['outcomes'], nonretired['outcomes'])
        self.assertEqual(report['probeDeliveryAudit']['exportedAt'], data['exportedAt'])
        self.assertEqual(report['profitabilityConclusion'], 'UNPROVEN')
        self.assertFalse(report['liveApproved'])
        self.assertEqual(data, original)

    def test_retirement_after_old_window_also_blocks_candidate(self):
        data = with_retirement(with_delivery_audit(fixture(100)), protocol()['enrollmentEnd']+1)
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertTrue(report['candidateGates']['frozenEnrollmentWindowClosed'])
        self.assertTrue(all(v for k, v in report['candidateGates'].items() if k != 'epochNotRetired'))
        self.assertEqual(report['classification'], 'INCOMPLETE_RETIRED_FORWARD_QUOTE_EVIDENCE')

    def test_retired_pending_exit_uses_cutoff_without_fabricating_missing_or_result(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        with_retirement(data)
        original = copy.deepcopy(data)
        first = f.evaluate(data)
        self.assertEqual(first['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', first)
        self.assertEqual(first['coverage']['pendingExits'], 1)
        self.assertEqual(first['outcomes'][0]['status'], 'PENDING')
        self.assertEqual(first['allEnteredConservativeBound']['netLamportsSum'], '-10020000')
        self.assertEqual(data, original)
        data['exportedAt'] += 90*86_400_000
        second = f.evaluate(data)
        self.assertEqual(second['outcomes'], first['outcomes'])
        self.assertEqual(second['analysisAsOf'], first['analysisAsOf'])
        self.assertGreater(second['exportedAt'], first['exportedAt'])

    def test_retired_missing_exit_remains_missing_at_cutoff(self):
        data = fixture()
        cutoff = phase(data, 'EXIT_RESULT')['at']+10_000
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        report = f.evaluate(with_retirement(data, cutoff))
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['coverage']['pendingExits'], 0)
        self.assertEqual(report['outcomes'][0]['status'], 'MISSING_RESULT_AFTER_DEADLINE')
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-10020000')

    def test_nonretired_export_preserves_wall_clock_analysis_and_legacy_classification(self):
        data = with_delivery_audit(fixture(100))
        report = f.evaluate(data)
        self.assertEqual(report['analysisAsOf'], data['exportedAt'])
        self.assertEqual(report['epochStatus'], 'NOT_RETIRED')
        self.assertIsNone(report['retirement'])
        self.assertTrue(report['candidateGates']['epochNotRetired'])
        self.assertEqual(report['classification'], 'SYNTHETIC_THRESHOLDS_MET_NOT_MARKET_EVIDENCE')

    def test_supplied_malformed_retirement_is_never_treated_as_absent(self):
        for marker in (None, False, [], {}, 'INCOMPLETE'):
            with self.subTest(marker=marker):
                data = fixture()
                data['retirement'] = marker
                self.invalid(data, 'RETIREMENT_SCHEMA_INVALID')
        for field, value in (('schemaVersion', True), ('schemaVersion', 2),
                             ('status', 'COMPLETE'), ('reason', 'OTHER')):
            with self.subTest(field=field, value=value):
                data = with_retirement(fixture())
                data['retirement'][field] = value
                self.invalid(data, 'RETIREMENT_SCHEMA_INVALID')
        for change in ('extra', 'missing'):
            data = with_retirement(fixture())
            if change == 'extra': data['retirement']['unreviewed'] = True
            else: del data['retirement']['reason']
            self.invalid(data, 'RETIREMENT_SCHEMA_INVALID')

    def test_retirement_old_source_and_window_must_match_frozen_manifest(self):
        changes = [('oldExperimentId', 'another'), ('oldRuntimeSourceVersion', 'f'*64),
                   ('oldConfigurationHash', 'e'*64), ('originalEnrollmentStart', BASE+1001),
                   ('originalEnrollmentEnd', BASE+99_000)]
        for field, value in changes:
            with self.subTest(field=field):
                data = with_retirement(fixture())
                data['retirement'][field] = value
                self.invalid(data, 'RETIREMENT_OLD_MANIFEST_IDENTITY_MISMATCH')

    def test_retirement_requires_distinct_canonical_new_source_identity(self):
        changes = [('newExperimentId', 'bad id'), ('newExperimentId', protocol()['experimentId']),
                   ('newRuntimeSourceVersion', 'C'*64), ('newRuntimeSourceVersion', 'a'*64),
                   ('journalCanonicalSha256', 'bad-hash')]
        for field, value in changes:
            with self.subTest(field=field, value=value):
                data = with_retirement(fixture())
                data['retirement'][field] = value
                self.invalid(data, 'RETIREMENT_NEW_SOURCE_OR_JOURNAL_IDENTITY_INVALID')

    def test_retirement_target_manifest_hash_and_identity_are_verified(self):
        for field, value in (('experimentId', 'another-target'), ('runtimeSourceVersion', 'f'*64)):
            with self.subTest(field=field):
                data = with_retirement(fixture())
                target = data['retirement']['targetProtocol']
                target[field] = value
                target['configurationHash'] = f.configuration_hash(target)
                self.invalid(data, 'RETIREMENT_TARGET_MANIFEST_IDENTITY_MISMATCH')
        data = with_retirement(fixture())
        data['retirement']['targetProtocol']['amountLamports'] = '1'
        self.invalid(data, 'CONFIGURATION_HASH_MISMATCH')

    def test_retirement_cutoff_order_checks_freeze_export_and_target(self):
        for cutoff in (BASE-1, fixture()['exportedAt']+1):
            data = with_retirement(fixture(), cutoff)
            self.invalid(data, 'RETIREMENT_CUTOFF_ORDER_INVALID')
        data = with_retirement(fixture())
        target = data['retirement']['targetProtocol']
        target['frozenAt'] += 1
        target['configurationHash'] = f.configuration_hash(target)
        self.invalid(data, 'RETIREMENT_CUTOFF_ORDER_INVALID')

    def test_retirement_integer_fields_reject_boolean_fraction_and_negative(self):
        for field in ('cutoffAt', 'originalEnrollmentStart', 'originalEnrollmentEnd', 'journalRecordCount'):
            for value in (True, -1, 1.5, '1', f.SAFE+1):
                with self.subTest(field=field, value=value):
                    data = with_retirement(fixture())
                    data['retirement'][field] = value
                    self.invalid(data, 'NONCANONICAL_INTEGER_OR_TIMESTAMP')

    def test_retirement_fingerprint_covers_exact_raw_count_content_and_order(self):
        for change in ('count', 'content', 'order', 'duplicate'):
            with self.subTest(change=change):
                data = with_retirement(fixture())
                if change == 'count': data['retirement']['journalRecordCount'] += 1
                elif change == 'content': data['records'][0]['data']['signature'] = '2'*64
                elif change == 'order': data['records'].reverse()
                else: data['records'].append(copy.deepcopy(data['records'][0]))
                self.invalid(data, 'RETIREMENT_JOURNAL_FINGERPRINT_MISMATCH')

    def test_retirement_fingerprint_never_authorizes_rows_after_cutoff(self):
        data = with_retirement(fixture(), phase(fixture(), 'EXIT_RESULT')['at']-1)
        self.invalid(data, 'RECORD_TIME_OR_DATA_INVALID')

    def test_empty_retirement_at_freeze_and_equal_export_cutoff_is_valid(self):
        data = fixture(0)
        data['exportedAt'] = BASE
        report = f.evaluate(with_retirement(data, BASE))
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['analysisAsOf'], BASE)
        self.assertEqual(report['coverage']['validFreshEntries'], 0)
        self.assertEqual(report['classification'], 'INCOMPLETE_RETIRED_FORWARD_QUOTE_EVIDENCE')

    def test_existing_earlier_frozen_target_is_valid_without_rewriting_its_window(self):
        data = with_retirement(fixture())
        target = data['retirement']['targetProtocol']
        target['frozenAt'], target['enrollmentStart'], target['enrollmentEnd'] = BASE, BASE+1, BASE+2
        target['configurationHash'] = f.configuration_hash(target)
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['retirement']['targetProtocol'], target)

    def test_legacy_positive_export_keeps_valid_contract_but_unknown_delivery_blocks_candidate(self):
        report = f.evaluate(fixture(100))
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['probeDeliveryAudit']['status'], 'UNKNOWN')
        self.assertFalse(report['candidateGates']['taggedProbeDeliveryComplete'])
        self.assertTrue(all(v for k, v in report['candidateGates'].items() if k != 'taggedProbeDeliveryComplete'))
        self.assertEqual(report['classification'], 'INSUFFICIENT_OR_NONPOSITIVE_FORWARD_QUOTE_EVIDENCE')

    def test_closed_window_lost_delivery_is_visible_and_blocks_otherwise_positive_candidate(self):
        data = with_delivery_audit(fixture(100), taggedBaselineRows=101, distinctTaggedMints=101,
                                   missingEnrollmentMints=1, status='INCOMPLETE')
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertTrue(report['candidateGates']['frozenEnrollmentWindowClosed'])
        self.assertEqual(report['probeDeliveryAudit']['missingEnrollmentMints'], 1)
        self.assertFalse(report['candidateGates']['taggedProbeDeliveryComplete'])
        self.assertNotEqual(report['classification'], 'SYNTHETIC_THRESHOLDS_MET_NOT_MARKET_EVIDENCE')

    def test_retired_source_delivery_audit_retains_original_context_and_missing_mints(self):
        data = with_delivery_audit(fixture(), taggedBaselineRows=4, distinctTaggedMints=3,
                                   missingEnrollmentMints=2, status='INCOMPLETE')
        original = copy.deepcopy(data)
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['probeDeliveryAudit']['experimentId'], original['protocol']['experimentId'])
        self.assertEqual(report['probeDeliveryAudit']['missingEnrollmentMints'], 2)
        self.assertFalse(report['candidateGates']['taggedProbeDeliveryComplete'])
        self.assertEqual(data, original)

    def test_displaced_first_probe_blocks_delivery_even_with_all_mints_enrolled(self):
        report = f.evaluate(with_delivery_audit(fixture(), taggedBaselineRows=2,
                                               displacedFirstProbeMints=1, status='INCOMPLETE'))
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['probeDeliveryAudit']['displacedFirstProbeMints'], 1)
        self.assertFalse(report['candidateGates']['taggedProbeDeliveryComplete'])

    def test_unmatched_enrollment_cannot_be_complete(self):
        report = f.evaluate(with_delivery_audit(fixture(), taggedBaselineRows=0,
            distinctTaggedMints=0, unmatchedEnrollmentMints=1, status='INCOMPLETE'))
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['probeDeliveryAudit']['unmatchedEnrollmentMints'], 1)
        self.assertFalse(report['candidateGates']['taggedProbeDeliveryComplete'])

    def test_complete_empty_audit_proves_no_positive_outcomes(self):
        report = f.evaluate(with_delivery_audit(fixture(0)))
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['probeDeliveryAudit']['status'], 'COMPLETE')
        self.assertTrue(report['candidateGates']['taggedProbeDeliveryComplete'])
        self.assertFalse(report['candidateGates']['minimumDistinctEnteredTokens'])
        self.assertFalse(report['candidateGates']['positiveConservativeAllEnteredSum'])

    def test_delivery_audit_requires_same_experiment_and_exact_export_cutoff(self):
        for overrides in ({'experimentId': 'other-valid-experiment'}, {'exportedAt': fixture()['exportedAt']-1},
                          {'exportedAt': True}):
            with self.subTest(overrides=overrides):
                self.invalid(with_delivery_audit(fixture(), **overrides))

    def test_delivery_audit_rejects_malformed_envelopes_and_counts(self):
        for bad in (None, [], 'COMPLETE', {}, {'version': True}, {'scope': 'ALL_LAUNCHES'}):
            with self.subTest(bad=bad):
                data = with_delivery_audit(fixture())
                if isinstance(bad, dict):
                    data['probeDeliveryAudit'].update(bad)
                    if not bad:
                        data['probeDeliveryAudit'] = bad
                else:
                    data['probeDeliveryAudit'] = bad
                self.invalid(data)
        keys = ('taggedBaselineRows', 'distinctTaggedMints', 'missingEnrollmentMints',
                'displacedFirstProbeMints', 'unmatchedEnrollmentMints')
        for key in keys:
            for bad in (True, False, -1, 1.0, '1', None, f.SAFE+1):
                with self.subTest(key=key, bad=bad):
                    self.invalid(with_delivery_audit(fixture(), **{key: bad}))
            data = with_delivery_audit(fixture())
            data['probeDeliveryAudit'].pop(key)
            self.invalid(data)

    def test_delivery_audit_cardinality_and_status_must_reconcile_with_enrollment(self):
        for overrides in (
            {'taggedBaselineRows': 0},
            {'taggedBaselineRows': 1, 'distinctTaggedMints': 0},
            {'missingEnrollmentMints': 2, 'status': 'INCOMPLETE'},
            {'displacedFirstProbeMints': 2, 'status': 'INCOMPLETE'},
            {'unmatchedEnrollmentMints': 2, 'status': 'INCOMPLETE'},
            {'distinctTaggedMints': 2, 'taggedBaselineRows': 2},
            {'missingEnrollmentMints': 1, 'displacedFirstProbeMints': 1,
             'unmatchedEnrollmentMints': 1, 'status': 'INCOMPLETE'},
            {'displacedFirstProbeMints': 1, 'status': 'COMPLETE'},
            {'status': 'INCOMPLETE'}, {'status': 'UNKNOWN'}, {'status': True},
        ):
            with self.subTest(overrides=overrides):
                self.invalid(with_delivery_audit(fixture(), **overrides))

    def test_complete_delivery_audit_remains_limited_to_tagged_corpus(self):
        data = with_delivery_audit(fixture(), taggedBaselineRows=3)
        report = f.evaluate(data)
        self.assertEqual(report['probeDeliveryAudit']['taggedBaselineRows'], 3)
        self.assertTrue(report['candidateGates']['taggedProbeDeliveryComplete'])
        self.assertTrue(any('all launches' in limitation for limitation in report['limitations']))
        self.assertEqual(report['profitabilityConclusion'], 'UNPROVEN')
        self.assertFalse(report['liveApproved'])

    def test_empty_is_not_positive(self):
        data = fixture(0)
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT')
        self.assertIsNone(report['onTimeCompleteCase']['meanNetLamportsExact'])
        self.assertFalse(report['candidateGates']['positiveConservativeAllEnteredSum'])

    def test_losing_sample_cannot_be_candidate(self):
        report = f.evaluate(fixture(100, proceeds=9_000_000))
        self.assertFalse(report['candidateGates']['positiveConservativeAllEnteredSum'])
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-102000000')

    def test_missing_exit_retains_zero_proceeds_bound(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['coverage']['exitStatuses'], {'MISSING_RESULT_AFTER_DEADLINE': 1})
        self.assertEqual(report['onTimeCompleteCase']['count'], 0)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-10020000')

    def test_unknown_route_and_late_exit_are_not_winning_observations(self):
        for error in ('FORWARD_QUOTE_PROVIDER_UNAVAILABLE', 'FORWARD_RESPONSE_AFTER_DEADLINE'):
            data = fixture()
            result = phase(data, 'EXIT_RESULT')
            request = phase(data, 'EXIT_REQUEST')
            d = result['data']
            received = d['deadlineAt']+33_000 if 'DEADLINE' in error else result['at']
            result['at'] = received
            d.pop('timedQuote')
            d.update(status='UNAVAILABLE_OR_LATE', requestedAt=request['at'], receivedAt=received, error=error)
            report = f.evaluate(data)
            self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
            self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-10020000')
            self.assertEqual(report['onTimeCompleteCase']['count'], 0)

    def test_future_horizon_not_due_is_separate_pending_exposure(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        data['exportedAt'] = phase(data, 'ENTRY_RESULT')['at']+10_000
        report = f.evaluate(data)
        self.assertEqual(report['coverage']['pendingExits'], 1)
        self.assertEqual(report['pendingExposureIncludedAtZeroProceedsInBound'], 1)
        self.assertFalse(report['candidateGates']['noPendingEpisodes'])
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-10020000')

    def test_entry_missing_before_deadline_is_pending_not_filled(self):
        data = fixture()
        data['records'] = [phase(data, 'ENROLLMENT')]
        data['exportedAt'] = phase(data, 'ENROLLMENT')['at']+1000
        report = f.evaluate(data)
        self.assertEqual(report['coverage']['pendingEntries'], 1)
        self.assertEqual(report['coverage']['validFreshEntries'], 0)
        self.assertEqual(report['allEnteredConservativeBound']['count'], 0)

    def test_interrupted_entry_never_fabricates_inventory(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        result = phase(data, 'ENTRY_RESULT')
        result['data'] = {'status': 'INTERRUPTED_UNKNOWN_NO_RETRY', 'requestId': phase(data, 'ENTRY_REQUEST')['id']}
        report = f.evaluate(data)
        self.assertEqual(report['coverage']['validFreshEntries'], 0)
        self.assertEqual(report['coverage']['entryStatuses']['INTERRUPTED_UNKNOWN_NO_RETRY'], 1)

    def test_interrupted_exit_keeps_entered_loss_bound(self):
        data = fixture()
        result = phase(data, 'EXIT_RESULT')
        result['data'] = {'status': 'INTERRUPTED_UNKNOWN_NO_RETRY', 'requestId': phase(data, 'EXIT_REQUEST')['id']}
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-10020000')

    def test_entry_cache_from_before_due_fails_closed(self):
        data = fixture()
        phase(data, 'ENTRY_RESULT')['data']['timedQuote']['quote']['observedAt'] = phase(data, 'ENROLLMENT')['at']-100
        self.invalid(data, 'QUOTE_TIMING')

    def test_request_before_due_fails_even_if_result_is_later(self):
        data = fixture()
        request = phase(data, 'ENTRY_REQUEST')
        request['at'] -= 1
        request['data']['requestIntentAt'] -= 1
        phase(data, 'ENTRY_RESULT')['data']['timedQuote']['requestedAt'] -= 1
        self.invalid(data, 'REQUEST_IDENTITY')

    def test_quoted_late_exit_cannot_enter_primary_result(self):
        data = fixture()
        result = phase(data, 'EXIT_RESULT')
        result['at'] = result['data']['deadlineAt']+33_000
        result['data']['timedQuote']['receivedAt'] = result['at']
        result['data']['timedQuote']['quote']['observedAt'] = result['at']
        self.invalid(data, 'RESPONSE_AFTER_DEADLINE')

    def test_probe_quantity_cannot_substitute_for_new_entry_quantity(self):
        data = fixture()
        request, result = phase(data, 'EXIT_REQUEST'), phase(data, 'EXIT_RESULT')
        request['data']['amountRaw'] = '1000'
        result['data']['originalQuantityRaw'] = '1000'
        result['data']['timedQuote']['quote']['inAmount'] = '1000'
        self.invalid(data, 'REQUEST_IDENTITY_SIZE')

    def test_canonical_entry_reference_is_required(self):
        data = fixture()
        phase(data, 'EXIT_RESULT')['data']['originalEntryRecordId'] = 'another-entry'
        self.invalid(data, 'EXIT_CANONICAL_ENTRY_REFERENCE')

    def test_result_request_reference_is_required(self):
        data = fixture()
        phase(data, 'ENTRY_RESULT')['data']['requestId'] = 'made-up'
        self.invalid(data, 'RESULT_REQUEST_REFERENCE')

    def test_conflicting_duplicate_invalidates_entire_dataset(self):
        data = fixture()
        duplicate = copy.deepcopy(phase(data, 'ENROLLMENT'))
        duplicate['data']['probeId'] = 'later-cheaper-probe'
        data['records'].append(duplicate)
        self.invalid(data, 'CONFLICTING_DUPLICATE')

    def test_identical_duplicate_is_counted_but_not_double_booked(self):
        data = fixture()
        data['records'].append(copy.deepcopy(phase(data, 'EXIT_RESULT')))
        report = f.evaluate(data)
        self.assertEqual(report['coverage']['identicalDuplicateRecordsIgnored'], 1)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '2000000')

    def test_hash_or_record_configuration_change_fails(self):
        data = fixture()
        data['protocol']['entryToleranceMs'] += 1
        self.invalid(data, 'CONFIGURATION_HASH_MISMATCH')
        data = fixture()
        phase(data, 'ENTRY_RESULT')['configurationHash'] = 'c'*64
        self.invalid(data, 'CONFIGURATION_CHANGED')

    def test_exact_150bps_boundary_and_one_lamport_above(self):
        data = fixture()
        enrollment = phase(data, 'ENROLLMENT')['data']
        enrollment['probeSell']['outAmount'] = enrollment['probeSell']['minOutAmount'] = '9870000'
        enrollment['sequentialStressCostBpsCeiling'] = '150'
        self.assertEqual(f.evaluate(data)['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT')
        enrollment['probeSell']['outAmount'] = enrollment['probeSell']['minOutAmount'] = '9869999'
        enrollment['sequentialStressCostBpsCeiling'] = '151'
        self.invalid(data, 'FLAGS_CONTRADICT')

    def test_embedded_profit_and_costaudit_are_never_used(self):
        data = fixture(proceeds=9_000_000)
        data['costAudit'] = {'profit': 10**99, 'everythingProfitable': True}
        phase(data, 'EXIT_RESULT')['data']['hypotheticalHorizonNetLamports'] = '9999999999999'
        report = f.evaluate(data)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-1020000')

    def test_booleans_are_not_integer_time_amount_or_slot(self):
        for target in ('export', 'slot', 'quote', 'protocol'):
            data = fixture()
            if target == 'export': data['exportedAt'] = True
            elif target == 'slot': phase(data, 'ENROLLMENT')['data']['slot'] = True
            elif target == 'quote': phase(data, 'ENTRY_RESULT')['data']['timedQuote']['quote']['inAmount'] = True
            else:
                data['protocol']['minimumUtcDays'] = True
                data['protocol']['configurationHash'] = f.configuration_hash(data['protocol'])
            self.invalid(data)

    def test_orphan_records_and_future_records_fail(self):
        data = fixture()
        data['records'] = data['records'][1:]
        self.invalid(data, 'ORPHAN')
        data = fixture()
        data['exportedAt'] = phase(data, 'ENTRY_REQUEST')['at']
        self.invalid(data, 'RECORD_TIME')

    def test_probe_identity_reused_across_mints_fails(self):
        data = fixture(2)
        phase(data, 'ENROLLMENT', 1)['data']['probeId'] = phase(data, 'ENROLLMENT')['data']['probeId']
        self.invalid(data, 'PROBE_ID_MISSING_OR_REUSED')

    def test_capacity_cannot_be_bypassed_with_eligibility_flags(self):
        data = fixture(2)
        second_mint = phase(data, 'ENROLLMENT', 1)['mint']
        shift = 30*60_000-1000
        def shift_times(value):
            if isinstance(value, dict):
                for key, child in value.items():
                    if key in ('at', 'decisionAt', 'eventObservedAt', 'probeStartedAt', 'probeCompletedAt', 'observedAt', 'entryDueAt', 'entryDeadlineAt', 'dueAt', 'deadlineAt', 'requestedAt', 'receivedAt'):
                        value[key] -= shift
                    else: shift_times(child)
        for row in data['records']:
            if row['mint'] == second_mint: shift_times(row)
        self.invalid(data, 'FLAGS_CONTRADICT')

    def test_worst_case_missing_exit_cannot_improve_winning_sample(self):
        data = fixture(4)
        before = f.evaluate(data)
        mint = phase(data, 'ENROLLMENT', 3)['mint']
        data['records'] = [r for r in data['records'] if not (r['mint'] == mint and r['phase'].startswith('EXIT'))]
        after = f.evaluate(data)
        self.assertLess(int(after['allEnteredConservativeBound']['netLamportsSum']), int(before['allEnteredConservativeBound']['netLamportsSum']))

    def test_window_open_even_large_sample_is_not_candidate(self):
        data = fixture(100)
        data['exportedAt'] = max(r['at'] for r in data['records'])+1
        report = f.evaluate(data)
        self.assertFalse(report['candidateGates']['frozenEnrollmentWindowClosed'])
        self.assertEqual(report['classification'], 'INSUFFICIENT_OR_NONPOSITIVE_FORWARD_QUOTE_EVIDENCE')

    def test_raw_sum_and_mean_remain_exact_above_float_precision(self):
        data = fixture(2, proceeds=18_000_000_000_000_001)
        report = f.evaluate(data)
        total = 2*(18_000_000_000_000_001-10_000_000-20_000)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], str(total))
        self.assertEqual(report['allEnteredConservativeBound']['meanNetLamportsExact']['numerator'], str(total//2))

    def test_canonical_json_matches_known_sorted_compact_hash(self):
        value = {'z': [True, None, 2], 'a': 'text'}
        self.assertEqual(f.canonical(value), '{"a":"text","z":[true,null,2]}')
        with self.assertRaises(f.Invalid): f.canonical({'a': 1.0})
        with self.assertRaises(f.Invalid): f.raw('01')
        with self.assertRaises(f.Invalid): f.raw('0')

    def test_typescript_default_protocol_hash_golden(self):
        # Independently generated by Node freezeForwardProtocol, not this Python helper.
        self.assertEqual(protocol()['configurationHash'], 'b603200c5245e025a3c57a66c22564f004288bf358b30ffb5e6274f750b12712')

    def test_minimum_output_cannot_exceed_frozen_slippage_loss(self):
        data = fixture()
        phase(data, 'ENTRY_RESULT')['data']['timedQuote']['quote']['outAmount'] = '1000000'
        self.invalid(data, 'MINIMUM_INVALID')

    def test_zero_quantity_and_wrong_mint_fail_closed(self):
        data = fixture()
        phase(data, 'ENTRY_RESULT')['data']['timedQuote']['quote']['minOutAmount'] = '0'
        self.invalid(data, 'AMOUNT_OUTSIDE_U64')
        data = fixture()
        phase(data, 'EXIT_RESULT')['data']['timedQuote']['quote']['outputMint'] = 'wrong-mint'
        self.invalid(data, 'QUOTE_MINT_OR_EXACT_SIZE')

    def test_positive_total_reliant_on_top_three_fails_robustness_gate(self):
        data = fixture(100, proceeds=9_920_000)
        for result in [r for r in data['records'] if r['phase']=='EXIT_RESULT'][:3]:
            result['data']['timedQuote']['quote']['outAmount'] = '40000000'
            result['data']['timedQuote']['quote']['minOutAmount'] = '40000000'
        report = f.evaluate(data)
        self.assertTrue(report['candidateGates']['positiveConservativeAllEnteredSum'])
        self.assertFalse(report['candidateGates']['positiveAfterRemovingThreeLargestWinners'])

    def test_explicit_missed_deadline_result_without_request_is_valid_loss_bound(self):
        data = fixture()
        request, result = phase(data, 'EXIT_REQUEST'), phase(data, 'EXIT_RESULT')
        due, deadline = request['data']['dueAt'], request['data']['deadlineAt']
        data['records'].remove(request)
        result['at'] = deadline+1
        result['data'] = {'status':'MISSED_DEADLINE_NO_QUOTE','dueAt':due,'deadlineAt':deadline}
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-10020000')

    def test_failed_quote_entry_remains_zero_opportunity_not_a_position(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        result, request = phase(data, 'ENTRY_RESULT'), phase(data, 'ENTRY_REQUEST')
        result['data'] = {'status':'UNAVAILABLE_OR_LATE','requestId':request['id'],
            'requestedAt':request['at'],'receivedAt':result['at'],
            'dueAt':request['data']['dueAt'],'deadlineAt':request['data']['deadlineAt'],
            'error':'FORWARD_QUOTE_PROVIDER_UNAVAILABLE'}
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['coverage']['validFreshEntries'], 0)
        self.assertEqual(report['allAdmittedOpportunityBound']['count'], 1)
        self.assertEqual(report['allAdmittedOpportunityBound']['netLamportsSum'], '0')

    def test_persisted_request_intent_may_precede_actual_request(self):
        data = fixture()
        result = phase(data, 'ENTRY_RESULT')
        intent = phase(data, 'ENTRY_REQUEST')['at']
        result['data']['timedQuote']['requestedAt'] = intent+25
        result['data']['timedQuote']['quote']['observedAt'] = intent+30
        # Exit target follows the changed actual entry quote time.
        for row in data['records']:
            if row['phase'].startswith('EXIT'):
                row['at'] += 10
                for key in ('requestIntentAt','requestedAt','receivedAt','dueAt','deadlineAt'):
                    if key in row['data']: row['data'][key] += 10
                if 'timedQuote' in row['data']:
                    row['data']['timedQuote']['requestedAt'] += 10
                    row['data']['timedQuote']['receivedAt'] += 10
                    row['data']['timedQuote']['quote']['observedAt'] += 10
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['coverage']['onTimeExits'], 1)

    def test_quote_after_intent_but_before_actual_request_is_invalid(self):
        data = fixture()
        result = phase(data, 'ENTRY_RESULT')
        result['data']['timedQuote']['requestedAt'] = phase(data, 'ENTRY_REQUEST')['at']+25
        self.invalid(data, 'QUOTE_TIMING')

    def test_reported_network_starts_are_separate_from_invocation_and_legacy_times(self):
        data = fixture()
        for result_phase, request_phase in [('ENTRY_RESULT', 'ENTRY_REQUEST'), ('EXIT_RESULT', 'EXIT_REQUEST')]:
            timed = phase(data, result_phase)['data']['timedQuote']
            invocation = phase(data, request_phase)['at']+5
            timed.update(providerInvocationAt=invocation, requestedAt=invocation+5,
                         timingEvidence='PROVIDER_REPORTED_REQUEST_START')
            timed['quote']['requestedAt'] = invocation+5
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['coverage']['requestTimingEvidence'], {'PROVIDER_REPORTED_REQUEST_START': 2})
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '2000000')
        legacy = f.evaluate(fixture())
        self.assertEqual(legacy['coverage']['requestTimingEvidence'], {'LEGACY_REQUEST_TIME_UNPROVEN': 2})

    def test_invocation_only_quotes_do_not_invent_request_starts(self):
        data = fixture()
        for result_phase, request_phase in [('ENTRY_RESULT', 'ENTRY_REQUEST'), ('EXIT_RESULT', 'EXIT_REQUEST')]:
            timed = phase(data, result_phase)['data']['timedQuote']
            timed.pop('requestedAt')
            timed.update(providerInvocationAt=phase(data, request_phase)['at'], timingEvidence='PROVIDER_INVOCATION_ONLY')
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['coverage']['requestTimingEvidence'], {'PROVIDER_INVOCATION_ONLY': 2})
        phase(data, 'ENTRY_RESULT')['data']['timedQuote']['requestedAt'] = phase(data, 'ENTRY_REQUEST')['at']
        self.invalid(data, 'INVOCATION_ONLY_CANNOT_CLAIM_NETWORK_REQUEST')

    def test_inconsistent_or_pre_invocation_reported_request_times_fail_closed(self):
        for fault in ('pre-invocation', 'after-observation', 'missing-copy', 'missing-start', 'unknown-kind', 'boolean-clock'):
            with self.subTest(fault=fault):
                data = fixture()
                timed = phase(data, 'ENTRY_RESULT')['data']['timedQuote']
                invocation = phase(data, 'ENTRY_REQUEST')['at']
                timed.update(providerInvocationAt=invocation, requestedAt=invocation+5,
                             timingEvidence='PROVIDER_REPORTED_REQUEST_START')
                timed['quote']['requestedAt'] = invocation+5
                if fault == 'pre-invocation': timed['requestedAt'] = timed['quote']['requestedAt'] = invocation-1
                elif fault == 'after-observation': timed['requestedAt'] = timed['quote']['requestedAt'] = invocation+21
                elif fault == 'missing-copy': timed['quote'].pop('requestedAt')
                elif fault == 'missing-start': timed.pop('requestedAt')
                elif fault == 'unknown-kind': timed['timingEvidence'] = 'TRUSTED_NETWORK'
                elif fault == 'boolean-clock': timed['providerInvocationAt'] = True
                self.invalid(data)

    def test_legacy_rows_cannot_be_relabelled_with_an_unmarked_nested_actual_request(self):
        data = fixture()
        timed = phase(data, 'ENTRY_RESULT')['data']['timedQuote']
        timed['quote']['requestedAt'] = timed['requestedAt']
        self.invalid(data, 'LEGACY_REQUEST_TIMING_INVALID_OR_RELABELLED')

    def test_late_queued_request_starts_are_explicit_failed_observations(self):
        for entry in (True, False):
            with self.subTest(entry=entry):
                data = fixture()
                if entry:
                    data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
                request = phase(data, 'ENTRY_REQUEST' if entry else 'EXIT_REQUEST')
                result = phase(data, 'ENTRY_RESULT' if entry else 'EXIT_RESULT')
                deadline = request['data']['deadlineAt']
                result['at'] = deadline+200
                result['data'] = {'status':'UNAVAILABLE_OR_LATE', 'requestId':request['id'],
                    'dueAt':request['data']['dueAt'], 'deadlineAt':deadline, 'providerCalled':True,
                    'providerInvocationAt':request['at'], 'requestedAt':deadline+100,
                    'receivedAt':result['at'], 'timingEvidence':'PROVIDER_REPORTED_REQUEST_START',
                    'error':'FORWARD_REQUEST_START_AFTER_DEADLINE'}
                report = f.evaluate(data)
                self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
                self.assertEqual(report['allAdmittedOpportunityBound']['netLamportsSum'], '0' if entry else '-10020000')
                result['data']['error'] = 'FORWARD_RESPONSE_AFTER_DEADLINE'
                self.invalid(data, 'ACTUAL_REQUEST_OUTSIDE_WINDOW')

    def test_new_no_provider_call_evidence_never_records_a_fictional_start(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        request, result = phase(data, 'ENTRY_REQUEST'), phase(data, 'ENTRY_RESULT')
        result['at'] = request['data']['deadlineAt']+10
        result['data'] = {'status':'UNAVAILABLE_OR_LATE', 'requestId':request['id'],
            'dueAt':request['data']['dueAt'], 'deadlineAt':request['data']['deadlineAt'],
            'providerCalled':False, 'receivedAt':result['at'], 'timingEvidence':'NO_PROVIDER_CALL',
            'error':'FORWARD_INTENT_PERSISTENCE_DELAY'}
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        result['data']['requestedAt'] = result['at']
        self.invalid(data, 'INVALID_INTENT_PERSISTENCE_DELAY_EVIDENCE')

    def test_unrecognized_provider_error_text_is_not_reexported(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        request, result = phase(data, 'ENTRY_REQUEST'), phase(data, 'ENTRY_RESULT')
        result['data'] = {'status':'UNAVAILABLE_OR_LATE', 'requestId':request['id'],
            'dueAt':request['data']['dueAt'], 'deadlineAt':request['data']['deadlineAt'],
            'providerCalled':True, 'receivedAt':result['at'], 'providerInvocationAt':request['at'],
            'timingEvidence':'PROVIDER_INVOCATION_ONLY', 'error':'FORWARD_PRIVATE_TOKEN_SHOULD_NOT_BE_SAVED'}
        report = self.invalid(data, 'UNRECOGNIZED_QUOTE_ERROR_NOT_SAFE_TO_REEXPORT')
        self.assertNotIn('PRIVATE_TOKEN', json.dumps(report))

    def test_probe_reported_sell_request_cannot_precede_observed_buy_quantity(self):
        data = fixture()
        enrollment = phase(data, 'ENROLLMENT')['data']
        enrollment['probeBuy']['requestedAt'] = enrollment['probeStartedAt']
        enrollment['probeSell']['requestedAt'] = enrollment['probeBuy']['observedAt']
        self.assertEqual(f.evaluate(data)['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT')
        enrollment['probeSell']['requestedAt'] -= 1
        self.invalid(data, 'FLAGS_CONTRADICT')

    def test_slow_intent_persistence_consumes_deadline_without_provider_call(self):
        data = fixture()
        data['records'] = [r for r in data['records'] if not r['phase'].startswith('EXIT')]
        request, result = phase(data, 'ENTRY_REQUEST'), phase(data, 'ENTRY_RESULT')
        actual = request['data']['deadlineAt']+10
        result['at'] = actual
        result['data'] = {'status':'UNAVAILABLE_OR_LATE','requestId':request['id'],
            'dueAt':request['data']['dueAt'],'deadlineAt':request['data']['deadlineAt'],
            'requestedAt':actual,'receivedAt':actual,'providerCalled':False,
            'error':'FORWARD_INTENT_PERSISTENCE_DELAY'}
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['coverage']['validFreshEntries'], 0)
        result['data']['providerCalled'] = True
        self.invalid(data, 'ACTUAL_REQUEST_OUTSIDE_WINDOW')

    def test_slow_exit_intent_without_provider_call_retains_canonical_size_loss(self):
        data = fixture()
        request, result = phase(data, 'EXIT_REQUEST'), phase(data, 'EXIT_RESULT')
        actual = request['data']['deadlineAt']+10
        result['at'] = actual
        result['data'] = {'status':'UNAVAILABLE_OR_LATE','requestId':request['id'],
            'dueAt':request['data']['dueAt'],'deadlineAt':request['data']['deadlineAt'],
            'requestedAt':actual,'receivedAt':actual,'providerCalled':False,
            'error':'FORWARD_INTENT_PERSISTENCE_DELAY'}
        report = f.evaluate(data)
        self.assertEqual(report['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT', report)
        self.assertEqual(report['allEnteredConservativeBound']['netLamportsSum'], '-10020000')
        result['data']['originalQuantityRaw'] = '1000'
        self.invalid(data, 'EXIT_CANONICAL_ENTRY_REFERENCE_OR_QUANTITY_CHANGED')

    def test_cli_is_offline_and_writes_explicit_output(self):
        saved = []
        with patch.object(f.Path, 'read_text', return_value=json.dumps(fixture())), patch.object(f.Path, 'mkdir'), patch.object(f.Path, 'write_text', side_effect=lambda value, **kwargs: saved.append(value)), patch('builtins.print'):
            self.assertEqual(f.main(['--input', 'synthetic.json', '--output', 'synthetic-report.json']), 0)
        self.assertEqual(json.loads(saved[0])['profitabilityConclusion'], 'UNPROVEN')


if __name__ == '__main__':
    unittest.main()
