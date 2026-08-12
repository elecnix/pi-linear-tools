#!/usr/bin/env node

/**
 * Unit tests for the Linear ticket change monitor event-diff logic.
 *
 * These cover the pure functions exported from src/monitor.js:
 *   - diffIssueSnapshot: detects new comments, status changes, label changes,
 *     assignee changes, and priority changes between two issue snapshots.
 *   - summarizeEvent: renders a human-readable notification line for an event.
 *
 * The polling runtime (start/status/check/stop) is intentionally not exercised
 * here; it depends on the pi runtime and live Linear API. The diff logic is the
 * load-bearing part and is fully deterministic.
 */

import assert from 'node:assert/strict';

import {
  diffIssueSnapshot,
  summarizeEvent,
  createIssueSnapshot,
  normalizeWatchedIssue,
  evaluateExpectations,
} from '../src/monitor.js';

function baseIssue(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    identifier: 'ENG-42',
    title: 'Ship the thing',
    url: 'https://linear.app/example/issue/ENG-42/ship-the-thing',
    state: { id: 'state-1', name: 'Backlog', type: 'unstarted' },
    assignee: null,
    priority: 0,
    labels: [],
    comments: [],
    history: [],
    ...overrides,
  };
}

function comment(id, overrides = {}) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    body: `comment ${id}`,
    user: { id: 'user-1', name: 'Alice', displayName: 'Alice' },
    parent: null,
    ...overrides,
  };
}

function historyEntry(id, overrides = {}) {
  return {
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    actor: { id: 'user-1', name: 'Alice', displayName: 'Alice' },
    fromState: null,
    toState: null,
    fromAssignee: null,
    toAssignee: null,
    fromPriority: null,
    toPriority: null,
    addedLabels: [],
    removedLabels: [],
    ...overrides,
  };
}

async function testNoChangesEmitsNothing() {
  const prev = createIssueSnapshot(baseIssue());
  const next = createIssueSnapshot(baseIssue());
  const events = diffIssueSnapshot(prev, next);
  assert.deepEqual(events, []);
  console.log('✓ no changes emits no events');
}

