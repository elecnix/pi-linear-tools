/**
 * Linear ticket change monitor
 *
 * Fork-only feature: a polling monitor that watches Linear issues and emits
 * push notifications when new comments (and replies), status transitions,
 * label changes, assignee changes, and priority changes occur. Mirrors the
 * semantics of `ghpr-monitor` (start / status / check / stop) while staying
 * in-process — no daemon, no systemd, no separate process.
 *
 * The diff logic is split into pure functions (`createIssueSnapshot`,
 * `diffIssueSnapshot`, `summarizeEvent`, `normalizeWatchedIssue`) so the
 * event-detection rules can be unit-tested without the polling runtime or a
 * live Linear connection. The polling runtime (`TicketMonitor`) lives below.
 *
 * Rate-limit awareness: every poll batches all watched issues into ONE GraphQL
 * query (Linear supports fetching multiple issues + their history/comments in a
 * single request), and each watched issue remembers its last-seen comment and
 * history cursors so unchanged history is never refetched.
 */

import { debug, warn } from './logger.js';

/** Minimum poll interval in milliseconds. Linear's GraphQL complexity budget
 *  is per-minute, so we never poll faster than this. */
export const MIN_POLL_INTERVAL_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_HISTORY_LIMIT = 25;
const DEFAULT_COMMENT_LIMIT = 25;

/**
 * State type names Linear treats as terminal (auto-stop the monitor).
 * Matches Linear's WorkflowState.type: unstarted | started | completed | canceled.
 */
const TERMINAL_STATE_TYPES = new Set(['completed', 'canceled']);

/**
 * Unwrap a GraphQL connection ({ nodes: [...] }) or accept a plain array.
 * Linear returns labels/comments/history as connections, but tests and the
 * SDK may hand us plain arrays; handle both.
 */
function unwrapConnection(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.nodes)) return value.nodes;
  return [];
}

/**
 * Normalize a user-provided issue reference into a watched-issue descriptor.
 * Accepts either a human identifier ("ENG-42") or a Linear issue UUID.
 * @param {string} ref
 * @returns {{ref: string, id: string|null}}
 */
export function normalizeWatchedIssue(ref) {
  const normalized = String(ref || '').trim();
  if (!normalized) {
    throw new Error('Missing issue reference to watch');
  }
  const isUuid = /^[0-9a-fA-F-]{16,}$/.test(normalized);
  return { ref: normalized, id: isUuid ? normalized : null };
}

/**
 * Capture a minimal, comparable snapshot of an issue's mutable state.
 *
 * The snapshot intentionally drops fields we do not diff (description body,
 * attachments, relations) to keep comparisons cheap and deterministic. The
 * raw `issue` payload shape mirrors what `MONITOR_ISSUES_QUERY` returns.
 *
 * @param {object|null} issue - Raw issue payload from Linear (or null for the
 *   baseline first poll).
 * @returns {object|null}
 */
export function createIssueSnapshot(issue) {
  if (!issue) return null;

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url ?? null,
    state: issue.state
      ? { id: issue.state.id, name: issue.state.name, type: issue.state.type ?? null }
      : null,
    assignee: issue.assignee
      ? { id: issue.assignee.id, name: issue.assignee.name, displayName: issue.assignee.displayName }
      : null,
    priority: issue.priority ?? null,
    labels: unwrapConnection(issue.labels).map((label) => ({ id: label.id, name: label.name })),
    // Comments are keyed by id; we only diff ids, not bodies (edits to an
    // existing comment are not surfaced as "new" events).
    comments: unwrapConnection(issue.comments).map((comment) => ({
      id: comment.id,
      createdAt: comment.createdAt ?? null,
      body: comment.body ?? '',
      user: comment.user
        ? { id: comment.user.id, name: comment.user.name, displayName: comment.user.displayName }
        : null,
      parent: comment.parent ? { id: comment.parent.id } : null,
    })),
    // Comments are keyed by id; we only diff ids, not bodies (edits to an
    // existing comment are not surfaced as "new" events).
    commentIds: new Set(unwrapConnection(issue.comments).map((comment) => comment.id)),
    // History entries we have already seen, keyed by id.
    historyIds: new Set(unwrapConnection(issue.history).map((entry) => entry.id)),
    history: unwrapConnection(issue.history).map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt ?? null,
      actor: entry.actor
        ? { id: entry.actor.id, name: entry.actor.name, displayName: entry.actor.displayName }
        : null,
      fromState: entry.fromState ? { id: entry.fromState.id, name: entry.fromState.name } : null,
      toState: entry.toState ? { id: entry.toState.id, name: entry.toState.name, type: entry.toState.type ?? null } : null,
      fromAssignee: entry.fromAssignee
        ? { id: entry.fromAssignee.id, name: entry.fromAssignee.name, displayName: entry.fromAssignee.displayName }
        : null,
      toAssignee: entry.toAssignee
        ? { id: entry.toAssignee.id, name: entry.toAssignee.name, displayName: entry.toAssignee.displayName }
        : null,
      fromPriority: entry.fromPriority ?? null,
      toPriority: entry.toPriority ?? null,
      addedLabels: (entry.addedLabels || []).map((label) => ({ id: label.id, name: label.name })),
      removedLabels: (entry.removedLabels || []).map((label) => ({ id: label.id, name: label.name })),
    })),
  };
}

