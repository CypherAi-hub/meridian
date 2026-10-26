"""Synthetic analysis fixtures, never published as collected market performance."""
import copy
import unittest
from analyze import analyze, integer_median_string, WSOL


def completed(identity='position', mint='token', pnl=-40):
    return dict(positionId=identity, mint=mint, pnlLamports=str(pnl), costLamports='1000', proceedsLamports=str(1020+pnl), feesLamports='20', exitLegs=2, openedAt=1, closedAt=100)


def quote(input_mint, output_mint, amount, output, at):
    return dict(inputMint=input_mint, outputMint=output_mint, inAmount=str(amount), outAmount=str(output), minOutAmount=str(output), observedAt=at)


def baseline(identity='baseline'):
    return dict(id=identity, phase='BASELINE', status='QUOTED', mint='token', observedAt=1000, completedAt=1000, amountLamports='10000', modeledNetworkFeesLamports='20', buy=quote(WSOL,'token',10000,100,1000), sell=quote('token',WSOL,100,9800,1000), conservativeRoundTripNetLamports='-220', conservativeRoundTripCostBps=220)


def horizon(identity='episode', mint='token', net=-220, milliseconds=30000):
    target=1000+milliseconds
    return dict(id=identity+':horizon:'+str(milliseconds), episodeId=identity, phase='HORIZON', scope='RESEARCH_QUOTE_ONLY_NO_TRADE', status='QUOTED', mint=mint, horizonMs=milliseconds, baselineAt=1000, targetAt=target, observedAt=target+1000, amountLamports='10000', hypotheticalTokenQuantityRaw='100', modeledNetworkFeesLamports='20', baselineBuy=quote(WSOL,mint,10000,100,1000), sell=quote(mint,WSOL,100,10020+net,target+1000), hypotheticalHorizonNetLamports=str(net), hypotheticalHorizonReturnBps=net)


