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
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /New comment on ENG-42/);
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

  await testMonitorStartEstablishesBaselineAndStatus();
  await testMonitorCheckEmitsNewComment();
  await testMonitorAutoStopsOnClosed();
  await testMonitorStopRemovesIssue();
  console.log('✓ tests/test-ticket-monitor.js passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});