import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRouteJobs, freshCachedRoute, routeObservedAt, shouldRefreshRoute } from "./route-priority.ts";
import { blankQuote } from "./providers/normalize.ts";

test("route queue rotates equal priorities while keeping open positions first", () => {
  const jobs = [
    {mint:'recent',priority:1,reason:'CANDIDATE' as const,lastQuotedAt:200},
    {mint:'old',priority:1,reason:'CANDIDATE' as const,lastQuotedAt:100},
    {mint:'never',priority:1,reason:'CANDIDATE' as const,lastQuotedAt:null},
    {mint:'position',priority:0,reason:'OPEN_POSITION' as const,lastQuotedAt:300},
  ];
  assert.deepEqual(selectRouteJobs(jobs,3).map(j=>j.mint),['position','never','old']);
  assert.equal(jobs[0].mint,'recent');
});

test("cached routes retain their timestamps and cannot cross freshness or future boundaries", () => {
  const q = {...blankQuote('mint','sol','1',120,'no route'),routeState:'NO_ROUTE' as const,eventTime:1000,ingestedAt:1100};
  assert.equal(freshCachedRoute(q,8999,1),q);
  assert.equal(freshCachedRoute(q,9000,1),null);
  assert.equal(freshCachedRoute(q,45999,4),q);
  assert.equal(freshCachedRoute(q,46000,4),null);
  assert.equal(freshCachedRoute({...q,eventTime:2000},1500,1),null);
  assert.equal(freshCachedRoute({...q,ingestedAt:2000},1500,1),null);
  assert.equal(freshCachedRoute({...q,eventTime:NaN},1500,1),null);
  assert.equal(q.ingestedAt,1100);
});

test("slow request expiry also makes its route eligible for refresh", () => {
  const q = {...blankQuote('mint','sol','1',120,'no route'),routeState:'NO_ROUTE' as const,
    ingestedAt:1000,eventTime:9500};
  const now=10000;
  assert.equal(freshCachedRoute(q,now,1),null);
  assert.equal(shouldRefreshRoute({lastQuotedAt:routeObservedAt(q,now),now,priority:1}),true);
});

test("missing and unknown cached route states never manufacture NO_ROUTE", () => {
  const q = {...blankQuote('mint','sol','1',120,'not checked'),ingestedAt:1000,eventTime:1000};
  assert.equal(freshCachedRoute(q,2000,1),null);
  assert.equal(freshCachedRoute({...q,routeState:'UNKNOWN'},2000,1),null);
  assert.equal(freshCachedRoute({...q,routeState:'ERROR',failureReason:'NOT_CHECKED'},2000,1),null);
});

test("refresh filtering excludes fresh candidates before queue priority applies", () => {
  const jobs = [
    {mint:'fresh',priority:1,reason:'CANDIDATE' as const,lastQuotedAt:19000},
    {mint:'new',priority:4,reason:'RESEARCH' as const,lastQuotedAt:null},
    {mint:'stale-position',priority:0,reason:'OPEN_POSITION' as const,lastQuotedAt:1000},
  ];
  const due=jobs.filter(j=>shouldRefreshRoute({...j,now:20000}));
  assert.deepEqual(selectRouteJobs(due,2).map(j=>j.mint),['stale-position','new']);
});