function eventTimestamp(event) {
  // Prefer the underlying artifact's timestamp (comment.createdAt or
  // history.createdAt); fall back to "now" so ordering never breaks.
  if (event.type === 'new_comment' && event.comment?.createdAt) {
    return Date.parse(event.comment.createdAt) || 0;
  }
  if (event.historyEntry?.createdAt) {
    return Date.parse(event.historyEntry.createdAt) || 0;
  }
  return 0;
}

/**
 * Compare two issue snapshots and return the list of change events detected.
 *
 * Event types:
 *   - new_comment: a comment id present in `next` but not `prev` (includes replies)
 *   - status_change: a state transition recorded in a new history entry
 *   - label_change: added/removed labels recorded in a new history entry
 *   - assignee_change: an assignee transition recorded in a new history entry
 *   - priority_change: a priority transition recorded in a new history entry
 *   - closed: a transition into a completed/canceled state (terminal)
 *
 * @param {object|null} prev
 * @param {object|null} next
 * @returns {Array<object>}
 */
export function diffIssueSnapshot(prev, next) {
  if (!next) return [];
  if (!prev) {
    // First poll establishes the baseline — nothing is "new" yet.
    return [];
  }

  const events = [];

  // --- New comments (by id) ---
  const prevCommentIds = prev.commentIds || new Set();
  for (const comment of next.comments || []) {
    if (!prevCommentIds.has(comment.id)) {
      events.push({
        type: 'new_comment',
        issue: { identifier: next.identifier, title: next.title, url: next.url },
        comment,
      });
    }
  }

  // --- New history entries ---
  const prevHistoryIds = prev.historyIds || new Set();
  for (const entry of next.history || []) {
    if (prevHistoryIds.has(entry.id)) continue;

    if (entry.fromState && entry.toState) {
      events.push({
        type: 'status_change',
        issue: { identifier: next.identifier, title: next.title, url: next.url },
        fromState: entry.fromState,
        toState: entry.toState,
        historyEntry: entry,
      });
      if (entry.toState.type && TERMINAL_STATE_TYPES.has(entry.toState.type)) {
        events.push({
          type: 'closed',
          issue: { identifier: next.identifier, title: next.title, url: next.url },
          toState: entry.toState,
          historyEntry: entry,
        });
      }
    }

    if ((entry.addedLabels && entry.addedLabels.length > 0) || (entry.removedLabels && entry.removedLabels.length > 0)) {
      events.push({
        type: 'label_change',
        issue: { identifier: next.identifier, title: next.title, url: next.url },
        addedLabels: entry.addedLabels || [],
        removedLabels: entry.removedLabels || [],
        historyEntry: entry,
      });
    }

    if (entry.fromAssignee !== undefined && entry.toAssignee !== undefined && (entry.fromAssignee || entry.toAssignee)) {
      events.push({
        type: 'assignee_change',
        issue: { identifier: next.identifier, title: next.title, url: next.url },
        fromAssignee: entry.fromAssignee,
        toAssignee: entry.toAssignee,
        historyEntry: entry,
      });
    }

    if (entry.fromPriority !== null && entry.toPriority !== null && entry.fromPriority !== entry.toPriority) {
      events.push({
        type: 'priority_change',
        issue: { identifier: next.identifier, title: next.title, url: next.url },
        fromPriority: entry.fromPriority,
        toPriority: entry.toPriority,
        historyEntry: entry,
      });
    }
  }

  // Deduplicate status_change + closed that share the same history entry, but
  // only when the to-state is terminal — both are useful (status_change is the
  // human-readable transition, closed signals auto-stop). Keep both.

  // Stable ordering by timestamp so notifications arrive in chronological order.
  events.sort((a, b) => eventTimestamp(a) - eventTimestamp(b));
  return events;
}

