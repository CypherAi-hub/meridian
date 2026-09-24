import { getSql } from '@/lib/db';
import { currentEpochName } from './env';
import { queryCorpusAudit } from './corpus-audit-query';
export async function loadCorpusAudit() {
 return queryCorpusAudit(await getSql(),currentEpochName());
}
