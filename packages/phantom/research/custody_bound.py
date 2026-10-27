"""Independent saved-input Raydium CPMM LP-burn arithmetic; standard library only.

This conditional model does not establish account authenticity, source/deployment
equivalence, ownership, same-bank observations, or any custody certificate. It
neither queries a provider nor changes a policy, database, ledger, or runtime.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import sys

INPUT_KIND = 'RAYDIUM_CPMM_LP_BURN_ARITHMETIC_V1'
OUTPUT_KIND = 'CONDITIONAL_ARITHMETIC_NOT_A_CUSTODY_CERTIFICATE'
U64_MAX = 2**64 - 1
CREATOR_CAP_BPS = 1000
MINIMUM_QUOTE_LAMPORTS = 20_000_000_000
AMOUNT_FIELDS = frozenset({
    'baseSupplyRaw', 'baseVaultRaw', 'baseProtocolFeesRaw', 'baseFundFeesRaw',
    'baseCreatorFeesRaw', 'quoteVaultRaw', 'quoteProtocolFeesRaw',
    'quoteFundFeesRaw', 'quoteCreatorFeesRaw', 'internalLpSupplyRaw',
    'actualLpSupplyRaw',
})


class Invalid(ValueError):
    """A saved input fails the fixed arithmetic contract; no result is valid."""


def _u64(value, field):
    if type(value) is not str or not re.fullmatch(r'(0|[1-9][0-9]*)', value):
        raise Invalid(f'NONCANONICAL_U64:{field}')
    # Check length first: avoid enormous integer conversions on malformed input.
    if len(value) > 20 or int(value) > U64_MAX:
        raise Invalid(f'OUTSIDE_U64:{field}')
    return int(value)


def evaluate(snapshot):
    """Return exact conditional arithmetic, or raise Invalid for malformed input.

    Every outstanding LP share is potentially creator-controlled. Only the
    principal left after their maximal floor-rounded redemption is excluded.
    No inference is made about LP holder identities or deployment/source proof.
    """
    if type(snapshot) is not dict or set(snapshot) != {'kind', 'amounts'}:
        raise Invalid('INVALID_TOP_LEVEL_FIELDS')
    if snapshot['kind'] != INPUT_KIND:
        raise Invalid('UNSUPPORTED_ARITHMETIC_KIND')
    amounts = snapshot['amounts']
    if type(amounts) is not dict or set(amounts) != AMOUNT_FIELDS:
        raise Invalid('INVALID_AMOUNT_FIELDS')
    a = {field: _u64(amounts[field], field) for field in sorted(AMOUNT_FIELDS)}
    supply, base = a['baseSupplyRaw'], a['baseVaultRaw']
    internal, actual = a['internalLpSupplyRaw'], a['actualLpSupplyRaw']
    if supply == 0:
        raise Invalid('BASE_SUPPLY_MUST_BE_POSITIVE')
    if internal == 0:
        raise Invalid('INTERNAL_LP_SUPPLY_MUST_BE_POSITIVE')
    if base > supply:
        raise Invalid('BASE_VAULT_EXCEEDS_SUPPLY')
    if actual > internal:
        raise Invalid('ACTUAL_LP_SUPPLY_EXCEEDS_INTERNAL')
    base_fees = sum(a[field] for field in (
        'baseProtocolFeesRaw', 'baseFundFeesRaw', 'baseCreatorFeesRaw'))
    quote_fees = sum(a[field] for field in (
        'quoteProtocolFeesRaw', 'quoteFundFeesRaw', 'quoteCreatorFeesRaw'))
    if base_fees > base:
        raise Invalid('BASE_FEE_SUM_EXCEEDS_VAULT')
    if quote_fees > a['quoteVaultRaw']:
        raise Invalid('QUOTE_FEE_SUM_EXCEEDS_VAULT')

    net_base, net_quote = base - base_fees, a['quoteVaultRaw'] - quote_fees
    # Python's unbounded integers are intentional: valid u64 inputs require
    # products wider than u64. Do not round individual fees or this division up.
    redeemable = net_base * actual // internal
    excluded = net_base - redeemable
    upper = supply - excluded
    upper_bps = (upper * 10_000 + supply - 1) // supply
    creator_ok = upper * 10_000 <= CREATOR_CAP_BPS * supply
    liquidity_ok = net_quote >= MINIMUM_QUOTE_LAMPORTS
    return {
        'kind': OUTPUT_KIND,
        'amounts': {
            'netBaseReserveRaw': str(net_base),
            'netQuoteReserveLamports': str(net_quote),
            'unmintedOrBurnedLpRaw': str(internal - actual),
            'redeemablePrincipalUpperRaw': str(redeemable),
            'excludedPrincipalLowerRaw': str(excluded),
            'creatorSupplyUpperRaw': str(upper),
            'creatorSupplyUpperBps': str(upper_bps),
        },
        'creatorCapSatisfied': creator_ok,
        'liquidityFloorSatisfied': liquidity_ok,
        'arithmeticCandidate': creator_ok and liquidity_ok,
        'liveApproved': False,
    }


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Invalid(f'DUPLICATE_JSON_FIELD:{key}')
        result[key] = value
    return result


def _invalid_constant(value):
    raise Invalid(f'NONSTANDARD_JSON_CONSTANT:{value}')


def loads_snapshot(text):
    """Parse JSON without silently accepting duplicate fields or NaN/Infinity."""
    try:
        return json.loads(text, object_pairs_hook=_unique_object,
                          parse_constant=_invalid_constant)
    except json.JSONDecodeError as error:
        raise Invalid(f'INVALID_JSON:{error.msg}') from error


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path,
                        help='Saved JSON file; this command never queries a provider')
    args = parser.parse_args(argv)
    try:
        snapshot = loads_snapshot(args.input.read_text(encoding='utf-8'))
        result = evaluate(snapshot)
    except (Invalid, OSError, UnicodeError) as error:
        print(f'INVALID_SAVED_INPUT:{error}', file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, separators=(',', ':'), allow_nan=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
