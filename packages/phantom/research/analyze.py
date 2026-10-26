"""Read-only PHANTOM evidence analysis; no trading, secrets, or automatic tuning.

Realized completed-position accounting and quote-only hypothetical horizon
observations are separate evidence classes. Neither descriptive bootstrap
intervals nor positive quoted outcomes prove executable or out-of-sample returns.
"""
from __future__ import annotations

import argparse
import json
import math
import random
import statistics
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

WSOL = 'So11111111111111111111111111111111111111112'
HORIZONS_MS = (30_000, 60_000, 180_000)
MINIMUM_BOOTSTRAP_TOKENS = 30
MAX_QUOTE_AGE_MS = 5_000


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    return values[min(len(values) - 1, math.floor((len(values) - 1) * q))]


def integer(value, positive=False):
    if isinstance(value, bool):
        raise ValueError('Boolean is not an integer amount')
    text = str(value)
    if not text or (text.startswith('-') and not text[1:].isdigit()) or (not text.startswith('-') and not text.isdigit()):
        raise ValueError('Invalid integer amount')
    result = int(text)
    if positive and result <= 0:
        raise ValueError('Nonpositive amount')
    return result


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def integer_median_string(values):
    if not values:
        return None
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return str(ordered[middle])
    total = ordered[middle - 1] + ordered[middle]
    sign, absolute = ('-' if total < 0 else ''), abs(total)
    return sign + str(absolute // 2) + ('.5' if absolute % 2 else '')


def trunc_div(numerator, denominator):
    """Match exact integer division toward zero used by TypeScript bigint."""
    if denominator <= 0:
        raise ValueError('Nonpositive denominator')
    return (-1 if numerator < 0 else 1) * (abs(numerator) // denominator)


def clustered_bootstrap(token_values, unit):
    if len(token_values) < MINIMUM_BOOTSTRAP_TOKENS:
        return {'status': 'INSUFFICIENT_DISTINCT_TOKENS', 'distinctTokens': len(token_values),
                'minimumDistinctTokens': MINIMUM_BOOTSTRAP_TOKENS, 'mean95': None, 'unit': unit}
    rng = random.Random(4202026)
    values = list(token_values.values())
    means = [statistics.mean(rng.choices(values, k=len(values))) for _ in range(5000)]
    return {'status': 'DESCRIPTIVE_TOKEN_CLUSTER_BOOTSTRAP', 'distinctTokens': len(values),
            'minimumDistinctTokens': MINIMUM_BOOTSTRAP_TOKENS,
            'mean95': [percentile(means, .025), percentile(means, .975)], 'unit': unit,
            'caveat': 'Token clusters do not remove temporal, selection, missing-route, or regime dependence. No out-of-sample profitability claim.'}


def completed_positions(state):
    """Prefer the full-ledger engine aggregate; never infer closure from a page of legs."""
    unattributed = sum(not leg.get('positionId') for leg in state.get('trades', []))
    if 'completedPositions' in state:
        rows = state['completedPositions']
        if not isinstance(rows, list):
            return [], 'ENGINE_AGGREGATE_INVALID', unattributed, 1
        accepted, seen, invalid = [], set(), 0
        identities = Counter(row.get('positionId') for row in rows if isinstance(row, dict) and isinstance(row.get('positionId'), str))
        for row in rows:
            try:
                identity, mint = row['positionId'], row['mint']
                if not isinstance(identity, str) or not identity or identities[identity] != 1 or identity in seen or not isinstance(mint, str) or not mint:
                    raise ValueError('Invalid position identity')
                cost, proceeds, fees, pnl = (integer(row[key]) for key in ('costLamports', 'proceedsLamports', 'feesLamports', 'pnlLamports'))
                if min(cost, proceeds, fees) < 0 or pnl != proceeds - cost - fees:
                    raise ValueError('Position accounting mismatch')
                if not isinstance(row.get('exitLegs'), int) or isinstance(row['exitLegs'], bool) or row['exitLegs'] < 1:
                    raise ValueError('Closure leg count unavailable')
                if not finite(row.get('openedAt')) or not finite(row.get('closedAt')) or row['closedAt'] < row['openedAt']:
                    raise ValueError('Closure timestamp unavailable')
                seen.add(identity)
                accepted.append({'positionId': identity, 'mint': mint, 'pnlLamports': pnl})
            except (KeyError, TypeError, ValueError):
                invalid += 1
        return accepted, 'FULL_LEDGER_ENGINE_AGGREGATE', unattributed, invalid
    # The worker normally supplies completedPositions. An explicit full-history
    # marker is required for offline legacy exports; a last-1000 page is insufficient.
    if state.get('tradeHistoryComplete') is not True:
        return [], 'COMPLETED_POSITION_ATTRIBUTION_UNAVAILABLE', unattributed, 0
    groups = defaultdict(list)
    for leg in state.get('trades', []):
        if leg.get('positionId'):
            groups[leg['positionId']].append(leg)
    accepted, invalid = [], 0
    for identity, legs in groups.items():
        try:
            finals = [leg for leg in legs if leg.get('isFinalExit') is True]
            if len(finals) != 1 or any(leg.get('isFinalExit') not in (True, False) for leg in legs):
                raise ValueError('No unique final exit')
            first, final = legs[0], finals[0]
            seen, pnl = set(), 0
            for leg in legs:
                if not leg.get('id') or leg['id'] in seen or leg['mint'] != first['mint'] or leg['strategy'] != first['strategy'] or leg['openedAt'] != first['openedAt'] or not finite(leg['openedAt']) or not finite(leg['closedAt']) or leg['closedAt'] < leg['openedAt'] or leg['closedAt'] > final['closedAt']:
                    raise ValueError('Incomplete or inconsistent leg identity')
                seen.add(leg['id'])
                cost, proceeds, fees, net = (integer(leg[key]) for key in ('costLamports', 'proceedsLamports', 'feesLamports', 'pnlLamports'))
                if min(cost, proceeds, fees) < 0 or net != proceeds - cost - fees:
                    raise ValueError('Leg accounting mismatch')
                pnl += net
            accepted.append({'positionId': identity, 'mint': first['mint'], 'pnlLamports': pnl})
        except (KeyError, TypeError, ValueError):
            invalid += 1
    return accepted, 'EXPLICIT_FULL_HISTORY_LEG_AGGREGATION', unattributed, invalid


def quote_valid(quote, input_mint, output_mint, amount, observed_at, target_at=None):
    if not isinstance(quote, dict) or quote.get('inputMint') != input_mint or quote.get('outputMint') != output_mint:
        raise ValueError('Quote mint mismatch')
    if integer(quote['inAmount'], True) != amount:
        raise ValueError('Exact quote size unavailable')
    output = integer(quote['minOutAmount'], True)
    if output > integer(quote['outAmount'], True):
        raise ValueError('Invalid conservative quote output')
    quote_at = quote.get('observedAt')
    if not finite(quote_at) or quote_at > observed_at or observed_at - quote_at > MAX_QUOTE_AGE_MS or (target_at is not None and quote_at < target_at):
        raise ValueError('Quote timestamp stale, future, or before horizon')
    return output


def baseline_cost(row):
    observed = row.get('observedAt', row.get('completedAt'))
    if not finite(observed):
        raise ValueError('Baseline observation time unavailable')
    amount = integer(row['amountLamports'], True)
    fees = integer(row['modeledNetworkFeesLamports'])
    if fees < 0:
        raise ValueError('Invalid modeled costs')
    quantity = quote_valid(row['buy'], WSOL, row['mint'], amount, observed)
    proceeds = quote_valid(row['sell'], row['mint'], WSOL, quantity, observed)
    cost_bps = trunc_div((amount + fees - proceeds) * 10_000, amount)
    if not finite(row.get('conservativeRoundTripCostBps')) or row['conservativeRoundTripCostBps'] != cost_bps or integer(row['conservativeRoundTripNetLamports']) != proceeds - amount - fees:
        raise ValueError('Baseline quote accounting mismatch')
    return cost_bps


def horizon_result(row):
    horizon, target, observed, baseline = row.get('horizonMs'), row.get('targetAt'), row.get('observedAt'), row.get('baselineAt')
    if horizon not in HORIZONS_MS or not all(finite(x) for x in (target, observed, baseline)) or target != baseline + horizon or observed < target:
        raise ValueError('Invalid hypothetical horizon timing')
    if not row.get('episodeId') or row.get('scope') != 'RESEARCH_QUOTE_ONLY_NO_TRADE':
        raise ValueError('Horizon provenance unavailable')
    amount, quantity = integer(row['amountLamports'], True), integer(row['hypotheticalTokenQuantityRaw'], True)
    fees = integer(row['modeledNetworkFeesLamports'])
    if fees < 0:
        raise ValueError('Invalid modeled costs')
    # The original buy is checked against its own actual baseline timestamp, not
    # incorrectly required to be fresh several minutes later.
    if quote_valid(row['baselineBuy'], WSOL, row['mint'], amount, baseline) != quantity:
        raise ValueError('Original hypothetical quantity changed')
    proceeds = quote_valid(row['sell'], row['mint'], WSOL, quantity, observed, target)
    net = proceeds - amount - fees
    bps = trunc_div(net * 10_000, amount)
    if integer(row['hypotheticalHorizonNetLamports']) != net or row.get('hypotheticalHorizonReturnBps') != bps:
        raise ValueError('Hypothetical quote accounting mismatch')
    return {'mint': row['mint'], 'net': net, 'bps': bps, 'delay': observed - target}


def research_analysis(research):
    baselines = [row for row in research if row.get('phase', 'BASELINE') == 'BASELINE']
    costs, invalid_baselines, unavailable_baselines = [], 0, 0
    for row in baselines:
        if row.get('status') == 'UNAVAILABLE':
            unavailable_baselines += 1
            continue
        try:
            if row.get('status') != 'QUOTED':
                raise ValueError('Unknown baseline status')
            costs.append(baseline_cost(row))
        except (KeyError, TypeError, ValueError):
            invalid_baselines += 1
    horizon_rows = [row for row in research if row.get('phase') == 'HORIZON']
    indexed, duplicate_keys, invalid_duplicates = {}, set(), 0
    for row in horizon_rows:
        if not isinstance(row.get('episodeId'), str) or row.get('horizonMs') not in HORIZONS_MS:
            continue
        key = (row.get('episodeId'), row.get('horizonMs'))
        if key in indexed:
            if json.dumps(indexed[key], sort_keys=True) != json.dumps(row, sort_keys=True):
                duplicate_keys.add(key)
                invalid_duplicates += 1
        else:
            indexed[key] = row
    by_horizon = {}
    for horizon in HORIZONS_MS:
        matching = [row for key, row in indexed.items() if key[1] == horizon and key not in duplicate_keys]
        validated, unavailable, invalid, errors = [], 0, 0, Counter()
        for row in matching:
            if row.get('status') == 'UNAVAILABLE':
                unavailable += 1
                errors[row.get('error', 'HORIZON_UNAVAILABLE')] += 1
                continue
            try:
                if row.get('status') != 'QUOTED':
                    raise ValueError('Unknown horizon status')
                validated.append(horizon_result(row))
            except (KeyError, TypeError, ValueError):
                invalid += 1
        tokens = defaultdict(list)
        for result in validated:
            tokens[result['mint']].append(result['bps'])
        token_means = {mint: statistics.mean(values) for mint, values in tokens.items()}
        by_horizon[str(horizon)] = {
            'attempts': len(matching), 'quoted': len(validated), 'unavailable': unavailable, 'invalid': invalid,
            'distinctTokens': len(tokens),
            'medianHypotheticalNetLamports': integer_median_string([r['net'] for r in validated]),
            'medianHypotheticalReturnBps': statistics.median([r['bps'] for r in validated]) if validated else None,
            'observationDelayPastTargetMsMedian': statistics.median([r['delay'] for r in validated]) if validated else None,
            'unavailableReasons': dict(errors.most_common()),
            'uncertainty': clustered_bootstrap(token_means, 'per-token mean hypothetical horizon quote return bps; not realized P&L'),
        }
    return {
        'researchQuotes': {
            'attempts': len(baselines), 'quoted': len(costs), 'unavailable': unavailable_baselines,
            'invalid': invalid_baselines,
            'conservativeRoundTripCostBpsMedian': statistics.median(costs) if costs else None,
            'conservativeRoundTripCostBpsP95': percentile(costs, .95),
            'scope': 'BASELINE sequential quote costs only. Modeled expenses, no orders or fills; horizon outcomes excluded.',
        },
        'hypotheticalQuoteHorizons': {
            'attempts': len(horizon_rows), 'deduplicatedAttempts': len(indexed) - len(duplicate_keys),
            'unsupportedOrMalformedHorizonRecords': sum(not isinstance(row.get('episodeId'), str) or row.get('horizonMs') not in HORIZONS_MS for row in horizon_rows),
            'conflictingDuplicateKeys': len(duplicate_keys), 'conflictingDuplicateRecords': invalid_duplicates,
            'byHorizonMs': by_horizon,
            'scope': 'HORIZON observations sell exactly the original hypothetical baseline token quantity. These are quoted hypothetical outcomes, never positions, fills, realized P&L, or profitability evidence. Missing/delayed observations are explicit.',
        },
    }


def analyze(state, research):
    reasons = Counter(reason for decision in state.get('decisions', []) for reason in decision.get('reasons', []))
    closed, attribution, unattributed, invalid_positions = completed_positions(state)
    pnl = [row['pnlLamports'] for row in closed]
    token_pnl = defaultdict(int)
    for row in closed:
        token_pnl[row['mint']] += row['pnlLamports']
    confidence = clustered_bootstrap(token_pnl, 'token-grouped net realized lamports') if token_pnl else None
    research_report = research_analysis(research)
    return {
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'mode': state.get('mode'), 'sourceHealth': state.get('health'),
        'evidenceStatus': 'INSUFFICIENT_OUT_OF_SAMPLE_EVIDENCE' if len(token_pnl) < MINIMUM_BOOTSTRAP_TOKENS else 'DESCRIPTIVE_ONLY_REQUIRES_WALK_FORWARD_VALIDATION',
        'profitabilityConclusion': 'UNPROVEN',
        'completedPositionSource': attribution, 'invalidCompletedPositionRecords': invalid_positions,
        'completedPositions': len(closed), 'distinctCompletedTokens': len(token_pnl),
        'unattributedLegacyExitLegsInVisibleHistory': unattributed,
        'unattributedLegacyExitLegs': unattributed,
        'netRealizedLamports': str(sum(pnl)) if pnl else None,
        'winRateByCompletedPosition': sum(value > 0 for value in pnl) / len(pnl) if pnl else None,
        'profitFactor': sum(value for value in pnl if value > 0) / -sum(value for value in pnl if value < 0) if any(value < 0 for value in pnl) else None,
        'uncertainty': confidence,
        **research_report,
        'rejectionReasons': dict(reasons.most_common()),
        'nextEvidenceNeeded': ['Complete verified launch and wallet/security coverage',
                               'Fresh exact-size baseline and horizon quote snapshots with explicit missing outcomes',
                               'Sufficient fully closed paper positions across distinct tokens and regimes',
                               'Frozen chronological token-disjoint walk-forward validation including costs, failures, and unresolved inventory'],
        'changesAutomaticallyApplied': [],
    }


def load(url):
    with urllib.request.urlopen(url, timeout=15) as response:
        return json.load(response)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', default='http://127.0.0.1:8790')
    parser.add_argument('--input', type=Path, help='Saved JSON with state and quoteResearch observations instead of a live read')
    parser.add_argument('--output', type=Path, default=Path('data/python-research.json'))
    args = parser.parse_args()
    if args.input:
        data = json.loads(args.input.read_text(encoding='utf-8'))
        state, research = data['state'], data.get('quoteResearch', [])
        if isinstance(research, dict):
            research = research['observations']
    else:
        from urllib.parse import urlparse
        endpoint = urlparse(args.engine)
        if endpoint.scheme != 'http' or endpoint.hostname not in ('127.0.0.1', 'localhost', '::1') or endpoint.username or endpoint.password:
            raise ValueError('Research reads only a loopback worker; credentials are not accepted')
        state = load(args.engine.rstrip('/') + '/state')
        research = load(args.engine.rstrip('/') + '/quote-research')['observations']
    report = analyze(state, research)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'report': str(args.output), 'completedPositions': report['completedPositions'],
                      'status': report['evidenceStatus'], 'profitabilityConclusion': report['profitabilityConclusion']}))