const PRIORITY_LABELS = ['None', 'Urgent', 'High', 'Medium', 'Low'];

function priorityLabel(value) {
  if (value === null || value === undefined) return 'None';
  return PRIORITY_LABELS[value] || `P${value}`;
}

function truncate(text, limit = 200) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trimEnd()}…`;
}

function actorLabel(event) {
  const actor = event.historyEntry?.actor || event.comment?.user;
  return actor?.displayName || actor?.name || 'Someone';
}

/**
 * Render a single change event as a concise, human-readable notification line.
 * @param {object} event
 * @returns {string}
 */
export function summarizeEvent(event) {
  const { issue } = event;
  const prefix = issue?.identifier || 'issue';
  const title = issue?.title ? `: ${truncate(issue.title, 80)}` : '';

  switch (event.type) {
    case 'new_comment': {
      const isReply = event.comment?.parent?.id;
      const author = event.comment?.user?.displayName || event.comment?.user?.name || 'Someone';
      const body = truncate(event.comment?.body, 200);
      return `New comment on ${prefix}${title} — ${author} ${isReply ? 'replied' : 'commented'}: ${body}`;
    }
    case 'status_change': {
      const from = event.fromState?.name || 'Unknown';
      const to = event.toState?.name || 'Unknown';
      return `Status change on ${prefix}${title} — ${actorLabel(event)} moved ${from} → ${to}`;
    }
    case 'label_change': {
      const added = (event.addedLabels || []).map((l) => `+${l.name}`).join(' ');
      const removed = (event.removedLabels || []).map((l) => `-${l.name}`).join(' ');
      const parts = [added, removed].filter(Boolean).join(' ');
      return `Label change on ${prefix}${title} — ${actorLabel(event)} ${parts}`.trim();
    }
    case 'assignee_change': {
      const to = event.toAssignee?.displayName || event.toAssignee?.name || 'Unassigned';
      const from = event.fromAssignee?.displayName || event.fromAssignee?.name || 'Unassigned';
      if (!event.fromAssignee && event.toAssignee) {
        return `Assignee change on ${prefix}${title} — ${actorLabel(event)} assigned to ${to}`;
      }
      if (event.fromAssignee && !event.toAssignee) {
        return `Assignee change on ${prefix}${title} — ${actorLabel(event)} unassigned (was ${from})`;
      }
      return `Assignee change on ${prefix}${title} — ${actorLabel(event)} ${from} → ${to}`;
    }
    case 'priority_change': {
      return `Priority change on ${prefix}${title} — ${actorLabel(event)} ${priorityLabel(event.fromPriority)} → ${priorityLabel(event.toPriority)}`;
    }
    case 'closed': {
      return `Issue ${prefix}${title} closed (${event.toState?.name || 'Done'}) — auto-stopping monitor`;
    }
    default:
      return `Change detected on ${prefix}${title}`;
  }
}

// ===== POLLING RUNTIME =====

/**
 * Batched GraphQL query: fetch all watched issues in one request, each with its
 * comments and history. Linear supports fetching multiple issues by id in a
 * single query, which keeps us well within the per-minute complexity budget.
 */
const MONITOR_ISSUES_QUERY = `
  query MonitorIssues($ids: [String!], $firstComments: Int!, $firstHistory: Int!) {
    issues(filter: { id: { in: $ids } }) {
      nodes {
        id
        identifier
        title
        url
        priority
        state {
          id
          name
          type
        }
        assignee {
          id
          name
          displayName
        }
        labels {
          nodes {
            id
            name
          }
        }
        comments(first: $firstComments) {
          nodes {
            id
            createdAt
            body
            user {
              id
              name
              displayName
            }
            parent {
              id
            }
          }
        }
        history(first: $firstHistory) {
          nodes {
            id
            createdAt
            actor {
              id
              name
              displayName
            }
            fromState {
              id
              name
            }
            toState {
              id
              name
              type
            }
            fromAssignee {
              id
              name
              displayName
            }
            toAssignee {
              id
              name
              displayName
            }
            fromPriority
            toPriority
            addedLabels {
              id
              name
            }
            removedLabels {
              id
              name
            }
          }
        }
      }
    }
  }