class ResearchEvidenceTests(unittest.TestCase):
    def test_no_closed_positions_is_unknown_performance(self):
        result=analyze({'mode':'PAPER','completedPositions':[],'trades':[],'decisions':[]},[])
        self.assertEqual(result['evidenceStatus'],'INSUFFICIENT_OUT_OF_SAMPLE_EVIDENCE')
        self.assertEqual(result['profitabilityConclusion'],'UNPROVEN')
        self.assertIsNone(result['winRateByCompletedPosition'])
        self.assertIsNone(result['netRealizedLamports'])
        self.assertIsNone(result['uncertainty'])

    def test_full_engine_aggregate_overrides_a_truncated_profitable_leg_page(self):
        result=analyze({'completedPositions':[completed()], 'trades':[dict(positionId='position',mint='token',pnlLamports='50',isFinalExit=False)]},[])
        self.assertEqual(result['completedPositionSource'],'FULL_LEDGER_ENGINE_AGGREGATE')
        self.assertEqual(result['completedPositions'],1)
        self.assertEqual(result['netRealizedLamports'],'-40')
        self.assertEqual(result['winRateByCompletedPosition'],0)

    def test_final_marker_in_unproven_paginated_history_does_not_establish_total_position_pnl(self):
        result=analyze({'trades':[dict(positionId='position',mint='token',pnlLamports='100',isFinalExit=True)]},[])
        self.assertEqual(result['completedPositions'],0)
        self.assertIsNone(result['netRealizedLamports'])
        self.assertEqual(result['completedPositionSource'],'COMPLETED_POSITION_ATTRIBUTION_UNAVAILABLE')

    def test_explicit_complete_offline_leg_history_can_be_aggregated(self):
        common=dict(positionId='position',mint='token',strategy='fixture',openedAt=0)
        legs=[dict(common,id='a',costLamports='100',proceedsLamports='160',feesLamports='10',pnlLamports='50',closedAt=1,isFinalExit=False),dict(common,id='b',costLamports='100',proceedsLamports='20',feesLamports='10',pnlLamports='-90',closedAt=2,isFinalExit=True)]
        result=analyze({'tradeHistoryComplete':True,'trades':legs},[])
        self.assertEqual(result['completedPositions'],1)
        self.assertEqual(result['netRealizedLamports'],'-40')

    def test_inconsistent_or_duplicate_position_aggregates_are_excluded(self):
        broken=completed('broken');broken['pnlLamports']='999'
        result=analyze({'completedPositions':[completed(),completed(),broken]},[])
        self.assertEqual(result['completedPositions'],0)
        self.assertEqual(result['invalidCompletedPositionRecords'],3)

    def test_legacy_unattributed_legs_do_not_become_successes(self):
        result=analyze({'trades':[dict(pnlLamports='100',mint='unknown')]},[])
        self.assertEqual(result['completedPositions'],0)
        self.assertEqual(result['unattributedLegacyExitLegs'],1)

    def test_quote_horizon_gains_never_enter_realized_pnl(self):
        result=analyze({'completedPositions':[]},[baseline(),horizon(net=500)])
        self.assertEqual(result['completedPositions'],0)
        self.assertIsNone(result['profitFactor'])
        self.assertIsNone(result['netRealizedLamports'])
        self.assertEqual(result['researchQuotes']['quoted'],1)
        self.assertEqual(result['hypotheticalQuoteHorizons']['byHorizonMs']['30000']['quoted'],1)
        self.assertEqual(result['profitabilityConclusion'],'UNPROVEN')

    def test_baseline_cost_median_excludes_horizon_returns(self):
        result=analyze({'completedPositions':[]},[baseline(),horizon(net=500)])
        self.assertEqual(result['researchQuotes']['conservativeRoundTripCostBpsMedian'],220)
        self.assertEqual(result['hypotheticalQuoteHorizons']['byHorizonMs']['30000']['medianHypotheticalReturnBps'],500)

    def test_failed_and_expired_horizons_remain_missing_not_zero_returns(self):
        missing=horizon();missing.update(status='UNAVAILABLE',error='HORIZON_EXPIRED_NO_OBSERVATION');missing.pop('sell');missing.pop('hypotheticalHorizonNetLamports')
        result=analyze({},[missing])['hypotheticalQuoteHorizons']['byHorizonMs']['30000']
        self.assertEqual(result['unavailable'],1)
        self.assertIsNone(result['medianHypotheticalNetLamports'])
        self.assertEqual(result['unavailableReasons']['HORIZON_EXPIRED_NO_OBSERVATION'],1)

    def test_stale_future_and_wrong_quantity_horizons_are_invalid(self):
        for mode in ('stale','future','wrong_size','before_target'):
            row=horizon()
            if mode=='stale':row['sell']['observedAt']=row['observedAt']-6000
            if mode=='future':row['sell']['observedAt']=row['observedAt']+1
            if mode=='wrong_size':row['sell']['inAmount']='101'
            if mode=='before_target':row['sell']['observedAt']=row['targetAt']-1
            result=analyze({},[row])['hypotheticalQuoteHorizons']['byHorizonMs']['30000']
            self.assertEqual(result['quoted'],0,mode)
            self.assertEqual(result['invalid'],1,mode)

    def test_duplicate_horizon_records_do_not_add_independent_samples(self):
        row=horizon()
        result=analyze({},[row,copy.deepcopy(row)])['hypotheticalQuoteHorizons']
        self.assertEqual(result['attempts'],2)
        self.assertEqual(result['deduplicatedAttempts'],1)
        self.assertEqual(result['byHorizonMs']['30000']['quoted'],1)

    def test_conflicting_duplicate_horizon_records_are_excluded(self):
        result=analyze({},[horizon(net=100),horizon(net=-100)])['hypotheticalQuoteHorizons']
        self.assertEqual(result['conflictingDuplicateKeys'],1)
        self.assertEqual(result['byHorizonMs']['30000']['quoted'],0)

    def test_small_horizon_sample_has_explicit_insufficient_uncertainty(self):
        result=analyze({},[horizon()])['hypotheticalQuoteHorizons']['byHorizonMs']['30000']['uncertainty']
        self.assertEqual(result['status'],'INSUFFICIENT_DISTINCT_TOKENS')
        self.assertIsNone(result['mean95'])

    def test_bootstrap_clusters_many_same_token_episodes_instead_of_inflating_sample_count(self):
        records=[horizon(str(i),'same-token',net=100) for i in range(35)]
        result=analyze({},records)['hypotheticalQuoteHorizons']['byHorizonMs']['30000']['uncertainty']
        self.assertEqual(result['distinctTokens'],1)
        self.assertEqual(result['status'],'INSUFFICIENT_DISTINCT_TOKENS')

    def test_large_distinct_token_quote_sample_remains_descriptive_and_unproven(self):
        records=[horizon(str(i),'token-'+str(i),net=100+i) for i in range(30)]
        report=analyze({'completedPositions':[]},records)
        result=report['hypotheticalQuoteHorizons']['byHorizonMs']['30000']['uncertainty']
        self.assertEqual(result['status'],'DESCRIPTIVE_TOKEN_CLUSTER_BOOTSTRAP')
        self.assertEqual(result['distinctTokens'],30)
        self.assertEqual(len(result['mean95']),2)
        self.assertEqual(report['profitabilityConclusion'],'UNPROVEN')
        self.assertIsNone(report['netRealizedLamports'])

    def test_median_lamports_preserves_values_beyond_float_precision(self):
        self.assertEqual(integer_median_string([90071992547409930001,90071992547409930002]),'90071992547409930001.5')
        self.assertEqual(integer_median_string([-2,-1]),'-1.5')

    def test_invalid_quote_accounting_never_becomes_a_zero_cost_baseline(self):
        row=baseline();row['conservativeRoundTripCostBps']=0
        result=analyze({},[row])['researchQuotes']
        self.assertEqual(result['quoted'],0)
        self.assertEqual(result['invalid'],1)
        self.assertIsNone(result['conservativeRoundTripCostBpsMedian'])


if __name__=='__main__':
    unittest.main()