async function testNewCommentEmitsEvent() {
  const prev = createIssueSnapshot(baseIssue());
  const next = createIssueSnapshot(baseIssue({ comments: [comment('c1')] }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'new_comment');
  assert.equal(events[0].comment.id, 'c1');

  const line = summarizeEvent(events[0]);
  assert.match(line, /New comment on ENG-42/);
  assert.match(line, /Alice/);
  console.log('✓ new comment emits new_comment event');
}

async function testNewReplyEmitsEventWithParent() {
  const prev = createIssueSnapshot(baseIssue({ comments: [comment('c1')] }));
  const next = createIssueSnapshot(baseIssue({
    comments: [
      comment('c1'),
      comment('c2', { parent: { id: 'c1' } }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'new_comment');
  assert.equal(events[0].comment.parent.id, 'c1');

  const line = summarizeEvent(events[0]);
  assert.match(line, /replied/);
  console.log('✓ new reply emits new_comment event with parent');
}

async function testStatusChangeEmitsEvent() {
  const prev = createIssueSnapshot(baseIssue({
    state: { id: 'state-1', name: 'Backlog', type: 'unstarted' },
    history: [historyEntry('h1')],
  }));
  const next = createIssueSnapshot(baseIssue({
    state: { id: 'state-2', name: 'In Progress', type: 'started' },
    history: [
      historyEntry('h1'),
      historyEntry('h2', {
        fromState: { id: 'state-1', name: 'Backlog' },
        toState: { id: 'state-2', name: 'In Progress' },
      }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'status_change');
  assert.equal(events[0].fromState.name, 'Backlog');
  assert.equal(events[0].toState.name, 'In Progress');

  const line = summarizeEvent(events[0]);
  assert.match(line, /Backlog → In Progress/);
  console.log('✓ status change emits status_change event');
}

async function testLabelChangeEmitsEvent() {
  const prev = createIssueSnapshot(baseIssue({
    labels: [{ id: 'l1', name: 'bug' }],
    history: [historyEntry('h1')],
  }));
  const next = createIssueSnapshot(baseIssue({
    labels: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'urgent' }],
    history: [
      historyEntry('h1'),
      historyEntry('h2', { addedLabels: [{ id: 'l2', name: 'urgent' }] }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'label_change');
  assert.deepEqual(events[0].addedLabels, [{ id: 'l2', name: 'urgent' }]);
  assert.deepEqual(events[0].removedLabels, []);

  const line = summarizeEvent(events[0]);
  assert.match(line, /\+urgent/);
  console.log('✓ label change emits label_change event');
}

async function testLabelRemovedEmitsEvent() {
  const prev = createIssueSnapshot(baseIssue({
    labels: [{ id: 'l1', name: 'bug' }, { id: 'l2', name: 'urgent' }],
    history: [historyEntry('h1')],
  }));
  const next = createIssueSnapshot(baseIssue({
    labels: [{ id: 'l1', name: 'bug' }],
    history: [
      historyEntry('h1'),
      historyEntry('h2', { removedLabels: [{ id: 'l2', name: 'urgent' }] }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'label_change');
  assert.deepEqual(events[0].addedLabels, []);
  assert.deepEqual(events[0].removedLabels, [{ id: 'l2', name: 'urgent' }]);

  const line = summarizeEvent(events[0]);
  assert.match(line, /-urgent/);
  console.log('✓ label removal emits label_change event');
}

async function testAssigneeChangeEmitsEvent() {
  const prev = createIssueSnapshot(baseIssue({ assignee: null }));
  const next = createIssueSnapshot(baseIssue({
    assignee: { id: 'user-1', name: 'Alice', displayName: 'Alice' },
    history: [
      historyEntry('h1'),
      historyEntry('h2', {
        toAssignee: { id: 'user-1', name: 'Alice', displayName: 'Alice' },
      }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'assignee_change');
  assert.equal(events[0].toAssignee.displayName, 'Alice');

  const line = summarizeEvent(events[0]);
  assert.match(line, /assigned to Alice/);
  console.log('✓ assignee change emits assignee_change event');
}

async function testPriorityChangeEmitsEvent() {
  const prev = createIssueSnapshot(baseIssue({ priority: 0 }));
  const next = createIssueSnapshot(baseIssue({
    priority: 2,
    history: [
      historyEntry('h1'),
      historyEntry('h2', { fromPriority: 0, toPriority: 2 }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'priority_change');
  assert.equal(events[0].fromPriority, 0);
  assert.equal(events[0].toPriority, 2);

  const line = summarizeEvent(events[0]);
  assert.match(line, /priority/i);
  console.log('✓ priority change emits priority_change event');
}

async function testMultipleEventsInOnePoll() {
  const prev = createIssueSnapshot(baseIssue({
    state: { id: 'state-1', name: 'Backlog', type: 'unstarted' },
    comments: [],
    history: [historyEntry('h1')],
  }));
  const next = createIssueSnapshot(baseIssue({
    state: { id: 'state-2', name: 'In Progress', type: 'started' },
    comments: [comment('c1')],
    history: [
      historyEntry('h1'),
      historyEntry('h2', {
        fromState: { id: 'state-1', name: 'Backlog' },
        toState: { id: 'state-2', name: 'In Progress' },
      }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  assert.equal(events.length, 2);
  const types = events.map((e) => e.type).sort();
  assert.deepEqual(types, ['new_comment', 'status_change']);
  console.log('✓ multiple events in one poll all emitted');
}

async function testEventOrderingIsStableByTimestamp() {
  const prev = createIssueSnapshot(baseIssue({ comments: [], history: [historyEntry('h1')] }));
  const next = createIssueSnapshot(baseIssue({
    state: { id: 'state-2', name: 'In Progress', type: 'started' },
    comments: [comment('c1', { createdAt: '2026-01-02T00:00:00.000Z' })],
    history: [
      historyEntry('h1'),
      historyEntry('h2', {
        createdAt: '2026-01-01T00:00:00.000Z',
        fromState: { id: 'state-1', name: 'Backlog' },
        toState: { id: 'state-2', name: 'In Progress' },
      }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  // status change (h2) happened before the comment (c1), so it sorts first
  assert.equal(events[0].type, 'status_change');
  assert.equal(events[1].type, 'new_comment');
  console.log('✓ events ordered by timestamp');
}

async function testClosedIssueEmitsClosedEvent() {
  const prev = createIssueSnapshot(baseIssue({
    state: { id: 'state-1', name: 'In Progress', type: 'started' },
  }));
  const next = createIssueSnapshot(baseIssue({
    state: { id: 'state-3', name: 'Done', type: 'completed' },
    history: [
      historyEntry('h1'),
      historyEntry('h2', {
        fromState: { id: 'state-1', name: 'In Progress' },
        toState: { id: 'state-3', name: 'Done', type: 'completed' },
      }),
    ],
  }));
  const events = diffIssueSnapshot(prev, next);

  // A transition into a completed state is reported as both status_change and
  // a terminal `closed` event so the monitor can auto-stop.
  const types = events.map((e) => e.type);
  assert.ok(types.includes('status_change'));
  assert.ok(types.includes('closed'));
  console.log('✓ transition to completed state emits closed event');
}

async function testFirstSnapshotEmitsNothing() {
  // The very first poll establishes a baseline; nothing is "new" yet.
  const snapshot = createIssueSnapshot(baseIssue({
    comments: [comment('c1')],
    history: [historyEntry('h1')],
  }));
  const events = diffIssueSnapshot(null, snapshot);
  assert.deepEqual(events, []);
  console.log('✓ first snapshot (no previous) emits no events');
}

async function testNormalizeWatchedIssueAcceptsIdentifierAndId() {
  const byIdentifier = normalizeWatchedIssue('ENG-42');
  assert.equal(byIdentifier.ref, 'ENG-42');
  assert.equal(byIdentifier.id, null);

  const byId = normalizeWatchedIssue('11111111-1111-4111-8111-111111111111');
  assert.equal(byId.ref, '11111111-1111-4111-8111-111111111111');
  assert.equal(byId.id, '11111111-1111-4111-8111-111111111111');
  console.log('✓ normalizeWatchedIssue accepts identifier and UUID');
}

async function testExpectedStatusMismatchEmitsConflict() {
  const snapshot = createIssueSnapshot(baseIssue({
    state: { id: 'state-2', name: 'In Progress', type: 'started' },
  }));
  const events = evaluateExpectations(snapshot, { status: 'Backlog' });

  const conflicts = events.filter((e) => e.type === 'status_conflict');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].expectedStatus, 'Backlog');
  assert.equal(conflicts[0].actualStatus, 'In Progress');

  const line = summarizeEvent(conflicts[0]);
  assert.match(line, /Status conflict on ENG-42/);
  assert.match(line, /expected "Backlog"/);
  assert.match(line, /currently "In Progress"/);
  console.log('✓ expected status mismatch emits status_conflict event');
}

async function testExpectedStatusMatchEmitsNoConflict() {
  const snapshot = createIssueSnapshot(baseIssue({
    state: { id: 'state-2', name: 'In Progress', type: 'started' },
  }));
  const events = evaluateExpectations(snapshot, { status: 'In Progress' });
  assert.ok(!events.some((e) => e.type === 'status_conflict'));
  console.log('✓ matching expected status emits no conflict');
}

async function testNoExpectedStatusEmitsCurrentStatus() {
  const snapshot = createIssueSnapshot(baseIssue({
    state: { id: 'state-1', name: 'Backlog', type: 'unstarted' },
  }));
  const events = evaluateExpectations(snapshot, {});

  const current = events.filter((e) => e.type === 'current_status');
  assert.equal(current.length, 1);
  assert.equal(current[0].actualStatus, 'Backlog');

  const line = summarizeEvent(current[0]);
  assert.match(line, /Current status of ENG-42/);
  assert.match(line, /Backlog/);
  console.log('✓ no expected status emits current_status event');
}

async function testExpectedCommentCountMismatchEmitsConflict() {
  const snapshot = createIssueSnapshot(baseIssue({
    comments: [comment('c1'), comment('c2')],
  }));
  const events = evaluateExpectations(snapshot, { comments: 0 });

  const conflicts = events.filter((e) => e.type === 'comment_count_conflict');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].expectedComments, 0);
  assert.equal(conflicts[0].actualComments, 2);

  const line = summarizeEvent(conflicts[0]);
  assert.match(line, /Comment-count conflict on ENG-42/);
  assert.match(line, /expected 0 comment/);
  assert.match(line, /found 2/);
  console.log('✓ expected comment count mismatch emits comment_count_conflict');
}

async function testExpectedCommentCountMatchEmitsNoConflict() {
  const snapshot = createIssueSnapshot(baseIssue({
    comments: [comment('c1'), comment('c2')],
  }));
  const events = evaluateExpectations(snapshot, { comments: 2 });
  assert.ok(!events.some((e) => e.type === 'comment_count_conflict'));
  console.log('✓ matching expected comment count emits no conflict');
}

async function testNoExpectedCommentCountEmitsCurrentCount() {
  const snapshot = createIssueSnapshot(baseIssue({
    comments: [comment('c1')],
  }));
  const events = evaluateExpectations(snapshot, {});

  const current = events.filter((e) => e.type === 'current_comment_count');
  assert.equal(current.length, 1);
  assert.equal(current[0].actualComments, 1);

  const line = summarizeEvent(current[0]);
  assert.match(line, /has 1 comment/);
  console.log('✓ no expected comment count emits current_comment_count');
}

async function testExpectationsOnEmptySnapshotEmitNothing() {
  const events = evaluateExpectations(null, { status: 'Backlog', comments: 2 });
  assert.deepEqual(events, []);
  console.log('✓ expectations on null snapshot emit nothing');
}

// ===== RUNTIME TESTS (TicketMonitor start/status/check/stop) =====

import { TicketMonitor, resetSharedMonitor } from '../src/monitor.js';

function mockRawIssue(overrides = {}) {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    identifier: 'ENG-42',
    title: 'Ship the thing',
    url: 'https://linear.app/example/issue/ENG-42/ship-the-thing',
    priority: 0,
    state: { id: 'state-1', name: 'Backlog', type: 'unstarted' },
    assignee: null,
    labels: { nodes: [] },
    comments: { nodes: [] },
    history: { nodes: [] },
    ...overrides,
  };
}

function createMockMonitorClient(issueResponses) {
  // issueResponses: array of raw issue payloads returned in successive polls.
  let call = 0;
  return {
    client: {
      rawRequest: async (_query, _vars) => {
        const payload = issueResponses[Math.min(call, issueResponses.length - 1)];
        call += 1;
        return {
          data: { issues: { nodes: [payload] } },
          headers: new Headers(),
        };
      },
    },
  };
}

async function testMonitorStartEstablishesBaselineAndStatus() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const client = createMockMonitorClient([mockRawIssue()]);

  const { started, alreadyWatched } = await monitor.start({
    issues: 'ENG-42',
    interval: 30,
    notify: () => {},
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  assert.deepEqual(started, ['ENG-42']);
  assert.deepEqual(alreadyWatched, []);

  const status = monitor.status();
  assert.equal(status.length, 1);
  assert.equal(status[0].ref, 'ENG-42');
  assert.equal(status[0].hasBaseline, true);

  monitor.stopAll();
  console.log('✓ monitor start establishes baseline and status reports it');
}

async function testMonitorCheckEmitsNewComment() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const notifications = [];
  const client = createMockMonitorClient([
    mockRawIssue(), // baseline poll
    mockRawIssue({
      comments: {
        nodes: [comment('c1', { createdAt: '2026-01-02T00:00:00.000Z' })],
      },
    }),
  ]);

  await monitor.start({
    issues: 'ENG-42',
    interval: 30,
    notify: (line) => notifications.push(line),
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  await monitor.check();
  assert.ok(notifications.some((n) => /New comment on ENG-42/.test(n)), `got: ${notifications.join(' | ')}`);
  monitor.stopAll();
  console.log('✓ monitor check emits new_comment notification');
}

async function testMonitorAutoStopsOnClosed() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const notifications = [];
  const client = createMockMonitorClient([
    mockRawIssue({
      state: { id: 'state-1', name: 'In Progress', type: 'started' },
    }),
    mockRawIssue({
      state: { id: 'state-3', name: 'Done', type: 'completed' },
      history: {
        nodes: [historyEntry('h2', {
          createdAt: '2026-01-02T00:00:00.000Z',
          fromState: { id: 'state-1', name: 'In Progress' },
          toState: { id: 'state-3', name: 'Done', type: 'completed' },
        })],
      },
    }),
  ]);

  await monitor.start({
    issues: 'ENG-42',
    interval: 30,
    notify: (line) => notifications.push(line),
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  await monitor.check();
  // status_change + closed both emitted
  assert.ok(notifications.some((n) => /In Progress → Done/.test(n)));
  assert.ok(notifications.some((n) => /closed/.test(n)));
  assert.equal(monitor.status().length, 0, 'issue should be removed after close');
  console.log('✓ monitor auto-stops on closed issue');
}

async function testMonitorStartEmitsStatusConflictImmediately() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const notifications = [];
  const client = createMockMonitorClient([
    mockRawIssue({ state: { id: 'state-2', name: 'In Progress', type: 'started' } }), // baseline poll
  ]);

  await monitor.start({
    issues: 'ENG-42',
    interval: 30,
    status: 'Backlog',
    notify: (line) => notifications.push(line),
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  // The conflict event fires immediately during the baseline poll in start().
  assert.ok(notifications.some((n) => /Status conflict on ENG-42/.test(n)), `got: ${notifications.join(' | ')}`);
  monitor.stopAll();
  console.log('✓ monitor start emits status conflict immediately when expected status differs');
}

async function testMonitorStartNoExpectationEmitsCurrentStatus() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const notifications = [];
  const client = createMockMonitorClient([
    mockRawIssue({ state: { id: 'state-1', name: 'Backlog', type: 'unstarted' } }),
  ]);

  await monitor.start({
    issues: 'ENG-42',
    interval: 30,
    notify: (line) => notifications.push(line),
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  // With no expectations, both current status and current comment count are
  // reported immediately on the baseline poll.
  assert.ok(notifications.some((n) => /Current status of ENG-42/.test(n)), `got: ${notifications.join(' | ')}`);
  assert.ok(notifications.some((n) => /has 0 comment/.test(n)), `got: ${notifications.join(' | ')}`);
  monitor.stopAll();
  console.log('✓ monitor start with no expectation emits current status and comment count');
}

async function testMonitorCommentCountIsNotTruncatedAtDiffLimit() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const notifications = [];
  // More comments than the 25-node diff page; the informational count must
  // reflect the full number, not the diff-page truncation.
  const manyComments = Array.from({ length: 60 }, (_, i) => comment(`c${i + 1}`));
  const client = createMockMonitorClient([
    mockRawIssue({ comments: { nodes: manyComments } }),
  ]);

  await monitor.start({
    issues: 'ENG-42',
    interval: 30,
    notify: (line) => notifications.push(line),
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  assert.ok(notifications.some((n) => /has 60 comment/.test(n)), `got: ${notifications.join(' | ')}`);
  monitor.stopAll();
  console.log('✓ informational comment count is not truncated at the diff page limit');
}

async function testMonitorCommentExpectationKeepsDiffingNewComments() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const notifications = [];
  const client = createMockMonitorClient([
    mockRawIssue({ comments: { nodes: [comment('c1')] } }), // baseline: 1 comment, matches expectation
    mockRawIssue({ comments: { nodes: [comment('c1'), comment('c2')] } }), // a new comment arrives
  ]);

  await monitor.start({
    issues: 'ENG-42',
    interval: 30,
    comments: 1,
    notify: (line) => notifications.push(line),
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  // Baseline matches expectation: no comment-count conflict fired.
  assert.ok(!notifications.some((n) => /Comment-count conflict/.test(n)), `got: ${notifications.join(' | ')}`);

  await monitor.check();
  // A comment arriving after start is still surfaced by the regular diff.
  assert.ok(notifications.some((n) => /New comment on ENG-42/.test(n)), `got: ${notifications.join(' | ')}`);
  monitor.stopAll();
  console.log('✓ comment expectation does not suppress subsequent new_comment diffing');
}

async function testMonitorStopRemovesIssue() {
  resetSharedMonitor();
  const monitor = new TicketMonitor();
  const client = createMockMonitorClient([mockRawIssue()]);

  await monitor.start({
    issues: ['ENG-42'],
    interval: 30,
    notify: () => {},
    clientFactory: async () => client,
    resolveIssue: async () => ({ id: '11111111-1111-4111-8111-111111111111' }),
  });

  const { stopped } = monitor.stop('ENG-42');
  assert.deepEqual(stopped, ['ENG-42']);
  assert.equal(monitor.status().length, 0);
  console.log('✓ monitor stop removes issue');
}

async function main() {
  await testNoChangesEmitsNothing();
  await testNewCommentEmitsEvent();
  await testNewReplyEmitsEventWithParent();
  await testStatusChangeEmitsEvent();
  await testLabelChangeEmitsEvent();
  await testLabelRemovedEmitsEvent();
  await testAssigneeChangeEmitsEvent();
  await testPriorityChangeEmitsEvent();
  await testMultipleEventsInOnePoll();
  await testEventOrderingIsStableByTimestamp();
  await testClosedIssueEmitsClosedEvent();
  await testFirstSnapshotEmitsNothing();
  await testNormalizeWatchedIssueAcceptsIdentifierAndId();
  await testExpectedStatusMismatchEmitsConflict();
  await testExpectedStatusMatchEmitsNoConflict();
  await testNoExpectedStatusEmitsCurrentStatus();
  await testExpectedCommentCountMismatchEmitsConflict();
  await testExpectedCommentCountMatchEmitsNoConflict();
  await testNoExpectedCommentCountEmitsCurrentCount();
  await testExpectationsOnEmptySnapshotEmitNothing();

  await testMonitorStartEstablishesBaselineAndStatus();
  await testMonitorCheckEmitsNewComment();
  await testMonitorAutoStopsOnClosed();
  await testMonitorStartEmitsStatusConflictImmediately();
  await testMonitorStartNoExpectationEmitsCurrentStatus();
  await testMonitorCommentCountIsNotTruncatedAtDiffLimit();
  await testMonitorCommentExpectationKeepsDiffingNewComments();
  await testMonitorStopRemovesIssue();
  console.log('✓ tests/test-ticket-monitor.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});