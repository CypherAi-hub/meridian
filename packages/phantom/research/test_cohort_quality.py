"""Mutation tests against synthetic contracts, never market evidence."""
import copy
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from urllib.error import HTTPError

import cohort_quality as q
import forward_cohort as f
from capture_cohort_quality import capture, loopback_get
from test_forward_cohort import fixture, phase, with_delivery_audit


def envelope(count=1):
    export = with_delivery_audit(fixture(count))
    p, rows = export['protocol'], []
    for e in export['records']:
        if e['phase'] != 'ENROLLMENT':
            continue
        d = e['data']
        packet = {'id': d['probeId'], 'mint': e['mint'], 'signature': d['signature'],
                  'slot': d['slot'], 'protocol': d['protocol'], 'kind': d['kind'],
                  'eventObservedAt': d['eventObservedAt'], 'startedAt': d['probeStartedAt'],
                  'completedAt': d['probeCompletedAt'], 'amountLamports': d['amountLamports'],
                  'buy': copy.deepcopy(d['probeBuy']), 'sell': copy.deepcopy(d['probeSell'])}
        row = copy.deepcopy(packet)
        row.update(phase='BASELINE', schedulingPolicy='FORWARD_BUDGET_RESERVED_V3',
                   forwardExperimentId=p['experimentId'], forwardProbe=packet)
        rows.append(row)
    return {'cohort': export, 'observations': rows, 'capture': {
        'sourceVersion': p['runtimeSourceVersion'], 'configurationHash': p['configurationHash'],
        'enrollmentStable': True, 'taggedInventoryStable': True,
        'observationCount': len(rows), 'apiObservationLimit': 10000}}


