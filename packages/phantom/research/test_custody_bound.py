"""Synthetic arithmetic/CLI regressions; no observed pool or ownership evidence."""
import copy
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from math import isqrt
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import custody_bound as c


def synthetic_snapshot(**overrides):
    amounts = {
        'baseSupplyRaw': '1000000', 'baseVaultRaw': '950000',
        'baseProtocolFeesRaw': '0', 'baseFundFeesRaw': '0', 'baseCreatorFeesRaw': '0',
        'quoteVaultRaw': '20000000000', 'quoteProtocolFeesRaw': '0',
        'quoteFundFeesRaw': '0', 'quoteCreatorFeesRaw': '0',
        'internalLpSupplyRaw': '1000000', 'actualLpSupplyRaw': '50000',
    }
    amounts.update(overrides)
    return {'kind': c.INPUT_KIND, 'amounts': amounts}


class SyntheticCustodyArithmeticTests(unittest.TestCase):
    def test_exact_contract_and_95_percent_example(self):
        result = c.evaluate(synthetic_snapshot())
        self.assertEqual(result, {
            'kind': 'CONDITIONAL_ARITHMETIC_NOT_A_CUSTODY_CERTIFICATE',
            'amounts': {
                'netBaseReserveRaw': '950000', 'netQuoteReserveLamports': '20000000000',
                'unmintedOrBurnedLpRaw': '950000', 'redeemablePrincipalUpperRaw': '47500',
                'excludedPrincipalLowerRaw': '902500', 'creatorSupplyUpperRaw': '97500',
                'creatorSupplyUpperBps': '975',
            },
            'creatorCapSatisfied': True, 'liquidityFloorSatisfied': True,
            'arithmeticCandidate': True, 'liveApproved': False,
        })

    def test_exact_cap_and_supply_indivisibility(self):
        for supply, base, expected, bps in [('100', '90', True, '1000'),
                ('101', '90', False, '1090'), ('101', '91', True, '991')]:
            with self.subTest(supply=supply, base=base):
                result = c.evaluate(synthetic_snapshot(baseSupplyRaw=supply,
                    baseVaultRaw=base, actualLpSupplyRaw='0'))
                self.assertEqual(result['creatorCapSatisfied'], expected)
                self.assertEqual(result['amounts']['creatorSupplyUpperBps'], bps)

    def test_liquidity_floor_counts_each_fee_once(self):
        for gross, expected in [('20000000005', False), ('20000000006', True)]:
            result = c.evaluate(synthetic_snapshot(quoteVaultRaw=gross,
                quoteProtocolFeesRaw='1', quoteFundFeesRaw='2', quoteCreatorFeesRaw='3'))
            self.assertEqual(result['liquidityFloorSatisfied'], expected)
            self.assertEqual(result['arithmeticCandidate'], expected)
            self.assertEqual(result['amounts']['netQuoteReserveLamports'],
                             str(int(gross) - 6))

    def test_sharp_fee_boundary_includes_fractional_residual(self):
        for fees, expected_excluded, expected_pass in [(2631, 900001, True),
                (2632, 900000, True), (2633, 899999, False)]:
            with self.subTest(fees=fees):
                # Exercise all fee buckets and preserve their exact integer sum.
                result = c.evaluate(synthetic_snapshot(baseProtocolFeesRaw='1000',
                    baseFundFeesRaw='1000', baseCreatorFeesRaw=str(fees - 2000)))
                self.assertEqual(result['amounts']['excludedPrincipalLowerRaw'],
                                 str(expected_excluded))
                self.assertEqual(result['creatorCapSatisfied'], expected_pass)

    def test_initial_100_unminted_units_are_counted_once(self):
        result = c.evaluate(synthetic_snapshot(baseSupplyRaw='1000', baseVaultRaw='1000',
            internalLpSupplyRaw='1000', actualLpSupplyRaw='900'))
        self.assertEqual(result['amounts']['unmintedOrBurnedLpRaw'], '100')
        self.assertEqual(result['amounts']['excludedPrincipalLowerRaw'], '100')
        self.assertEqual(result['amounts']['creatorSupplyUpperRaw'], '900')
        self.assertFalse(result['creatorCapSatisfied'])

    def test_transferred_or_locked_lp_is_still_outstanding(self):
        # No holder labels exist in the contract; transferring or locking an LP
        # account leaves mint supply unchanged and cannot earn an exclusion.
        before = synthetic_snapshot(actualLpSupplyRaw='999900')
        after_transfer = copy.deepcopy(before)
        self.assertEqual(c.evaluate(before), c.evaluate(after_transfer))
        result = c.evaluate(before)
        self.assertEqual(result['amounts']['excludedPrincipalLowerRaw'], '95')
        self.assertFalse(result['creatorCapSatisfied'])

    def test_actual_burn_changes_outstanding_supply(self):
        before = c.evaluate(synthetic_snapshot(actualLpSupplyRaw='999900'))
        after = c.evaluate(synthetic_snapshot(actualLpSupplyRaw='50000'))
        self.assertFalse(before['arithmeticCandidate'])
        self.assertTrue(after['arithmeticCandidate'])

    def test_all_lp_burned_does_not_exclude_accrued_base_fees(self):
        result = c.evaluate(synthetic_snapshot(actualLpSupplyRaw='0',
            baseProtocolFeesRaw='10000', baseFundFeesRaw='20000', baseCreatorFeesRaw='30000'))
        self.assertEqual(result['amounts']['redeemablePrincipalUpperRaw'], '0')
        self.assertEqual(result['amounts']['excludedPrincipalLowerRaw'], '890000')
        self.assertEqual(result['amounts']['creatorSupplyUpperRaw'], '110000')
        self.assertFalse(result['arithmeticCandidate'])

    def test_no_burned_or_unminted_shares_is_valid_but_excludes_zero(self):
        result = c.evaluate(synthetic_snapshot(actualLpSupplyRaw='1000000'))
        self.assertEqual(result['amounts']['unmintedOrBurnedLpRaw'], '0')
        self.assertEqual(result['amounts']['excludedPrincipalLowerRaw'], '0')
        self.assertEqual(result['amounts']['creatorSupplyUpperBps'], '10000')
        self.assertFalse(result['creatorCapSatisfied'])

    def test_under_100_gap_is_not_a_lineage_rejection(self):
        result = c.evaluate(synthetic_snapshot(internalLpSupplyRaw='10', actualLpSupplyRaw='1'))
        self.assertEqual(result['amounts']['unmintedOrBurnedLpRaw'], '9')

    def test_zero_net_reserves_and_all_fees_are_valid_non_candidates(self):
        result = c.evaluate(synthetic_snapshot(baseCreatorFeesRaw='950000',
            quoteCreatorFeesRaw='20000000000'))
        self.assertEqual(result['amounts']['netBaseReserveRaw'], '0')
        self.assertEqual(result['amounts']['netQuoteReserveLamports'], '0')
        self.assertFalse(result['creatorCapSatisfied'])
        self.assertFalse(result['liquidityFloorSatisfied'])
        self.assertFalse(result['arithmeticCandidate'])

    def test_u64_max_products_are_exact_not_u64_wrapped(self):
        maximum = str(c.U64_MAX)
        result = c.evaluate(synthetic_snapshot(baseSupplyRaw=maximum, baseVaultRaw=maximum,
            quoteVaultRaw=maximum, internalLpSupplyRaw=maximum,
            actualLpSupplyRaw=str(c.U64_MAX - 1)))
        self.assertEqual(result['amounts']['redeemablePrincipalUpperRaw'], str(c.U64_MAX - 1))
        self.assertEqual(result['amounts']['excludedPrincipalLowerRaw'], '1')
        self.assertEqual(result['amounts']['creatorSupplyUpperBps'], '10000')
        self.assertTrue(result['liquidityFloorSatisfied'])

    def test_reachable_initialization_then_burn_arithmetic(self):
        supply, base, quote = 10**15, 950_000_000_000_000, 20_000_000_000
        internal = isqrt(base * quote)
        initially_minted = internal - 100
        remaining = internal // 20
        self.assertGreater(initially_minted - remaining, 0)
        result = c.evaluate(synthetic_snapshot(baseSupplyRaw=str(supply), baseVaultRaw=str(base),
            quoteVaultRaw=str(quote), internalLpSupplyRaw=str(internal),
            actualLpSupplyRaw=str(remaining)))
        self.assertEqual(internal, 4_358_898_943_540)
        self.assertEqual(result['amounts']['excludedPrincipalLowerRaw'], '902500000000000')
        self.assertEqual(result['amounts']['creatorSupplyUpperBps'], '975')
        self.assertTrue(result['arithmeticCandidate'])
        self.assertIs(result['liveApproved'], False)

    def test_every_small_sequential_withdrawal_partition_respects_sharp_bound(self):
        # Enumerate all ordered positive-share partitions, not just a chosen
        # withdrawal order. Quote-side restrictions can only reduce redemption.
        def terminal_totals(reserve, denominator, remaining, paid=0):
            if remaining == 0:
                yield paid
                return
            for shares in range(1, remaining + 1):
                amount = reserve * shares // denominator
                yield from terminal_totals(reserve - amount, denominator - shares,
                                           remaining - shares, paid + amount)

        cases, partitions = 0, 0
        for internal in range(2, 11):
            for reserve in range(15):
                for actual in range(internal):
                    snapshot = synthetic_snapshot(baseSupplyRaw=str(max(reserve, 1)),
                        baseVaultRaw=str(reserve), internalLpSupplyRaw=str(internal),
                        actualLpSupplyRaw=str(actual))
                    result = c.evaluate(snapshot)['amounts']
                    upper = int(result['redeemablePrincipalUpperRaw'])
                    lower = int(result['excludedPrincipalLowerRaw'])
                    self.assertEqual(upper, reserve * actual // internal)
                    self.assertEqual(lower, (reserve * (internal - actual) + internal - 1) // internal)
                    for total in terminal_totals(reserve, internal, actual):
                        self.assertLessEqual(total, upper, (reserve, internal, actual, total))
                        self.assertGreaterEqual(reserve - total, lower)
                        partitions += 1
                    cases += 1
        self.assertEqual(cases, 810)
        self.assertEqual(partitions, 15_330)

    def test_input_is_not_mutated(self):
        snapshot = synthetic_snapshot()
        before = copy.deepcopy(snapshot)
        c.evaluate(snapshot)
        self.assertEqual(snapshot, before)

    def test_exact_schema_rejects_missing_extra_or_wrong_container(self):
        malformed = [None, [], True, {}, {'kind': c.INPUT_KIND, 'amounts': []}]
        for level in ('outer', 'amounts'):
            for mode in ('missing', 'extra'):
                value = synthetic_snapshot()
                target = value if level == 'outer' else value['amounts']
                if mode == 'missing':
                    del target[next(iter(target))]
                else:
                    target['claimedVerified'] = True
                malformed.append(value)
        for value in malformed:
            with self.subTest(value=value), self.assertRaises(c.Invalid):
                c.evaluate(value)

    def test_kind_is_fixed(self):
        for kind in ('', None, 1, True, 'RAYDIUM_CPMM_LP_BURN_ARITHMETIC_V2'):
            value = synthetic_snapshot()
            value['kind'] = kind
            with self.subTest(kind=kind), self.assertRaisesRegex(c.Invalid, 'UNSUPPORTED'):
                c.evaluate(value)

    def test_each_amount_rejects_noncanonical_values(self):
        values = [None, True, False, 0, 1, 1.0, [], {}, '', '00', '01', '+1', '-1',
                  ' 1', '1 ', '1\n', '1.0', '1e3', '١', '１', '0x10']
        for field in sorted(c.AMOUNT_FIELDS):
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(c.Invalid):
                    c.evaluate(synthetic_snapshot(**{field: value}))

    def test_each_amount_rejects_u64_overflow(self):
        for field in sorted(c.AMOUNT_FIELDS):
            for value in (str(c.U64_MAX + 1), '9' * 5000):
                with self.subTest(field=field), self.assertRaisesRegex(c.Invalid, 'OUTSIDE_U64'):
                    c.evaluate(synthetic_snapshot(**{field: value}))

    def test_zero_supply_and_denominator_fail_explicitly(self):
        for field, code in [('baseSupplyRaw', 'BASE_SUPPLY_MUST_BE_POSITIVE'),
                            ('internalLpSupplyRaw', 'INTERNAL_LP_SUPPLY_MUST_BE_POSITIVE')]:
            with self.subTest(field=field), self.assertRaisesRegex(c.Invalid, code):
                c.evaluate(synthetic_snapshot(**{field: '0'}))

    def test_inconsistent_balances_fail_closed(self):
        for overrides, code in [({'baseVaultRaw': '1000001'}, 'BASE_VAULT_EXCEEDS_SUPPLY'),
                ({'actualLpSupplyRaw': '1000001'}, 'ACTUAL_LP_SUPPLY_EXCEEDS_INTERNAL'),
                ({'baseCreatorFeesRaw': '950001'}, 'BASE_FEE_SUM_EXCEEDS_VAULT'),
                ({'quoteCreatorFeesRaw': '20000000001'}, 'QUOTE_FEE_SUM_EXCEEDS_VAULT')]:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(c.Invalid, code):
                c.evaluate(synthetic_snapshot(**overrides))

    def test_fee_sum_overflow_cannot_wrap_into_valid_balance(self):
        maximum = str(c.U64_MAX)
        for overrides, code in [({'baseSupplyRaw': maximum, 'baseVaultRaw': maximum,
                'baseProtocolFeesRaw': maximum, 'baseFundFeesRaw': '1'}, 'BASE_FEE_SUM'),
                ({'quoteVaultRaw': maximum, 'quoteProtocolFeesRaw': maximum,
                'quoteFundFeesRaw': '1'}, 'QUOTE_FEE_SUM')]:
            with self.subTest(overrides=overrides), self.assertRaisesRegex(c.Invalid, code):
                c.evaluate(synthetic_snapshot(**overrides))

    def test_json_duplicate_fields_and_nonstandard_constants_rejected(self):
        encoded = json.dumps(synthetic_snapshot())
        for text in [encoded.replace('"kind":', '"kind":"ignored","kind":', 1),
                     encoded.replace('"baseSupplyRaw":', '"baseSupplyRaw":"1","baseSupplyRaw":', 1),
                     '{"kind":NaN}', '{"kind":Infinity}', '{"kind":-Infinity}', '{']:
            with self.subTest(text=text[:80]), self.assertRaises(c.Invalid):
                c.loads_snapshot(text)

    def test_cli_success_stdout_is_only_contract_json(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        encoded = json.dumps(synthetic_snapshot())
        with patch.object(Path, 'read_text', return_value=encoded), redirect_stdout(stdout), redirect_stderr(stderr):
            code = c.main(['--input', 'synthetic-saved.json'])
        self.assertEqual(code, 0)
        self.assertEqual(stderr.getvalue(), '')
        self.assertEqual(json.loads(stdout.getvalue()), c.evaluate(synthetic_snapshot()))
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)

    def test_cli_invalid_input_has_nonzero_status_and_no_stdout(self):
        for content in ['{', json.dumps(synthetic_snapshot(baseVaultRaw='-1')),
                        '{"kind":NaN}', '{"kind":1,"kind":2}']:
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(Path, 'read_text', return_value=content), redirect_stdout(stdout), redirect_stderr(stderr):
                code = c.main(['--input', 'synthetic-invalid.json'])
            self.assertEqual(code, 2)
            self.assertEqual(stdout.getvalue(), '')
            self.assertTrue(stderr.getvalue().startswith('INVALID_SAVED_INPUT:'))

    def test_cli_read_failure_has_nonzero_status_and_no_stdout(self):
        for error in (OSError('synthetic missing file'), UnicodeError('synthetic invalid encoding')):
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(Path, 'read_text', side_effect=error), redirect_stdout(stdout), redirect_stderr(stderr):
                code = c.main(['--input', 'synthetic-unreadable.json'])
            self.assertEqual(code, 2)
            self.assertEqual(stdout.getvalue(), '')
            self.assertIn('INVALID_SAVED_INPUT:', stderr.getvalue())

    def test_real_cli_process_rejects_non_json_source_file(self):
        # Read this existing synthetic test source; do not create fixture files.
        result = subprocess.run([sys.executable, '-B', str(Path(c.__file__)),
                                 '--input', str(Path(__file__))],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(result.stdout, '')
        self.assertIn('INVALID_SAVED_INPUT:INVALID_JSON', result.stderr)


if __name__ == '__main__':
    unittest.main()