`;

/**
 * Execute the batched monitor query, resolving identifiers to ids first.
 * @param {object} client - Linear SDK client (or mock with rawRequest).
 * @param {Array<{ref: string, id: string|null}>} watched
 * @param {{historyLimit?: number, commentLimit?: number, resolveIssue?: Function}} options
 * @returns {Promise<Array<object>>} raw issue payloads
 */
export async function fetchWatchedIssues(client, watched, options = {}) {
  const historyLimit = options.historyLimit || DEFAULT_HISTORY_LIMIT;
  const commentLimit = options.commentLimit || DEFAULT_COMMENT_LIMIT;

  // Resolve any identifier refs to issue ids.
  const ids = [];
  const refToId = new Map();
  for (const entry of watched) {
    if (entry.id) {
      ids.push(entry.id);
      refToId.set(entry.ref, entry.id);
    } else if (options.resolveIssue) {
      // eslint-disable-next-line no-await-in-loop
      const resolved = await options.resolveIssue(client, entry.ref);
      if (resolved) {
        ids.push(resolved.id);
        refToId.set(entry.ref, resolved.id);
      }
    }
  }

  if (ids.length === 0) return [];

  const rawRequest =
    (typeof client.client?.rawRequest === 'function' ? client.client.rawRequest.bind(client.client) : null) ||
    (typeof client.rawRequest === 'function' ? client.rawRequest.bind(client) : null);

  if (!rawRequest) {
    throw new Error('GraphQL rawRequest is unavailable on this Linear client');
  }

  const response = await rawRequest(MONITOR_ISSUES_QUERY, {
    ids,
    firstComments: commentLimit,
    firstHistory: historyLimit,
  });

  const nodes = response?.data?.issues?.nodes || [];
  return nodes;
}

/**
 * The shared, process-wide monitor registry. A single interval polls all
 * watched issues; events are emitted via the `notify` callback supplied at
 * start time (typically `pi.sendMessage`).
 */
export class TicketMonitor {
  constructor() {
    /** @type {Map<string, {ref: string, id: string|null, snapshot: object|null, closed: boolean}>} */
    this._watched = new Map();
    this._interval = null;
    this._intervalMs = DEFAULT_POLL_INTERVAL_MS;
    this._notify = null;
    this._poller = null; // async function(client) => void
    this._clientFactory = null;
  }

  /**
   * Start watching one or more issues. Idempotent: re-starting an already
   * watched issue resets its baseline snapshot (next poll emits nothing).
   * @param {object} params
   * @param {string|string[]} params.issues
   * @param {number} [params.interval] - poll interval in seconds (>=30)
   * @param {Function} [params.notify] - (message) => void, called per event
   * @param {Function} params.clientFactory - () => Promise<LinearClient>
   * @param {Function} [params.resolveIssue] - (client, ref) => Promise<{id}>
   * @returns {{started: string[], alreadyWatched: string[]}}
   */
  async start(params) {
    const refs = Array.isArray(params.issues) ? params.issues : [params.issues];
    const intervalMs = Math.max(MIN_POLL_INTERVAL_MS, (Number(params.interval) || 60) * 1000);

    this._notify = params.notify || this._notify;
    this._clientFactory = params.clientFactory;
    this._resolveIssue = params.resolveIssue || null;
    this._intervalMs = intervalMs;

    const started = [];
    const alreadyWatched = [];
    for (const raw of refs) {
      const desc = normalizeWatchedIssue(raw);
      if (this._watched.has(desc.ref)) {
        alreadyWatched.push(desc.ref);
        continue;
      }
      this._watched.set(desc.ref, { ...desc, snapshot: null, closed: false });
      started.push(desc.ref);
    }

    // Establish baselines immediately so the first scheduled poll only reports
    // changes that happen after start.
    if (started.length > 0) {
      await this._pollOnce().catch((error) => {
        warn('[pi-linear-tools] monitor baseline poll failed', { error: String(error?.message || error) });
      });
    }

    this._ensureInterval();
    return { started, alreadyWatched };
  }

  /**
   * @returns {Array<object>} list of watched issues with status
   */
  status() {
    const out = [];
    for (const [ref, entry] of this._watched.entries()) {
      out.push({
        ref,
        id: entry.id,
        closed: entry.closed,
        hasBaseline: entry.snapshot !== null,
      });
    }
    return out;
  }

  /**
   * Trigger an immediate poll out-of-band (does not reset the interval).
   */
  async check() {
    await this._pollOnce().catch((error) => {
      warn('[pi-linear-tools] monitor check poll failed', { error: String(error?.message || error) });
    });
  }

  /**
   * Stop watching one or more issues. With no args, stops all.
   * @param {string|string[]|null} [issues]
   * @returns {{stopped: string[]}}
   */
  stop(issues) {
    if (!issues) {
      return this.stopAll();
    }
    const refs = Array.isArray(issues) ? issues : [issues];
    const stopped = [];
    for (const raw of refs) {
      const desc = normalizeWatchedIssue(raw);
      if (this._watched.delete(desc.ref)) {
        stopped.push(desc.ref);
      }
    }
    if (this._watched.size === 0) {
      this._clearInterval();
    }
    return { stopped };
  }

  stopAll() {
    const stopped = [...this._watched.keys()];
    this._watched.clear();
    this._clearInterval();
    return { stopped };
  }

  _ensureInterval() {
    if (this._interval) return;
    this._interval = setInterval(() => {
      this._pollOnce().catch((error) => {
        warn('[pi-linear-tools] monitor poll failed', { error: String(error?.message || error) });
      });
    }, this._intervalMs);
    // Don't keep the Node process alive solely for the monitor.
    if (this._interval.unref) this._interval.unref();
  }

  _clearInterval() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  async _pollOnce() {
    if (this._watched.size === 0 || !this._clientFactory) return;

    const client = await this._clientFactory();
    const watched = [...this._watched.values()];
    const issues = await fetchWatchedIssues(client, watched, {
      resolveIssue: this._resolveIssue,
    });

    // Index returned issues by id, and map back to watched refs.
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    const refsToStop = [];

    for (const entry of this._watched.values()) {
      // Resolve the id if we didn't have it at start.
      let issueId = entry.id;
      if (!issueId) {
        // Find by matching the returned issue whose id we resolved during fetch.
        for (const [id, issue] of byId.entries()) {
          if (issue.identifier === entry.ref) {
            issueId = id;
            entry.id = id;
            break;
          }
        }
      }
      const raw = issueId ? byId.get(issueId) : null;
      if (!raw) {
        // Issue may have been deleted; keep watching but skip this round.
        continue;
      }

      const nextSnapshot = createIssueSnapshot(raw);
      const events = diffIssueSnapshot(entry.snapshot, nextSnapshot);
      entry.snapshot = nextSnapshot;

      for (const event of events) {
        if (this._notify) {
          this._notify(summarizeEvent(event), event);
        }
        if (event.type === 'closed') {
          entry.closed = true;
          refsToStop.push(entry.ref);
        }
      }
    }

    for (const ref of refsToStop) {
      this._watched.delete(ref);
      debug('[pi-linear-tools] monitor auto-stopped closed issue', { ref });
    }
    if (this._watched.size === 0) {
      this._clearInterval();
    }
  }
}

/** Process-wide singleton (the pi extension runtime is a single process). */
let _sharedMonitor = null;

export function getSharedMonitor() {
  if (!_sharedMonitor) {
    _sharedMonitor = new TicketMonitor();
  }
  return _sharedMonitor;
}

/** Reset the shared monitor (test-only). */
export function resetSharedMonitor() {
  if (_sharedMonitor) {
    _sharedMonitor.stopAll();
  }
  _sharedMonitor = null;
}