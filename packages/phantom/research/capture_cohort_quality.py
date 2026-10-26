"""Capture a stable, reduced local research snapshot using loopback GETs only.

Never calls a market provider, database, order or execution endpoint. This does
not establish provider authenticity or attest that the local server is trusted.
"""
import argparse
import json
from pathlib import Path
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from cohort_quality import audit, clean_quote, digest


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def loopback_get(port, path):
    if type(port) is not int or not 1024 <= port <= 65535 or path not in (
            '/forward-cohort', '/quote-research', '/state'):
        raise ValueError('ONLY_FIXED_LOOPBACK_RESEARCH_GET_PATHS_ALLOWED')
    opener = build_opener(ProxyHandler({}), NoRedirects())
    request = Request(f'http://127.0.0.1:{port}{path}', method='GET')
    with opener.open(request, timeout=10) as response:
        return json.load(response)


def inventory(export):
    return {k: v for k, v in export['probeDeliveryAudit'].items() if k != 'exportedAt'}


def reduce_row(row):
    keys = ('id', 'phase', 'mint', 'signature', 'slot', 'eventObservedAt', 'startedAt',
            'completedAt', 'amountLamports', 'schedulingPolicy', 'forwardExperimentId', 'protocol', 'pool')
    result = {key: row[key] for key in keys if key in row}
    if row.get('phase') != 'BASELINE':
        return result
    for side in ('buy', 'sell'):
        if side in row:
            result[side] = clean_quote(row[side])
    if 'forwardProbe' in row:
        packet = row['forwardProbe']
        result['forwardProbe'] = {key: packet[key] for key in
            ('id', 'mint', 'signature', 'slot', 'protocol', 'kind', 'eventObservedAt',
             'startedAt', 'completedAt', 'amountLamports') if key in packet}
        for side in ('buy', 'sell'):
            if side in packet:
                result['forwardProbe'][side] = clean_quote(packet[side])
    return result


def capture(get, reference=None, attempts=3):
    """get receives only four fixed read-only paths; injectable for race tests."""
    for attempt in range(attempts):
        first = get('/forward-cohort')
        raw = get('/quote-research')['observations']
        second = get('/forward-cohort')
        state = get('/state')
        if (first['protocol'] != second['protocol'] or first['records'] != second['records']
                or inventory(first) != inventory(second)
                or state['sourceVersion'] != second['protocol']['runtimeSourceVersion']):
            continue
        result = {'cohort': second, 'observations': [reduce_row(row) for row in raw], 'capture': {
            'sourceVersion': state['sourceVersion'], 'configurationHash': second['protocol']['configurationHash'],
            'enrollmentStable': True, 'taggedInventoryStable': True, 'observationCount': len(raw),
            'apiObservationLimit': 10000, 'attempt': attempt+1,
            'journalDigestBefore': digest(first['records']), 'journalDigestAfter': digest(second['records'])}}
        if reference is not None:
            result['referenceCohort'] = reference
        checked = audit(result)
        if checked['auditStatus'] == 'CONSISTENT_SAVED_CORPUS':
            return result
    raise ValueError('NO_STABLE_CONSISTENT_LOCAL_CAPTURE_WITHIN_BOUNDED_ATTEMPTS')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8790)
    parser.add_argument('--reference', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be an unprivileged local port')
    def get(path):
        return loopback_get(args.port, path)
    reference = json.loads(args.reference.read_text(encoding='utf-8')) if args.reference else None
    result = capture(get, reference)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'output': str(args.output), 'rows': len(result['observations']),
                      'journalRecords': len(result['cohort']['records']), 'attempt': result['capture']['attempt']}))


if __name__ == '__main__':
    main()