class QualityTests(unittest.TestCase):
    def invalid(self, data, reason):
        result = q.audit(data)
        self.assertEqual(result['auditStatus'], 'INVALID_OR_INCOMPLETE_SAVED_CORPUS', result)
        self.assertIn(reason, result['errors'][0])
        self.assertEqual(result['profitabilityConclusion'], 'UNPROVEN')
        self.assertFalse(result['liveApproved'])

    def test_consistent_contract_stays_unproven_and_does_not_mutate_input(self):
        data = envelope(3)
        before = copy.deepcopy(data)
        result = q.audit(data)
        self.assertEqual(result['auditStatus'], 'CONSISTENT_SAVED_CORPUS', result)
        self.assertEqual(result['distinctFirstProbes'], 3)
        self.assertEqual(result['missingOutcomeSensitivity']['completeCaseQuotedNetLamports'], '6000000')
        self.assertEqual(data, before)
        self.assertEqual(result['profitabilityConclusion'], 'UNPROVEN')
        self.assertFalse(result['liveApproved'])

    def test_claimed_complete_native_inventory_cannot_hide_earlier_raw_probe(self):
        data = envelope()
        earlier = copy.deepcopy(data['observations'][0])
        earlier['id'] = earlier['forwardProbe']['id'] = 'earlier-probe'
        for obj in (earlier, earlier['forwardProbe']):
            for key in ('eventObservedAt', 'startedAt', 'completedAt'):
                obj[key] -= 500
            for side in ('buy', 'sell'):
                obj[side]['observedAt'] -= 500
        data['observations'].append(earlier)
        data['capture']['observationCount'] = 2
        data['cohort']['probeDeliveryAudit']['taggedBaselineRows'] = 2
        self.assertEqual(f.evaluate(data['cohort'])['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT')
        self.invalid(data, 'FIRST_PROBE_DISPLACED')

    def test_durable_packet_must_match_original_baseline(self):
        data = envelope()
        data['observations'][0]['forwardProbe']['signature'] = '2'*64
        self.invalid(data, 'DURABLE_PACKET_DIFFERS')

    def test_durable_quote_must_match_original_baseline(self):
        data = envelope()
        data['observations'][0]['forwardProbe']['buy']['outAmount'] = '2000'
        self.invalid(data, 'DURABLE_PACKET_QUOTE_DIFFERS')

    def test_matching_raw_packet_cannot_replace_journal_quote(self):
        data = envelope()
        row = data['observations'][0]
        row['buy']['outAmount'] = row['forwardProbe']['buy']['outAmount'] = '2000'
        self.invalid(data, 'ENROLLMENT_QUOTE_DIFFERS')

    def test_originally_valid_quote_cannot_be_omitted_to_hide_eligible_probe(self):
        data = envelope(2)
        enrollment = phase(data['cohort'], 'ENROLLMENT')
        enrollment['data'].pop('probeBuy')
        enrollment['data'].pop('probeSell')
        enrollment['data'].update(costQualified=False, admitted=False, reasons=['PROBE_QUOTES_UNAVAILABLE_OR_INVALID'])
        data['cohort']['records'] = [r for r in data['cohort']['records']
                                    if r['mint'] != enrollment['mint'] or r['phase'] == 'ENROLLMENT']
        self.assertEqual(f.evaluate(data['cohort'])['datasetStatus'], 'VALIDATED_OFFLINE_RECORD_CONTRACT')
        self.invalid(data, 'ENROLLMENT_QUOTE_DIFFERS')

    def test_duplicate_journal_retransmission_does_not_inflate_timing_counts(self):
        data = envelope(2)
        data['cohort']['records'].append(copy.deepcopy(phase(data['cohort'], 'EXIT_RESULT')))
        result = q.audit(data)
        self.assertEqual(result['auditStatus'], 'CONSISTENT_SAVED_CORPUS', result)
        self.assertEqual(len(result['quoteTiming']['EXIT']), 2)

    def test_malformed_packet_is_a_fixed_invalid_result_not_an_exception(self):
        data = envelope()
        data['observations'][0]['forwardProbe'] = []
        self.invalid(data, 'DURABLE_PACKET_MUST_BE_AN_OBJECT')

    def test_metadata_boolean_cannot_impersonate_integer_slot(self):
        data = envelope()
        row = data['observations'][0]
        row['slot'] = row['forwardProbe']['slot'] = True
        self.invalid(data, 'ENROLLMENT_METADATA_DIFFERS')

    def test_overlapping_saved_probes_have_ambiguous_first_order(self):
        data = envelope()
        overlap = copy.deepcopy(data['observations'][0])
        overlap['id'] = overlap['forwardProbe']['id'] = 'overlap'
        data['observations'].append(overlap)
        data['capture']['observationCount'] = 2
        data['cohort']['probeDeliveryAudit']['taggedBaselineRows'] = 2
        self.invalid(data, 'OVERLAPPING_BASELINES')

    def test_missing_raw_probe_and_duplicate_record_fail_closed(self):
        data = envelope()
        data['observations'] = []
        data['capture']['observationCount'] = 0
        self.invalid(data, 'TAGGED_CORPUS_COUNT')
        data = envelope()
        data['observations'].append(copy.deepcopy(data['observations'][0]))
        data['capture']['observationCount'] = 2
        self.invalid(data, 'DUPLICATE_CORPUS_RECORD')

    def test_truncation_source_change_and_unstable_capture_rejected(self):
        for field, value, reason in (
            ('apiObservationLimit', 1, 'CORPUS_COVERAGE_UNPROVEN'),
            ('sourceVersion', 'c'*64, 'SOURCE_OR_PROTOCOL_MISMATCH'),
            ('configurationHash', 'c'*64, 'SOURCE_OR_PROTOCOL_MISMATCH'),
            ('enrollmentStable', False, 'UNSTABLE_CAPTURE'),
            ('taggedInventoryStable', False, 'UNSTABLE_CAPTURE'),
            ('observationCount', 2, 'CORPUS_ROW_COUNT')):
            with self.subTest(field=field):
                data = envelope()
                data['capture'][field] = value
                self.invalid(data, reason)

    def test_untagged_prospective_probe_cannot_be_ignored(self):
        data = envelope()
        data['observations'][0].pop('forwardExperimentId')
        self.invalid(data, 'PROSPECTIVE_V3_BASELINE_WITHOUT_DELIVERY_TAG')

    def test_old_untagged_backlog_does_not_displace_prospective_mint(self):
        data = envelope()
        old = copy.deepcopy(data['observations'][0])
        old.update(id='old', eventObservedAt=data['cohort']['protocol']['enrollmentStart']-1000)
        old.pop('forwardExperimentId')
        old.pop('forwardProbe')
        data['observations'].append(old)
        data['capture']['observationCount'] = 2
        self.assertEqual(q.audit(data)['auditStatus'], 'CONSISTENT_SAVED_CORPUS')

    def test_previous_journal_records_cannot_change_or_disappear(self):
        for mutation in ('change', 'remove', 'protocol'):
            with self.subTest(mutation=mutation):
                data = envelope()
                data['referenceCohort'] = copy.deepcopy(data['cohort'])
                if mutation == 'change':
                    data['referenceCohort']['records'][0]['data']['reasons'] = ['forged']
                elif mutation == 'remove':
                    extra = copy.deepcopy(data['referenceCohort']['records'][0])
                    extra['id'] = 'no-longer-present'
                    data['referenceCohort']['records'].append(extra)
                else:
                    data['referenceCohort']['protocol']['sourceCommit'] = 'c'*40
                self.invalid(data, 'REFERENCE_PROTOCOL_CHANGED' if mutation == 'protocol' else 'PREVIOUSLY_SAVED_RECORD')

    def test_retained_reference_is_verified_by_content(self):
        data = envelope(2)
        data['referenceCohort'] = copy.deepcopy(data['cohort'])
        data['referenceCohort']['records'] = data['referenceCohort']['records'][:5]
        self.assertEqual(q.audit(data)['retainedReferenceRecords'], 5)

    def test_complete_case_gain_does_not_hide_missing_exit(self):
        data = envelope(2)
        last = phase(data['cohort'], 'ENROLLMENT', 1)['mint']
        data['cohort']['records'] = [r for r in data['cohort']['records']
                                    if not (r['mint'] == last and r['phase'].startswith('EXIT'))]
        result = q.audit(data)
        self.assertEqual(result['auditStatus'], 'CONSISTENT_SAVED_CORPUS', result)
        sensitivity = result['missingOutcomeSensitivity']
        self.assertEqual(sensitivity['completeCaseQuotedNetLamports'], '2000000')
        self.assertEqual(sensitivity['allEnteredZeroProceedsBoundLamports'], '-8020000')
        self.assertEqual(sensitivity['unobservedAggregateProceedsForBreakEvenLamports'], '8020000')
        self.assertEqual(sensitivity['unobservedAggregateProceedsForStrictlyPositiveLamports'], '8020001')

    def test_no_completed_sample_is_unknown_not_a_zero_return(self):
        data = envelope()
        data['cohort']['records'] = [r for r in data['cohort']['records'] if not r['phase'].startswith('EXIT')]
        result = q.audit(data)
        self.assertEqual(result['auditStatus'], 'CONSISTENT_SAVED_CORPUS', result)
        self.assertIsNone(result['missingOutcomeSensitivity']['completeCaseQuotedNetLamports'])
        self.assertEqual(result['missingOutcomeSensitivity']['completeCaseCount'], 0)

    def test_empty_valid_cohort_remains_valid_without_return_estimates(self):
        data = envelope(0)
        result = q.audit(data)
        self.assertEqual(result['auditStatus'], 'CONSISTENT_SAVED_CORPUS', result)
        self.assertIsNone(result['missingOutcomeSensitivity']['allEnteredZeroProceedsBoundLamports'])

    def test_generic_failure_before_deadline_does_not_prove_lateness_or_http_cause(self):
        data = envelope()
        export = data['cohort']
        result, request = phase(export, 'EXIT_RESULT'), phase(export, 'EXIT_REQUEST')
        result['data'].pop('timedQuote')
        result['data'].update(status='UNAVAILABLE_OR_LATE', requestedAt=request['at'],
                              receivedAt=result['at'], error='FORWARD_QUOTE_PROVIDER_UNAVAILABLE')
        audited = q.audit(data)
        self.assertEqual(audited['auditStatus'], 'CONSISTENT_SAVED_CORPUS', audited)
        failure = audited['unavailableObservations'][0]
        self.assertTrue(failure['observedBeforeDeadline'])
        self.assertEqual(failure['exactProviderFailureCause'], 'UNIDENTIFIABLE_FROM_GENERIC_RECORDED_ERROR')

    def test_restart_interruption_with_no_embedded_deadline_uses_request_schedule(self):
        data = envelope()
        row = phase(data['cohort'], 'EXIT_RESULT')
        row['data'] = {'status': 'INTERRUPTED_UNKNOWN_NO_RETRY',
                       'requestId': phase(data['cohort'], 'EXIT_REQUEST')['id']}
        audited = q.audit(data)
        self.assertEqual(audited['auditStatus'], 'CONSISTENT_SAVED_CORPUS', audited)
        self.assertTrue(audited['unavailableObservations'][0]['observedBeforeDeadline'])

    def test_actual_minima_above_configured_floor_are_not_assumed_to_lose_100bps(self):
        result = q.audit(envelope())
        self.assertEqual(result['observedMinimumOutputDiscountsBps']['floorCounts'], {'aboveConfiguredFloor': 2})
        self.assertEqual(result['observedMinimumOutputDiscountsBps']['maximum']['numerator'], '0')

    def test_legacy_request_time_does_not_become_reported_network_start(self):
        result = q.audit(envelope())
        timing = result['quoteTiming']['ENTRY'][0]
        self.assertIsNone(timing['reportedNetworkStart'])
        self.assertIsNotNone(timing['legacyOrInvocationTimeLowerBound'])
        self.assertIsNone(timing['queueDelayMs'])

    def test_explicit_empty_or_malformed_reference_cannot_skip_retention_check(self):
        for value in ({}, None, []):
            data = envelope()
            data['referenceCohort'] = value
            self.invalid(data, 'REFERENCE_COHORT_SCHEMA_INVALID')

    def test_genuinely_unavailable_original_quotes_can_be_rejected_without_projection(self):
        data = envelope()
        e = phase(data['cohort'], 'ENROLLMENT')
        for obj in (data['observations'][0], data['observations'][0]['forwardProbe']):
            obj.pop('buy'); obj.pop('sell')
        e['data'].pop('probeBuy'); e['data'].pop('probeSell')
        e['data'].update(costQualified=False, admitted=False, reasons=['PROBE_QUOTES_UNAVAILABLE_OR_INVALID'])
        data['cohort']['records'] = [e]
        self.assertEqual(q.audit(data)['auditStatus'], 'CONSISTENT_SAVED_CORPUS')

    def test_malformed_payloads_fail_closed(self):
        for data in (None, {}, {'cohort': None}, {'cohort': fixture(), 'observations': [None], 'capture': {}}):
            with self.subTest(data=data):
                self.assertEqual(q.audit(data)['auditStatus'], 'INVALID_OR_INCOMPLETE_SAVED_CORPUS')

    def test_loopback_capture_retries_a_changing_inventory_without_saving_mixed_snapshot(self):
        data = envelope()
        changed = copy.deepcopy(data['cohort'])
        changed['probeDeliveryAudit']['taggedBaselineRows'] += 1
        answers = iter((changed, {'observations': data['observations']}, data['cohort'],
                        {'sourceVersion': data['capture']['sourceVersion']},
                        data['cohort'], {'observations': data['observations']}, data['cohort'],
                        {'sourceVersion': data['capture']['sourceVersion']}))
        paths = []
        def get(path):
            paths.append(path)
            return next(answers)
        result = capture(get)
        self.assertEqual(result['capture']['attempt'], 2)
        self.assertEqual(paths, ['/forward-cohort', '/quote-research', '/forward-cohort', '/state']*2)
        self.assertEqual(result['capture']['journalDigestBefore'], result['capture']['journalDigestAfter'])

    def test_loopback_capture_has_a_bounded_failure_when_source_keeps_changing(self):
        data, calls = envelope(), []
        def get(path):
            calls.append(path)
            return {'/forward-cohort': data['cohort'], '/quote-research': {'observations': data['observations']},
                    '/state': {'sourceVersion': 'changed'}}[path]
        with self.assertRaisesRegex(ValueError, 'NO_STABLE_CONSISTENT'):
            capture(get, attempts=2)
        self.assertEqual(len(calls), 8)

    def test_http_redirect_is_refused_before_any_followup_request(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append(self.path)
                self.send_response(302)
                self.send_header('Location', '/redirect-target')
                self.end_headers()
            def log_message(self, *_):
                pass
        with HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                with self.assertRaises(HTTPError) as raised:
                    loopback_get(server.server_port, '/forward-cohort')
                self.assertEqual(raised.exception.code, 302)
                self.assertEqual(requests, ['/forward-cohort'])
            finally:
                server.shutdown()
                thread.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
